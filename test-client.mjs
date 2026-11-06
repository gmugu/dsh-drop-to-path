// Offline behavioural checks for the browser half (run with: node test-client.mjs).
//
// The client module is a browser bundle, so this harness stubs the few globals
// it touches and drives the REAL module: it loads lib/client.js through a fake
// `window.__ModuleLoader__`, applies the plugin to a fake cordis ctx, and then
// exercises the installed sendSession wrapper and the upload rescue.
//
// What this pins down for the DSH 0.2.2 adaptation:
//   1. the wrapper forwards the new 6th `accept` argument to the native send;
//   2. a text-only model still converts image drafts into @-path text while
//      the attachment ids are dropped from the forwarded call;
//   3. the workspace hint comes from `sessions.list.byId[id].cwd` (0.2.2 has
//      no `current` field and `retainInfo()` carries no cwd);
//   4. a rejected draft upload is rescued into a path chip and removed through
//      the composer's own input actions captured by the hidden dock entry.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` (${detail})`}`)
}

// ---- browser stubs ---------------------------------------------------------

const fetchCalls = []
const fakeElement = () => ({
  style: { cssText: '' },
  dataset: {},
  title: '',
  textContent: '',
  parentNode: null,
  append() {},
  appendChild() {},
  remove() {},
  removeChild() {},
  setAttribute() {},
  insertBefore() {},
  getAttribute() { return null },
  addEventListener() {},
  contains() { return false },
})

const documentStub = {
  addEventListener() {},
  removeEventListener() {},
  querySelector() { return null },
  querySelectorAll() { return [] },
  createElement: fakeElement,
  documentElement: { appendChild() {} },
  body: { append() {} },
  visibilityState: 'visible',
}

const factories = new Map()
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  URL,
  btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  atob: (value) => Buffer.from(value, 'base64').toString('binary'),
  Date,
  Math,
  JSON,
  Promise,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Error,
  RegExp,
  DataTransfer: class { constructor() { this.items = { add() {} } } },
  DragEvent: class { constructor(type) { this.type = type } },
  MutationObserver: class { observe() {} disconnect() {} },
  navigator: { clipboard: undefined },
  document: documentStub,
  fetch: async (url, init) => {
    fetchCalls.push({ url: String(url), init })
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: {} }),
    }
  },
  setInterval: () => ({ fake: true }),
  clearInterval: () => {},
}
sandbox.window = {
  __ModuleLoader__: { load: (entry) => factories.set(entry.id, entry.factory) },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  innerWidth: 1280,
  innerHeight: 800,
}
sandbox.globalThis = sandbox

const URLStub = class extends URL {}
URLStub.createObjectURL = () => 'blob:rescued'
sandbox.URL = URLStub

const context = vm.createContext(sandbox)
vm.runInContext(readFileSync(join(here, 'lib', 'client.js'), 'utf8'), context, { filename: 'lib/client.js' })

const factory = factories.get('dsh-drop-to-path')
check('module registered itself with __ModuleLoader__', typeof factory === 'function')
const clientExports = factory(() => ({}))
check('module exposes apply()', typeof clientExports.apply === 'function')

// ---- fake services ---------------------------------------------------------

const sendCalls = []
class NativeConversation {
  constructor(uploads) {
    this.fileUploads = uploads
    this.released = []
  }
  async sendSession(session, text, attachmentIds, mode, signal, accept) {
    sendCalls.push({ text, attachmentIds: [...attachmentIds], mode, accepted: typeof accept === 'function' })
    if (typeof accept === 'function') accept()
    return { kind: 'success' }
  }
  resolveDraftAttachments(ids) {
    return ids.map((id) => imageDrafts[id]).filter(Boolean)
  }
  releaseDraftAttachment(id) {
    this.released.push(id)
  }
  releaseDraftAttachments(list) {
    for (const item of list) this.released.push(item.id)
  }
}

const imageDrafts = {}
const makeImageDraft = (id, name) => {
  imageDrafts[id] = {
    id,
    kind: 'image',
    file: { name, type: 'image/png', size: 4, async arrayBuffer() { return new Uint8Array([1, 2, 3, 4]).buffer } },
    previewUrl: 'blob:stub',
  }
}

