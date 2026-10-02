/**
 * dsh-drop-to-path — host side.
 *
 * Registers one exact HTTP route on the DSH webServer:
 *   POST /_dsh/drop-to-path/import  { name, dataBase64, workspace?, relpath?, batch? }
 * Writes the decoded file into the active session workspace `.drops/`
 * directory and returns the absolute path.
 *
 * Three kinds of uploads are accepted:
 *   - images (png/jpg/jpeg/webp/gif, ≤30MB)  → sent via the wrapped
 *     conversation.sendSession while keeping the native attachment UI;
 *   - documents/media (pdf/office/plain/zip/video/audio, ≤100MB) → inserted
 *     into the composer as a plain path by the browser side;
 *   - folder contents (relpath = "<folder>/<...>/<file>", any extension,
 *     ≤100MB each) → written under .drops/<batch>/ preserving structure;
 *     the response carries `dir` (the folder root) so the client can queue
 *     one folder chip instead of one chip per file.
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

export const IMPORT_ROUTE = '/_dsh/drop-to-path/import'

const MAX_BODY_BYTES = 140 * 1024 * 1024 // JSON body cap (~100MB file in base64)
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_FILE_BYTES = 100 * 1024 * 1024
const DROP_DIR = '.drops'

export const name = 'dsh-drop-to-path'

/** Read the whole request body as UTF-8 text with a hard size cap. */
async function readBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('payload too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** All workspace roots from the durable registry, newest first. */
async function registeredRoots() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const store = join(dshHome, 'storages', 'workspace.json')
  let parsed
  try {
    parsed = JSON.parse(await readFile(store, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read workspace registry: ${error instanceof Error ? error.message : String(error)}`)
  }
  const workspaces = parsed?.tables?.workspaces
  if (typeof workspaces !== 'object' || workspaces === null) throw new Error('workspace registry is empty')
  const rows = Object.values(workspaces)
    .filter((w) => typeof w?.path === 'string' && w.path.length > 0)
    .sort((a, b) => String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? '')))
  if (rows.length === 0) throw new Error('no workspace registered')
  return rows.map((w) => w.path)
}

/** Resolve the active session workspace root from the durable workspace registry. */
async function workspaceRoot() {
  return (await registeredRoots())[0]
}

/** Effective WRITE root. The client-supplied workspace is honored ONLY when
 *  it is — or sits inside — a REGISTERED workspace root, so a stale or
 *  hostile payload can never move writes outside a real root (arbitrary
 *  absolute paths used to be trusted verbatim). Otherwise: newest root. */
async function resolveRoot(clientWorkspace) {
  const roots = await registeredRoots()
  if (typeof clientWorkspace === 'string' && isAbsolute(clientWorkspace)) {
    const normalized = resolve(clientWorkspace)
    const hit = roots.find((r) => normalized === r || normalized.startsWith(r + sep) || normalized.startsWith(r + '/'))
    if (hit !== undefined) return hit
  }
  return roots[0]
}

/** Local-origin guard for the whole route: the Host header must name a
 *  loopback authority (blocks DNS-rebinding hosts like evil.com:3080), and
 *  whenever a browser supplies Origin it must match Host (blocks cross-site
 *  no-cors POST/GET fired from other open pages — browsers always attach
 *  Origin to cross-site requests). */
function requestAuthorized(req) {
  const host = String(req.headers.host ?? '').toLowerCase()
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return false
  const origin = req.headers.origin
  if (origin !== undefined && origin !== null && String(origin) !== '') {
    try {
      return new URL(String(origin)).host.toLowerCase() === host
    } catch (error) {
      return false
    }
  }
  return true
}

/** Strip path separators and control characters from an uploaded file name.
 *  Unicode (Chinese etc.), spaces and dots are preserved; only characters
 *  that are illegal in Windows file names are replaced. */
function safeName(raw) {
  const base = basename(String(raw ?? ''))
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim()
    .slice(0, 120)
  return base.length === 0 ? 'file' : base
}

/** Sanitize a folder-upload relative path: split into segments, drop
 *  dot/traversal segments and illegal characters. Returns null when no
 *  usable segment remains. Depth is capped to keep paths manageable. */
function safeRelpath(raw) {
  const segs = String(raw ?? '')
    .split(/[\\/]+/)
    .map((seg) => seg.replace(/[:*?"<>|\x00-\x1f]/g, '_').trim())
    .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..')
    .slice(0, 12)
    .map((seg) => seg.slice(0, 80))
  return segs.length === 0 ? null : segs
}

export async function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: IMPORT_ROUTE,
        handler: async (req, res) => {
          const respond = (value, status = 200) => {
            res.writeHead(status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(value))
          }
          try {
            // Local-origin gate first: everything below (probes AND the
            // write path) is reachable only from the DSH GUI itself.
            if (!requestAuthorized(req)) {
              respond({ ok: false, error: { code: 'forbidden', message: 'local origin required' } }, 403)
              return
            }
            if (req.method !== 'POST') {
              try {
                const u = new URL(req.url ?? '/', 'http://x')
                // Model image-modality probe: mirrors the session controller's
                // prompt admission exactly (only an EXPLICIT non-image
                // inputModalities rejects images; undefined admits them), so
                // the browser side can decide whether to convert images to
                // .drops paths or let a multimodal model see them natively.
                if (u.searchParams.get('modalities') !== null) {
                  const provider = u.searchParams.get('provider') ?? ''
                  const model = u.searchParams.get('model') ?? ''
                  if (provider === '' || model === '') {
                    respond({ ok: false, error: { code: 'invalid-request', message: 'provider and model are required' } }, 200)
                    return
                  }
                  let llm
                  try { llm = webCtx.get('llm') } catch { llm = undefined }
                  if (!llm || typeof llm.resolveModelInfo !== 'function') {
                    respond({ ok: false, error: { code: 'llm-unavailable', message: 'llm service unavailable' } }, 200)
                    return
                  }
                  try {
                    const info = await llm.resolveModelInfo(provider, model)
                    const modalities = info?.inputModalities
                    const image = modalities === undefined || (Array.isArray(modalities) && modalities.includes('image'))
                    respond({ ok: true, value: { provider, model, image: image === true } }, 200)
                  } catch (error) {
                    respond({ ok: false, error: { code: 'model-unresolved', message: error instanceof Error ? error.message.slice(0, 200) : String(error) } }, 200)
                  }
                  return
                }
                // Host-side clipboard bitmap extraction: browsers cannot read
                // CF_BITMAP (e.g. Win+V history panel items), but .NET can.
                // Saves the bitmap to <workspace>/.drops and returns a path
                // the client can queue as a chip.
                if (u.searchParams.get('clipboardImage') !== null) {
                  try {
                    const root = await workspaceRoot()
                    if (!root) {
                      respond({ ok: false, error: { code: 'no-workspace', message: 'No workspace root found' } }, 200)
                      return
                    }
                    const name = `${Date.now()}-clipboard.png`
                    const outPath = join(root, DROP_DIR, name)
                    const scriptPath = fileURLToPath(new URL('clipboard-image.ps1', import.meta.url))
                    const { stdout } = await execFileAsync(
                      'powershell.exe',
                      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-OutPath', outPath],
                      { timeout: 15000 },
                    )
                    const text = String(stdout ?? '').trim()
                    if (text.startsWith('SAVED:')) {
                      respond({ ok: true, value: { path: outPath, name } }, 200)
                    } else {
                      respond({ ok: false, error: { code: 'clipboard', message: text.slice(0, 200) || 'no image on clipboard' } }, 200)
                    }
                  } catch (error) {
                    respond({ ok: false, error: { code: 'clipboard', message: error instanceof Error ? error.message.slice(0, 200) : String(error) } }, 200)
                  }
                  return
                }
                // Lightweight clipboard probe for the client's right-click
                // interception: reports whether the clipboard carries any
                // image (including CF_BITMAP the browser itself cannot see).
                if (u.searchParams.get('clipboardState') !== null) {
                  try {
                    const scriptPath = fileURLToPath(new URL('clipboard-state.ps1', import.meta.url))
                    const { stdout } = await execFileAsync(
                      'powershell.exe',
                      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
                      { timeout: 8000 },
                    )
                    respond({ ok: true, value: { hasImage: String(stdout ?? '').trim().startsWith('IMAGE') } }, 200)
                  } catch (error) {
                    respond({ ok: false, error: { code: 'clipboard', message: error instanceof Error ? error.message.slice(0, 200) : String(error) } }, 200)
                  }
                  return
                }
                // Image preview streaming for queued chips: the browser cannot
                // load local file paths, so the host serves .drops images back.
                // Confined to REGISTERED workspace roots, and CORP: same-origin
                // so other pages cannot even <img>-embed the response.
                if (u.searchParams.get('file') !== null) {
                  try {
                    const target = resolve(u.searchParams.get('file') ?? '')
                    const ext = extname(target).toLowerCase()
                    const dropsSeg = `${sep}${DROP_DIR}${sep}`
                    const underRoot = (await registeredRoots()).some((r) => target === r || target.startsWith(r + sep))
                    if (!IMAGE_EXTENSIONS.has(ext) || !target.includes(dropsSeg) || !underRoot) {
                      respond({ ok: false, error: { code: 'forbidden', message: 'Only workspace .drops images are served' } }, 403)
                      return
                    }
                    const data = await readFile(target)
                    const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
                    res.writeHead(200, {
                      'Content-Type': mime,
                      'Cache-Control': 'no-cache',
                      'Cross-Origin-Resource-Policy': 'same-origin',
                    })
                    res.end(data)
                  } catch {
                    respond({ ok: false, error: { code: 'not-found', message: 'file not found' } }, 404)
                  }
                  return
                }
                // Client boot diagnostic beacon: ?beacon=<json> appends one line
                // to .beacon.log next to this file (best-effort diagnostics;
                // truncated when it outgrows 512KB so any page cannot disk-fill).
                const raw = u.searchParams.get('beacon')
                if (raw !== null) {
                  const logUrl = new URL('.beacon.log', import.meta.url)
                  const line = `${new Date().toISOString()} ${raw.slice(0, 400)}\n`
                  try {
                    const st = await stat(logUrl)
                    if (st.size > 512 * 1024) await writeFile(logUrl, '')
                  } catch { /* absent log file is fine */ }
                  appendFileSync(logUrl, line)
                  res.writeHead(200, { 'Content-Type': 'application/json' })
                  res.end(JSON.stringify({ ok: true }))
                  return
                }
              } catch { /* beacon failures fall through to 405 */ }
              respond({ ok: false, error: { code: 'method-not-allowed', message: 'Use POST' } }, 405)
              return
            }
            // Write path: only same-origin application/json is accepted. A
            // text/plain no-cors POST from another page is the CSRF write
            // vector (no preflight, but the host would have parsed it all
            // the same); application/json forces a preflight it cannot pass.
            const contentType = String(req.headers['content-type'] ?? '')
            if (!/^application\/json\b/i.test(contentType)) {
              respond({ ok: false, error: { code: 'unsupported-media-type', message: 'application/json required' } }, 415)
              return
            }
            let body
            try {
              body = JSON.parse(await readBody(req, MAX_BODY_BYTES))
            } catch (error) {
              respond({ ok: false, error: { code: 'invalid-request', message: error instanceof Error ? error.message : String(error) } }, 400)
              return
            }
            const { name: rawName, dataBase64, workspace: clientWorkspace, relpath: rawRelpath, batch: rawBatch } = body
            if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
              respond({ ok: false, error: { code: 'invalid-request', message: 'Missing dataBase64' } }, 400)
              return
            }
            // The write root is ALWAYS a registered workspace root; the
            // client workspace hint only SELECTS among them (never escapes).
            const root = await resolveRoot(clientWorkspace)
            const bytes = Buffer.from(dataBase64, 'base64')
            const safe = safeName(rawName)
            const dot = safe.lastIndexOf('.')
            const ext = (dot >= 0 ? safe.slice(dot) : '').toLowerCase()

            // Folder mode: a relative path with at least <folder>/<file>
            // keeps the dropped directory structure under .drops/<batch>/.
            const relSegments = rawRelpath === undefined ? null : safeRelpath(rawRelpath)
            const folderMode = relSegments !== null && relSegments.length >= 2

            // Images keep their dedicated rail; EVERY other extension
            // (.html, .py, .log, .ps1, no extension at all...) lands as a
            // regular file — folder mode already allowed any extension, so
            // single-file mode now matches it.
            let kind, limit
            if (IMAGE_EXTENSIONS.has(ext)) { kind = 'image'; limit = MAX_IMAGE_BYTES }
            else { kind = 'file'; limit = MAX_FILE_BYTES }
            if (bytes.length === 0 || bytes.length > limit) {
              respond({ ok: false, error: { code: 'too-large', message: `File exceeds ${Math.floor(limit / 1024 / 1024)}MB` } }, 413)
              return
            }

            if (folderMode) {
              // One batch directory per dropped folder (client supplies the
              // batch stamp); the relative path keeps the inner structure.
              const batchSegs = safeRelpath(rawBatch ?? relSegments[0])
              const batchName = batchSegs === null ? 'folder' : batchSegs.join('-')
              const inner = relSegments.slice(1)
              inner[inner.length - 1] = safe
              const folderRoot = join(root, DROP_DIR, batchName)
              const dir = join(folderRoot, ...inner.slice(0, -1))
              await mkdir(dir, { recursive: true })
              const target = join(dir, inner[inner.length - 1])
              await writeFile(target, bytes)
              respond({ ok: true, value: { path: target, dir: folderRoot, filename: safe, bytes: bytes.length, kind: 'folder-file' } })
              return
            }

            const dir = join(root, DROP_DIR)
            await mkdir(dir, { recursive: true })
            const target = join(dir, `${Date.now()}-${safe}`)
            await writeFile(target, bytes)
            respond({ ok: true, value: { path: target, filename: basename(target), bytes: bytes.length, kind } })
          } catch (error) {
            respond({ ok: false, error: { code: 'import-failed', message: error instanceof Error ? error.message : String(error) } }, 500)
          }
        },
      })
      return dispose
    }, 'drop-to-path: import route')
  })
}
