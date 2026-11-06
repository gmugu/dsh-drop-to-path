// Offline checks for the import route's workspace resolution
// (run with: node test-workspace.mjs).
//
// Covers the 0.2.2 adaptation:
//   1. a client-supplied workspace INSIDE a registered root is honored as-is
//      (git-worktree Sessions keep their own directory);
//   2. a workspace outside every root never moves the write (falls back);
//   3. no hint keeps the documented newest-root fallback;
//   4. the `workspaceRegistry` Host service is preferred, and the legacy
//      `storages/workspace.json` read (now wrapped in a unit/global envelope)
//      still works when the service is absent.

import { apply, IMPORT_ROUTE } from './lib/index.js'
import { Readable } from 'node:stream'
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` (${detail})`}`)
}

const base = mkdtempSync(join(tmpdir(), 'drop-to-path-test-'))
const rootA = join(base, 'workspace-a')
const rootB = join(base, 'workspace-b')
const outside = join(base, 'outside')
for (const dir of [rootA, rootB, outside]) mkdirSync(dir, { recursive: true })

/** Fake cordis ctx: one webServer route plus optional Host services. */
function makePlugin(services) {
  const routes = []
  const registrations = []
  const ctx = {
    get: (name) => services[name],
    inject: (deps, callback) => {
      if (deps.includes('webServer')) callback(webCtx)
    },
  }
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  }
  const webCtx = {
    get: (name) => (name === 'webServer' ? webServer : services[name]),
    effect: (callback) => {
      const dispose = callback()
      registrations.push(dispose)
      return dispose
    },
    webServer,
  }
  return { ctx, routes, registrations }
}

/** Invoke the registered route with a fake HTTP request. */
async function post(route, body, headers = { 'content-type': 'application/json' }) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = IMPORT_ROUTE
  req.headers = headers
  const chunks = []
  let status = 0
  const res = {
    writeHead: (code) => { status = code },
    end: (data) => { if (data !== undefined) chunks.push(Buffer.from(data)) },
  }
  await route.handler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  return { status, json: text.length > 0 ? JSON.parse(text) : undefined }
}

const payload = (workspace) => ({
  name: 'probe.png',
  dataBase64: Buffer.from('probe').toString('base64'),
  ...(workspace === undefined ? {} : { workspace }),
})

// --- 1. workspaceRegistry service present ------------------------------------
{
  const registry = {
    list: () => [
      { path: rootA, title: 'a', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
      { path: rootB, title: 'b', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
    ],
  }
  const { ctx, routes } = makePlugin({ workspaceRegistry: registry })
  await apply(ctx)
  check('route registered', routes.length === 1 && routes[0].path === IMPORT_ROUTE, `routes=${routes.length}`)
  const route = routes[0]

  const insideA = await post(route, payload(rootA))
  check('registered workspace is honored, not the newest root', insideA.json?.ok === true && insideA.json.value.path.startsWith(join(rootA, '.drops') + sep), insideA.json?.value?.path)

  const worktree = join(rootA, '.agents', 'worktrees', 'dsh-1')
  const nested = await post(route, payload(worktree))
  check('worktree descendant keeps its own directory', nested.json?.ok === true && nested.json.value.path.startsWith(join(worktree, '.drops') + sep), nested.json?.value?.path)

  const foreign = await post(route, payload(outside))
  check('foreign absolute path is confined to a registered root', foreign.json?.ok === true && foreign.json.value.path.startsWith(join(rootB, '.drops') + sep), foreign.json?.value?.path)

  const noHint = await post(route, payload())
  check('missing hint falls back to the newest root', noHint.json?.ok === true && noHint.json.value.path.startsWith(join(rootB, '.drops') + sep), noHint.json?.value?.path)

  const badType = await post(route, payload(rootA), { 'content-type': 'text/plain' })
  check('non-JSON write is refused', badType.status === 415, `status=${badType.status}`)
}

// --- 2. no registry service: legacy storage file fallback -------------------
{
  const home = join(base, 'dsh-home')
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [] },
    tables: {
      workspaces: {
        a: { path: rootA, title: 'a', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
        b: { path: rootB, title: 'b', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
      },
    },
  }), 'utf8')

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, routes } = makePlugin({})
    await apply(ctx)
    const result = await post(routes[0], payload(rootA))
    check('v2 unit/global envelope still parses via tables.workspaces', result.json?.ok === true && result.json.value.path.startsWith(join(rootA, '.drops') + sep), result.json?.value?.path)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

rmSync(base, { recursive: true, force: true })

if (failed > 0) {
  console.error(`${failed} checks failed`)
  process.exit(1)
}
console.log('all checks passed')