const makeUploadStore = () => {
  let snapshot = {}
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    push: (next) => {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

const uploadStore = makeUploadStore()
const conversation = new NativeConversation(uploadStore)
const originalSend = NativeConversation.prototype.sendSession

const sessions = {
  list: {
    getSnapshot: () => ({
      ids: ['session-1'],
      byId: { 'session-1': { id: 'session-1', cwd: 'C:\\ws\\demo' } },
      phase: 'ready',
      projectionsBySession: {},
    }),
  },
  retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 1, retainedBy: {} }) }),
}

const slotRegistrations = []
const slots = {
  inject: (_key, callback) => {
    const dispose = callback()
    return dispose
  },
  register: (options, component) => {
    slotRegistrations.push({ options, component })
    return () => {}
  },
}

const modelCatalog = { ok: true, value: { default: { provider: 'stub', model: 'text-only' } } }
const remote = { session: { modelCatalog: async () => modelCatalog } }

// Modality probe answers "text-only"; the import route answers a path.
sandbox.fetch = async (url, init) => {
  const text = String(url)
  fetchCalls.push({ url: text, init })
  if (text.includes('modalities=1')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { image: false } }) }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, value: { path: 'C:\\ws\\demo\\.drops\\1-shot.png' } }) }
}

const disposers = []
const ctx = {
  get: (name) => ({ conversation, sessions, slots, remote, 'remote.session': undefined }[name]),
  effect: (callback) => {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
}

clientExports.apply(ctx)

check('sendSession wrapper installed on the prototype', NativeConversation.prototype.sendSession !== originalSend)
check('hidden dock entry registered (2-arg register)', slotRegistrations.length === 1 && typeof slotRegistrations[0].component === 'function', `count=${slotRegistrations.length}`)

// Simulate the composer mounting the dock entry: capture sessionId + inputActions.
const removed = []
slotRegistrations[0].component({
  sessionId: 'session-1',
  inputActions: { removeAttachment: (id) => removed.push(id) },
})

const sessionFace = { sessionId: 'session-1' }

// ---- 1. plain text keeps the native path and forwards `accept` -------------
{
  sendCalls.length = 0
  const accepted = []
  const outcome = await conversation.sendSession(sessionFace, 'hello', [], 'queue', undefined, () => accepted.push(1))
  check('plain text send succeeds', outcome?.kind === 'success')
  check('native send received the text', sendCalls[0]?.text === 'hello', sendCalls[0]?.text)
  check('6th `accept` argument is forwarded to the native send', sendCalls[0]?.accepted === true)
}

// ---- 2. text-only model converts an image draft into an @path ---------------
{
  makeImageDraft('img-1', 'shot.png')
  sendCalls.length = 0
  fetchCalls.length = 0
  const accepted = []
  const outcome = await conversation.sendSession(sessionFace, 'what is this?', ['img-1'], 'queue', undefined, () => accepted.push(1))
  const upload = fetchCalls.find((call) => call.init && call.init.method === 'POST')
  const body = upload === undefined ? {} : JSON.parse(upload.init.body)
  check('converted send succeeds', outcome?.kind === 'success')
  check('image bytes are uploaded to the import route', body.name === 'shot.png' && typeof body.dataBase64 === 'string')
  check('workspace hint comes from sessions.list.byId[id].cwd', body.workspace === 'C:\\ws\\demo', body.workspace)
  check('forwarded text carries the @-path token', typeof sendCalls[0]?.text === 'string' && sendCalls[0].text.includes('@C:\\ws\\demo\\.drops\\1-shot.png'), sendCalls[0]?.text)
  check('image draft id is NOT forwarded to the native send', Array.isArray(sendCalls[0]?.attachmentIds) && sendCalls[0].attachmentIds.length === 0)
  check('native send still received `accept`', sendCalls[0]?.accepted === true && accepted.length === 1)
}

// ---- 3. a rejected draft upload is rescued into a chip ----------------------
{
  makeImageDraft('img-2', 'broken.png')
  fetchCalls.length = 0
  uploadStore.push({ 'img-2': { status: 'error', message: 'rejected', reason: 'too-large' } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const upload = fetchCalls.find((call) => call.init && call.init.method === 'POST')
  check('failed upload is re-uploaded to .drops', upload !== undefined)
  check('rejected draft is removed through the composer action face', removed.includes('img-2'), removed.join(','))
}

for (const dispose of disposers) {
  try { dispose() } catch { /* best-effort */ }
}

if (failed > 0) {
  console.error(`${failed} checks failed`)
  process.exit(1)
}
console.log('all checks passed')
