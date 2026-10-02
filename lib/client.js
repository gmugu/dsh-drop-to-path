/**
 * dsh-drop-to-path — browser side.
 *
 * >>> 0.3.x adaptation (2026-10-02), see ADAPTING.md record #4 <<<
 * Adapted to the current DSH client API: sendSession now has the signature
 * (session, text, attachmentIds, mode, signal); drafts resolve via
 * conversation.resolveDraftAttachments(ids) → { id, kind, file, ... } and are
 * released via releaseDraftAttachment(s). The removed draftImages() API made
 * the v0.2.6 wrapper fall back to the native send on every image submission,
 * so text-only models rejected the message ("当前模型不支持图片").
 *
 * History of this adaptation:
 * - 0.3.0: sendSession wrapper rewritten for the attachment-draft API; the
 *   converted send re-dispatches the ORIGINAL sendSession (native submission
 *   pipeline intact); services read lazily (current DSH boots this module
 *   before the app services mount).
 * - 0.3.1: multimodal awareness — before converting, ask the host (GET
 *   ?modalities=1, backed by llm.resolveModelInfo, the same rule prompt
 *   admission applies) whether the current model accepts image input.
 * - 0.3.2: the model-check chain mirrors prompt admission exactly — picker
 *   selection (modelSelection projection) → last used → deployment DEFAULT
 *   (remote.session.modelCatalog().default), so fresh sessions with a
 *   multimodal default also pass images natively.
 * - 0.3.3: normal operation is silent again (notices only on genuine
 *   failures); model-check beacons carry provider/model/source for
 *   diagnostics.
 * - 0.3.4: fixed the fresh-session modality miss — modelCatalog() resolves a
 *   Remote response { ok, value }; catalogDefault read .default off the
 *   wrapper, resolved null, and the unresolved arm converted images for
 *   MULTIMODAL models (multimodality does not depend on the effort level;
 *   the picker-selection arm only resolved after the user touched the model
 *   or effort picker, which is why "default" failed and "max" worked).
 * - 0.3.5: converted paths (images, files, folder chips) are emitted as
 *   explicit DSH file-reference tokens — @path, @"path with spaces", with a
 *   trailing slash marking folders — matching the @file grammar the agent
 *   instructions already define.
 * - 0.3.6 (audit batch 1): host route hardening (loopback Host + same-origin
 *   Origin gate, application/json-only writes, writes confined to REGISTERED
 *   workspace roots, ?file= confined + CORP:same-origin, beacon log capped),
 *   bounded-wait send settlement for in-flight uploads, snapshot-only chip
 *   removal after a successful send, and timeouts on every fetch.
 *
 * Two behaviors, one plugin:
 *
 * 1. IMAGES keep the native attachment experience (thumbnails, preview,
 *    remove). The submit path is wrapped: when the user sends a prompt that
 *    carries draft images, each image is uploaded to the host import route
 *    and the message content sent to the model is replaced by the returned
 *    workspace file paths — so a text-only model agent receives file
 *    addresses it can feed to the vision toolkit, instead of a rejected
 *    image attachment.
 *
 * 2. NON-IMAGE files (pdf / office / plain text / zip / video / audio) are
 *    shown as small square chips IN the attachment rail, same row as image
 *    thumbnails (icon tile + truncated name, full name on hover). Nothing is
 *    written into the composer text; on send, the file paths are appended to
 *    the message automatically — exactly like the image conversion.
 *
 * 3. FOLDERS (this fork): dropping a folder traverses it recursively through
 *    FileSystemEntry handles and uploads every file preserving the inner
 *    structure under workspace `.drops/<batch>/`; the rail shows one 📁 chip
 *    per folder and its root path is appended on send. Pasting an
 *    Explorer-copied folder cannot read contents (browser security): the
 *    plugin explains the drag-drop workaround in a visible notice instead of
 *    failing silently. Images embedded in HTML clipboards (browser/WeChat
 *    "copy image" data-URIs) are decoded and re-dispatched as native drops.
 *
 * Drop handling rules:
 *   - pure-image drop  → untouched, DSH handles it natively (rail + overlay);
 *   - file-only drop   → intercepted, files uploaded as paths + chips;
 *   - mixed drop       → files intercepted, images re-dispatched as a
 *     pure-image drop (which the pure-image rule lets through).
 * After intercepting, a synthetic `dragend` is dispatched so DSH closes its
 * full-screen drop overlay (it resets unconditionally on dragend).
 *
 * The sendSession wrapper is installed on the ConversationController
 * prototype (reached through the injected singleton), so any future instance
 * of the service inherits the patch. A failed upload is never silent: a
 * short page notice explains what happened before falling back to the
 * native send path.
 */

window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-drop-to-path',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var IMPORT_ROUTE = '/_dsh/drop-to-path/import'
    var PATCH_MARK = '__dshDropToPathPatched'
    var CHIPS_ATTR = 'data-drop-to-path-chips'

    /** fetch() with a hard timeout: a stalled host connection must never
     *  hang the send path (or pile up pending clipboard probes). Falls back
     *  to plain fetch where AbortController is unavailable. */
    function fetchWithTimeout(url, init, ms) {
      if (typeof AbortController !== 'function') return fetch(url, init)
      var ctrl = new AbortController()
      var timer = setTimeout(function () { try { ctrl.abort() } catch (error) { /* already settled */ } }, ms || 10000)
      var merged = Object.assign({}, init || {}, { signal: ctrl.signal })
      return fetch(url, merged).then(
        function (response) { clearTimeout(timer); return response },
        function (error) { clearTimeout(timer); throw error },
      )
    }

    /** Boot diagnostic: report lifecycle stages to the host (fire-and-forget). */
    function beacon(stage, extra) {
      try {
        var payload = { stage: stage, ts: Date.now() }
        if (extra !== void 0) payload.extra = extra
        fetchWithTimeout(IMPORT_ROUTE + '?beacon=' + encodeURIComponent(JSON.stringify(payload)), void 0, 8000).catch(function () {})
      } catch (error) { /* diagnostics never break the page */ }
    }
    beacon('module-eval')

    /** Read an optional cordis service without a hard inject dependency. */
    function getService(ctx, name) {
      try {
        if (ctx && typeof ctx.get === 'function') {
          var s = ctx.get(name)
          if (s !== undefined) return s
        }
      } catch (error) { /* fall through to property read */ }
      try { return ctx ? ctx[name] : void 0 } catch (error) { return void 0 }
    }

    /** Live plugin context (set in apply). Current DSH boots this module
     *  before the app services mount, so services must be read lazily at
     *  drop/send time instead of captured at apply time. */
    var liveCtx = null
    function sessionsNow() { return getService(liveCtx, 'sessions') }

    /** The session's current model selection, from the same projection the
     *  composer reads (modelSelection: next ?? lastUsed). Best-effort. */
    function sessionModelSelection(session) {
      try {
        var proj = session && session.projections
        var face = proj && typeof proj.faceOf === 'function' ? proj.faceOf('modelSelection') : null
        var snap = face && typeof face.getSnapshot === 'function' ? face.getSnapshot() : null
        var sel = snap ? (snap.next || snap.lastUsed) : null
        if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') {
          // reasoningEffort is the composer's effort picker (off…max); kept
          // for model-check beacon diagnostics only — a multimodal model
          // accepts images at EVERY effort level.
          return {
            provider: sel.provider,
            model: sel.model,
            effort: typeof sel.reasoningEffort === 'string' ? sel.reasoningEffort : void 0,
          }
        }
      } catch (error) { /* best-effort */ }
      return null
    }

    /** The deployment's DEFAULT model, from the same catalog the model picker
     *  reads (remote.session.modelCatalog → agentDefaultModel.currentSelection
     *  — the exact fallback prompt admission uses for fresh sessions). NOTE:
     *  modelCatalog() resolves a Remote RESPONSE wrapper { ok, value }; the
     *  catalog itself (with .default) lives under value. Reading .default off
     *  the wrapper silently resolved null and pushed fresh-session sends into
     *  the unresolved arm — which converted images for MULTIMODAL models. */
    function catalogDefault() {
      return new Promise(function (resolve) {
        var rs = getService(liveCtx, 'remote.session')
        if (!rs) { var r = getService(liveCtx, 'remote'); rs = r && r.session }
        if (!rs || typeof rs.modelCatalog !== 'function') return resolve(null)
        try {
          Promise.resolve(rs.modelCatalog()).then(function (response) {
            // Unwrap the Remote response; tolerate a raw catalog too.
            var catalog = response && typeof response === 'object' && response.ok !== void 0 && response.value !== void 0 ? response.value : response
            var d = catalog && catalog.default
            resolve(d && typeof d.provider === 'string' && typeof d.model === 'string' ? { provider: d.provider, model: d.model } : null)
          }, function () { resolve(null) })
        } catch (error) { resolve(null) }
      })
    }

    /** provider/model → boolean image support, cached per page load. */
    var modalityCache = {}

    /** Ask the host whether the session's CURRENT model admits image input
     *  (same chain prompt admission applies: picker selection → last used →
     *  deployment default). Resolves accepts:false on ANY failure — the safe
     *  default for this plugin is to convert images to paths, because that
     *  always delivers a sendable message. Returns the verdict plus the
     *  resolved provider/model and which arm produced it. */
    function modelAcceptsImages(session) {
      return Promise.resolve().then(function () {
        var sel = sessionModelSelection(session)
        if (sel) return { sel: sel, source: 'selection' }
        return catalogDefault().then(function (d) {
          return d ? { sel: d, source: 'default' } : null
        })
      }).then(function (info) {
        if (!info) return { accepts: false, provider: null, model: null, source: 'unresolved', effort: null }
        var sel = info.sel
        var key = sel.provider + '/' + sel.model
        if (typeof modalityCache[key] === 'boolean') {
          return { accepts: modalityCache[key], provider: sel.provider, model: sel.model, source: info.source, effort: sel.effort || null }
        }
        return fetchWithTimeout(IMPORT_ROUTE + '?modalities=1&provider=' + encodeURIComponent(sel.provider) + '&model=' + encodeURIComponent(sel.model), void 0, 5000)
          .then(function (response) { return response.json() })
          .then(function (result) {
            var accepts = !!(result && result.ok && result.value && result.value.image === true)
            if (result && result.ok) modalityCache[key] = accepts
            return { accepts: accepts, provider: sel.provider, model: sel.model, source: info.source, effort: sel.effort || null }
          })
          .catch(function () {
            return { accepts: false, provider: sel.provider, model: sel.model, source: info.source + '-error', effort: sel.effort || null }
          })
      })
    }

    /** Non-image files dragged in this page: { path, name } in drop order. */
    var fileQueue = []

    // ---- in-flight upload tracking ------------------------------------------------
    // Chips materialize only when their upload resolves, so a send that
    // snapshots the queue mid-upload would silently omit those files. Every
    // enqueue extends ONE chain; sendSession awaits its settlement (bounded)
    // before snapshotting.
    var enqueueChain = Promise.resolve()
    var enqueueSettled = true
    function trackEnqueue(promise) {
      enqueueSettled = false
      enqueueChain = Promise.resolve(promise).then(
        function (value) { enqueueSettled = true; return value },
        function (error) { enqueueSettled = true; throw error },
      )
      return enqueueChain
    }
    /** Wait (bounded) for every upload started so far. Resolves true when
     *  the chain settled, false on timeout (send proceeds with whatever
     *  chips exist, and the user is warned). */
    function settleUploads(timeoutMs) {
      return Promise.race([
        enqueueChain.then(function () { return true }, function () { return true }),
        new Promise(function (resolve) { setTimeout(function () { resolve(false) }, timeoutMs || 30000) }),
      ])
    }

    function isImageFile(file) {
      return !!file && typeof file.type === 'string' && file.type.indexOf('image/') === 0
    }

    var IMAGE_NAME_PATTERN = /\.(png|jpe?g|webp|gif|bmp)$/i
    function isImageName(name) { return IMAGE_NAME_PATTERN.test(name || '') }

    /** Format a converted path as an explicit DSH file-reference token:
     *  `@path`, or `@"path"` when the path contains whitespace (the quoted
     *  form of the shared @file grammar — see dsh-file-reference). The
     *  agent's instructions define @-prefixed tokens as user-referenced
     *  paths, so converted images/files/folders arrive as first-class
     *  references instead of bare path strings. A trailing slash marks a
     *  directory per the same grammar. */
    function atToken(path) {
      return /\s/.test(path) ? '@"' + path + '"' : '@' + path
    }

    /** Queued chips as reference tokens, drop order preserved. Folder chips
     *  (name ends with '/') carry the directory-marking trailing slash. */
    function queuedPathTokens() {
      return fileQueue.map(function (item) {
        var folder = typeof item.name === 'string' && /\/$/.test(item.name)
        return atToken(folder ? item.path + '/' : item.path)
      })
    }

    /** Preview URL for a queued image chip: a fresh blob URL while we still
     *  hold the File; otherwise the host streams the uploaded .drops file. */
    function previewUrlFor(item) {
      if (item.previewUrl) return item.previewUrl
      if (isImageName(item.name) && typeof item.path === 'string') {
        return IMPORT_ROUTE + '?file=' + encodeURIComponent(item.path)
      }
      return null
    }

    function revokePreview(item) {
      if (item && typeof item.previewUrl === 'string' && item.previewUrl.indexOf('blob:') === 0) {
        try { URL.revokeObjectURL(item.previewUrl) } catch (error) { /* best-effort */ }
      }
    }

    // ---- lightbox: click an image chip to inspect the full-size picture ----
    var lightboxCleanup = null
    function closeLightbox() {
      if (typeof lightboxCleanup === 'function') lightboxCleanup()
    }
    function openLightbox(url, name) {
      closeLightbox()
      var overlay = document.createElement('div')
      overlay.setAttribute('data-drop-to-path-lightbox', '1')
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.78);' +
        'display:flex;align-items:center;justify-content:center;cursor:zoom-out'
      var img = document.createElement('img')
      img.src = url
      img.alt = name || ''
      img.title = (name || '') + '（点击任意处或按 Esc 关闭）'
      img.style.cssText = 'max-width:92vw;max-height:92vh;object-fit:contain;border-radius:6px;' +
        'box-shadow:0 8px 40px rgba(0,0,0,.5);cursor:zoom-out;background:#111'
      overlay.appendChild(img)
      var onKey = function (event) {
        if (event.key === 'Escape') {
          event.stopPropagation()
          closeLightbox()
        }
      }
      overlay.addEventListener('click', closeLightbox)
      document.addEventListener('keydown', onKey, true)
      document.documentElement.appendChild(overlay)
      lightboxCleanup = function () {
        document.removeEventListener('keydown', onKey, true)
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
        lightboxCleanup = null
      }
    }

    // Any named file is welcome: images split off to the native rail, every
    // other extension (html, py, log, ps1, anything) uploads as a file chip.
    // Accepting all extensions also keeps drops of browser-openable files
    // (.html!) from navigating the page away.
    function isSupportedFile(file) {
      return !!file && typeof file.name === 'string' && file.name.length > 0
    }

    function toBase64(buffer) {
      var bytes = new Uint8Array(buffer)
      var binary = ''
      var chunk = 0x8000
      for (var i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
      }
      return btoa(binary)
    }

    /** Upload one file to the host; resolves { path, dir } (dir only in folder mode). */
    function upload(file, workspace, extra) {
      return file.arrayBuffer().then(function (buffer) {
        var payload = { name: file.name, dataBase64: toBase64(buffer) }
        if (workspace && typeof workspace === 'string' && workspace.length > 0) payload.workspace = workspace
        if (extra && typeof extra.relpath === 'string') payload.relpath = extra.relpath
        if (extra && typeof extra.batch === 'string') payload.batch = extra.batch
        return fetchWithTimeout(IMPORT_ROUTE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }, 120000)
      }).then(function (response) {
        return response.json().then(function (result) {
          if (!response.ok || !result.ok) {
            throw new Error(result.error && result.error.message ? result.error.message : 'import failed')
          }
          return { path: result.value.path, dir: result.value.dir }
        })
      })
    }

    /** Workspace path of the given (or current) session, from the sessions service. */
    function currentWorkspace(sessions, sessionId) {
      try {
        // Current DSH sessions face: retainInfo(id) → ObservableSnapshot<SessionRetainInfo>.
        // Read a cwd-like field optimistically; harmless when absent.
        if (sessions && sessionId && typeof sessions.retainInfo === 'function') {
          var snap = sessions.retainInfo(sessionId)
          var info = snap && typeof snap.getSnapshot === 'function' ? snap.getSnapshot() : snap
          var rcwd = info && typeof info.cwd === 'string' && info.cwd.length > 0 ? info.cwd : undefined
          if (rcwd) return rcwd
        }
        // Legacy path (older DSH): sessions.list.getSnapshot().byId[current].cwd
        var state = sessions && sessions.list ? sessions.list.getSnapshot() : undefined
        if (!state) return undefined
        var id = sessionId || state.current
        if (!id) return undefined
        var row = state.byId ? state.byId[id] : undefined
        return row && typeof row.cwd === 'string' && row.cwd.length > 0 ? row.cwd : undefined
      } catch (error) { /* best-effort */ }
      return undefined
    }

    /** Short red notice near the top of the page; removed automatically. */
    function showNotice(message) {
      try {
        var existing = document.querySelector('[data-drop-to-path-notice]')
        if (existing) existing.remove()
        var box = document.createElement('div')
        box.dataset.dropToPathNotice = '1'
        box.textContent = message
        box.style.cssText = 'position:fixed;top:16px;right:16px;z-index:99999;max-width:420px;' +
          'background:#c34f4f;color:#fff;padding:10px 14px;border-radius:10px;' +
          'font:12px/1.5 sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35)'
        document.body.append(box)
        setTimeout(function () { box.remove() }, 6000)
      } catch (error) { /* notice is best-effort */ }
    }

    /** The DSH composer card (stable data attribute, survives CSS-module rebuilds). */
    function findCard() {
      return document.querySelector('[data-composer-card]')
    }

    /** The composer scroll area the chip bar is inserted right above. */
    function findScroll(card) {
      return card ? card.querySelector('[data-input-scroll]') : null
    }

    // ---- file chips: small squares in the attachment rail, same row as images ----

    /** Per-format icon + accent color so chips are distinguishable at a glance. */
    function fileKind(name) {
      var n = String(name || '').toLowerCase()
      if (/\/$/.test(n)) return { icon: '📁', color: '#ca8a04' }
      if (/\.pdf$/.test(n)) return { icon: '📕', color: '#d9534f' }
      if (/\.docx?$/.test(n)) return { icon: '📘', color: '#2b579a' }
      if (/\.xlsx?$/.test(n)) return { icon: '📗', color: '#217346' }
      if (/\.pptx?$/.test(n)) return { icon: '📙', color: '#d24726' }
      if (/\.(txt|md|csv|json)$/.test(n)) return { icon: '📄', color: '#6b7280' }
      if (/\.zip$/.test(n)) return { icon: '📦', color: '#b45309' }
      if (/\.(mp4|mov|webm|mkv|avi)$/.test(n)) return { icon: '🎬', color: '#7c3aed' }
      if (/\.(mp3|wav|flac|m4a)$/.test(n)) return { icon: '🎵', color: '#0e7490' }
      return { icon: '📄', color: '#6b7280' }
    }

    /**
     * Reuse the DSH image thumbnail size so file chips always match the
     * image squares 1:1 — measured live, so any future DSH size change is
     * followed automatically. Falls back to 64px (current native size).
     */
    function thumbnailSize() {
      try {
        var img = document.querySelector('img[src^="blob:"]')
        if (img) {
          var w = Math.round(img.getBoundingClientRect().width)
          if (w >= 32 && w <= 160) return w
        }
      } catch (error) { /* fall through */ }
      return 64
    }

    function renderChips() {
      var old = document.querySelector('[' + CHIPS_ATTR + ']')
      if (old) old.remove()
      if (fileQueue.length === 0) return
      var card = findCard()
      var scroll = findScroll(card)
      if (!card || !scroll) return

      var bar = document.createElement('div')
      bar.setAttribute(CHIPS_ATTR, '1')
      bar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:4px 12px 0'
      fileQueue.forEach(function (item, index) {
        var size = thumbnailSize()
        var chip = document.createElement('span')
        chip.style.cssText = 'position:relative;display:inline-flex;flex-direction:column;align-items:center;' +
          'justify-content:center;gap:2px;width:' + size + 'px;height:' + size + 'px;box-sizing:border-box;' +
          'border:1px solid rgba(92,108,213,.4);background:rgba(92,108,213,.08);' +
          'border-radius:8px;overflow:hidden'

        var preview = previewUrlFor(item)
        if (preview) {
          // Image chip: the actual picture fills the chip — no filename strip.
          // Order badge top-left; click anywhere on the chip to zoom full-size.
          var img = document.createElement('img')
          img.src = preview
          img.alt = item.name
          img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover'
          chip.append(img)
          chip.title = item.name + '（点击放大）'
          chip.style.cursor = 'zoom-in'
          chip.addEventListener('click', function () { openLightbox(preview, item.name) })
          var badge = document.createElement('span')
          badge.textContent = String(index + 1)
          badge.title = '第 ' + (index + 1) + ' 张/个'
          badge.style.cssText = 'position:absolute;top:2px;left:2px;min-width:14px;height:14px;padding:0 3px;box-sizing:border-box;' +
            'display:inline-flex;align-items:center;justify-content:center;border-radius:7px;' +
            'background:rgba(0,0,0,.55);color:#fff;font:9px/1 sans-serif;z-index:1;pointer-events:none'
          chip.append(badge)
        } else {
          var kind = fileKind(item.name)
          var iconBox = document.createElement('span')
          iconBox.textContent = kind.icon
          iconBox.style.cssText = 'font-size:' + Math.max(18, Math.round(size * 0.42)) + 'px;line-height:1'
          var label = document.createElement('span')
          label.textContent = item.name
          label.title = item.name
          label.style.cssText = 'max-width:' + (size - 6) + 'px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
            'font:10px/1.2 sans-serif;color:var(--dsw-alias-fg-tertiary,#6f7c99);padding:0 2px'
          chip.append(iconBox, label)
        }

        var remove = document.createElement('button')
        remove.textContent = '✕'
        remove.title = '移除'
        remove.style.cssText = 'position:absolute;top:2px;right:2px;width:16px;height:16px;display:inline-flex;z-index:2;' +
          'align-items:center;justify-content:center;border:0;border-radius:50%;cursor:pointer;' +
          'background:rgba(0,0,0,.35);color:#fff;font-size:9px;line-height:1;padding:0'
        remove.addEventListener('click', function (event) {
          event.stopPropagation() // never open the lightbox when removing
          removeFile(item.path)
        })
        chip.append(remove)
        bar.append(chip)
      })

      // Own dedicated bar right above the input scroll area — the same spot
      // the native attachment rail occupies. Independent of the native rail,
      // so chips render even when no image attachments exist.
      card.insertBefore(bar, scroll)
    }

    function addFile(path, name, previewUrl) {
      fileQueue.push({ path: path, name: name, previewUrl: previewUrl })
      renderChips()
    }

    function removeFile(path) {
      fileQueue = fileQueue.filter(function (item) {
        if (item.path === path) { revokePreview(item); return false }
        return true
      })
      renderChips()
    }

    /** Remove ONLY the snapshotted paths. Chips added after the snapshot
     *  stay queued for the next message — a successful send must never
     *  delete files the user attached while it was in flight. */
    function removeFilesByPaths(paths) {
      if (!paths || paths.length === 0) { renderChips(); return }
      var drop = {}
      paths.forEach(function (p) { drop[p] = true })
      fileQueue = fileQueue.filter(function (item) {
        if (drop[item.path]) { revokePreview(item); return false }
        return true
      })
      renderChips()
    }

    // Rebuild chips if a React re-render of the card removed them. The guard
    // re-binds when the composer card is remounted (session switch) and
    // periodically heals a missing bar. Returns a disposer.
    var chipsTimer = null
    function startChipsGuard() {
      var observedCard = null
      var observer = null
      var bind = function (card) {
        if (observer) observer.disconnect()
        observedCard = card
        observer = new MutationObserver(function () {
          if (fileQueue.length > 0 && document.querySelector('[' + CHIPS_ATTR + ']') === null) {
            clearTimeout(chipsTimer)
            chipsTimer = setTimeout(renderChips, 60)
          }
        })
        observer.observe(card, { childList: true, subtree: true })
      }
      var interval = setInterval(function () {
        var card = findCard()
        if (card && card !== observedCard) bind(card)
        if (fileQueue.length > 0 && document.querySelector('[' + CHIPS_ATTR + ']') === null) renderChips()
      }, 2000)
      var card = findCard()
      if (card) bind(card)
      return function () {
        clearInterval(interval)
        clearTimeout(chipsTimer)
        if (observer) observer.disconnect()
        observedCard = null
      }
    }

    /** Upload a batch of files in order, adding a chip per file (no composer text). */
    function enqueueFiles(files, sessions) {
      var ws = currentWorkspace(sessions || sessionsNow())
      var chain = Promise.resolve()
      files.forEach(function (file) {
        // Fresh File objects double as zero-latency previews via blob URLs.
        var previewUrl = isImageFile(file) ? URL.createObjectURL(file) : void 0
        chain = chain.then(function () { return upload(file, ws) }).then(function (result) {
          addFile(result.path, file.name, previewUrl)
        }).catch(function (error) {
          revokePreview({ previewUrl: previewUrl })
          console.error('[drop-to-path] file upload failed:', error)
          showNotice('[dsh-drop-to-path] 文件上传失败: ' + (error && error.message ? error.message : String(error)))
        })
      })
      trackEnqueue(chain)
    }

    // ---- folders: recursive FileSystemEntry traversal + structured upload ----

    /** Client-side mirror of the host name sanitizer (batch directory names). */
    function safeSegment(raw) {
      var cleaned = String(raw || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()
      return cleaned.length === 0 ? 'folder' : cleaned.slice(0, 80)
    }

    /** Read a directory entry completely (readEntries paginates ≤100/call). */
    function readAllEntries(reader) {
      return new Promise(function (resolve) {
        var all = []
        var step = function () {
          reader.readEntries(function (batch) {
            if (!batch || batch.length === 0) return resolve(all)
            all = all.concat(Array.prototype.slice.call(batch))
            step()
          }, function () { resolve(all) })
        }
        step()
      })
    }

    /**
     * Traverse one FileSystemEntry into [{ file, relpath }] pairs.
     * `relpath` is relative to the dropped item (no leading folder segment).
     */
    function traverseEntry(entry, prefix) {
      if (!entry) return Promise.resolve([])
      if (entry.isFile) {
        return new Promise(function (resolve) {
          entry.file(function (file) {
            resolve([{ file: file, relpath: prefix + file.name }])
          }, function () { resolve([]) })
        })
      }
      if (entry.isDirectory) {
        return readAllEntries(entry.createReader()).then(function (children) {
          var chain = Promise.resolve([])
          children.forEach(function (child) {
            chain = chain.then(function (acc) {
              return traverseEntry(child, prefix + entry.name + '/').then(function (items) {
                return acc.concat(items)
              })
            })
          })
          return chain
        })
      }
      return Promise.resolve([])
    }

    /**
     * Upload one dropped/pasted folder: files keep their inner structure under
     * .drops/<batch>/ and the folder root gets ONE chip (📁) in the rail.
     */
    function enqueueFolder(dirEntry, sessions) {
      var ws = currentWorkspace(sessions || sessionsNow())
      var batch = Date.now() + '-' + safeSegment(dirEntry.name)
      var folderLabel = dirEntry.name + '/'
      showNotice('[dsh-drop-to-path] 正在上传文件夹 ' + folderLabel + ' …')
      return trackEnqueue(traverseEntry(dirEntry, '').then(function (items) {
        if (items.length === 0) {
          showNotice('[dsh-drop-to-path] 文件夹 ' + folderLabel + ' 为空（或浏览器未授予读取权限）')
          return
        }
        var folderRoot = null
        var done = 0
        var failed = 0
        var chain = Promise.resolve()
        items.forEach(function (item) {
          chain = chain.then(function () {
            return upload(item.file, ws, { relpath: dirEntry.name + '/' + item.relpath, batch: batch })
          }).then(function (result) {
            if (folderRoot === null && typeof result.dir === 'string') folderRoot = result.dir
            done += 1
          }).catch(function (error) {
            failed += 1
            console.error('[drop-to-path] folder file upload failed:', item.relpath, error)
          })
        })
        return chain.then(function () {
          if (folderRoot !== null) addFile(folderRoot, folderLabel)
          if (failed === 0) {
            showNotice('[dsh-drop-to-path] 文件夹 ' + folderLabel + ' 已就绪（' + done + ' 个文件）')
          } else {
            showNotice('[dsh-drop-to-path] 文件夹 ' + folderLabel + ' 部分上传失败：成功 ' + done + ' / 失败 ' + failed)
          }
        })
      }))
    }

    /** DSH closes its full-screen drop overlay on window `dragend`. */
    function closeDropOverlayLater() {
      setTimeout(function () {
        try { window.dispatchEvent(new DragEvent('dragend')) } catch (error) { /* best-effort */ }
      }, 0)
    }

    /** Images embedded in the HTML clipboard (browser/WeChat "copy image"). */
    function extractHtmlImages(clipboardData) {
      var out = []
      var html = ''
      try { html = clipboardData.getData('text/html') || '' } catch (error) { html = '' }
      if (html === '') return out
      var re = /data:image\/(png|jpe?g|gif|webp|bmp);base64,([A-Za-z0-9+/=]+)/gi
      var match
      while ((match = re.exec(html)) !== null) {
        try {
          var ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()
          var binary = atob(match[2])
          var bytes = new Uint8Array(binary.length)
          for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          out.push(new File([bytes], 'clipboard-' + Date.now() + '.' + ext, { type: 'image/' + match[1].toLowerCase() }))
        } catch (error) { /* skip broken data URI */ }
      }
      return out
    }

    /** Re-dispatch images as a pure-image drop so DSH handles them natively. */
    function redispatchImages(images, target, sessions) {
      try {
        var dt = new DataTransfer()
        images.forEach(function (f) { dt.items.add(f) })
        setTimeout(function () {
          try {
            ;(target || document).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
          } catch (error) {
            console.error('[drop-to-path] image re-dispatch failed, uploading as paths:', error)
            enqueueFiles(images, sessions)
          }
        }, 0)
      } catch (error) {
        console.error('[drop-to-path] image re-dispatch setup failed, uploading as paths:', error)
        enqueueFiles(images, sessions)
      }
    }

    /** Intercept drops/pastes that contain folders or non-image supported files. */
    function installFileInterception(sessions) {
      var onDrop = function (event) {
        var dataTransfer = event.dataTransfer
        if (!dataTransfer) { beacon('drop-no-dt'); return }
        beacon('drop', { files: (dataTransfer.files || []).length, items: (dataTransfer.items || []).length })

        // Folder detection: DataTransferItems expose FileSystemEntry handles
        // on drop; a directory entry means the whole drop is intercepted.
        var entries = []
        if (dataTransfer.items) {
          for (var i = 0; i < dataTransfer.items.length; i++) {
            var item = dataTransfer.items[i]
            if (item.kind !== 'file') continue
            var entry = null
            try { entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null } catch (error) { entry = null }
            if (entry) entries.push(entry)
          }
        }
        var hasDirectory = entries.some(function (e) { return e && e.isDirectory })
        if (hasDirectory) {
          event.preventDefault()
          event.stopPropagation()
          var topImages = []
          // entry.file() resolves ASYNCHRONOUSLY; a plain setTimeout(0)
          // could fire first and silently drop top-level images. Count the
          // pending callbacks and re-dispatch only after every entry lands.
          var pendingEntries = entries.length
          var entryDone = function () {
            if (--pendingEntries === 0 && topImages.length > 0) {
              redispatchImages(topImages, event.target, sessions)
            }
          }
          entries.forEach(function (e) {
            if (e.isDirectory) {
              enqueueFolder(e, sessions)
              entryDone()
            } else if (e.isFile) {
              e.file(function (file) {
                if (isImageFile(file)) {
                  topImages.push(file)
                } else if (isSupportedFile(file)) {
                  enqueueFiles([file], sessions)
                } else {
                  showNotice('[dsh-drop-to-path] 不支持的文件类型: ' + file.name)
                }
                entryDone()
              }, function () { entryDone() /* unreadable entry: skip */ })
            } else {
              entryDone()
            }
          })
          // Top-level loose images still go through the native rail (once
          // every file callback above has settled — see entryDone).
          closeDropOverlayLater()
          return
        }

        var files = Array.prototype.slice.call(dataTransfer.files || [])
        var supported = files.filter(isSupportedFile)
        if (supported.length === 0) return
        var images = supported.filter(isImageFile)
        var others = supported.filter(function (f) { return !isImageFile(f) })

        // Pure-image drop: let DSH handle it natively (attachment rail,
        // overlay close, everything) — never intercept.
        if (others.length === 0) return

        // Mixed or file-only drop: intercept.
        event.preventDefault()
        event.stopPropagation()
        enqueueFiles(others, sessions)

        // Mixed drop: re-dispatch the images as a pure-image drop. The
        // pure-image rule above lets it through, so DSH builds its native
        // rail and closes the overlay itself.
        if (images.length > 0) redispatchImages(images, event.target, sessions)

        // DSH closes its full-screen drop overlay on `dragend` (window
        // listener, unconditional). Dispatch one so the overlay never stays
        // stuck when no pure-image drop reached DSH.
        closeDropOverlayLater()
      }

      var onPaste = function (event) {
        markPasteSeen()
        var clipboardData = event.clipboardData
        if (!clipboardData) { beacon('paste-no-cd'); return }
        var items = Array.prototype.slice.call(clipboardData.items || [])
        var files = Array.prototype.slice.call(clipboardData.files || [])
        beacon('paste', {
          files: files.length,
          items: items.length,
          types: items.map(function (it) { return it.kind + ':' + (it.type || '?') }).join(',').slice(0, 120),
          target: (event.target && event.target.tagName) || '?',
        })

        // Folder-like clipboard items (Explorer "copy folder"): a kind=file
        // item with empty type and a 0-byte File. Browsers normally refuse
        // to expose folder contents on paste — try entry traversal first
        // (some Chrome versions allow it), otherwise explain the workaround.
        var folderish = items.filter(function (it) {
          if (it.kind !== 'file' || it.type !== '') return false
          var f = null
          try { f = it.getAsFile() } catch (error) { f = null }
          return f !== null && f.size === 0
        })
        if (folderish.length > 0) {
          var pastedEntries = folderish.map(function (it) {
            try { return typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null } catch (error) { return null }
          }).filter(function (e) { return e !== null })
          var dirs = pastedEntries.filter(function (e) { return e.isDirectory })
          if (dirs.length > 0) {
            event.preventDefault()
            event.stopPropagation()
            dirs.forEach(function (d) { enqueueFolder(d, sessions) })
            return
          }
          event.preventDefault()
          event.stopPropagation()
          showNotice('[dsh-drop-to-path] 浏览器安全限制：剪贴板里的文件夹无法读取内容。请把文件夹直接拖入本窗口（拖入支持整个文件夹）。')
          return
        }

        var supported = files.filter(isSupportedFile)
        if (supported.length > 0) {
          // Pure image paste keeps the native flow (attachment + send conversion).
          if (supported.every(isImageFile)) {
            beacon('paste-native-images', { count: supported.length })
            return
          }
          event.preventDefault()
          event.stopPropagation()
          beacon('paste-files', { count: supported.length, names: supported.map(function (f) { return f.name }).join(',').slice(0, 120) })
          enqueueFiles(supported, sessions)
          return
        }
        if (files.length > 0 || items.length > 0) beacon('paste-unhandled', { files: files.length })

        // Last resort: images embedded in HTML clipboard (browser / WeChat
        // "copy image" puts a data-URI in text/html with no file items).
        if (files.length === 0) {
          var htmlImages = extractHtmlImages(clipboardData)
          if (htmlImages.length > 0) {
            event.preventDefault()
            event.stopPropagation()
            redispatchImages(htmlImages, event.target, sessions)
          }
        }
      }

      // Chrome only dispatches `paste` when an editable element has keyboard
      // focus. The DSH composer is LOCKED (contenteditable=false) while the
      // agent runs, and screenshot tools steal focus — in both cases Ctrl+V
      // silently produces no event at all. Strategy: (1) refocus an editable
      // composer when one exists so the native paste proceeds; (2) otherwise
      // read the clipboard directly via the Async Clipboard API and route
      // images through our own upload chips — works even while locked.
      var pasteSeenAt = 0
      var markPasteSeen = function () { pasteSeenAt = Date.now() }

      // Clipboard image cache, refreshed by the host probe on user gestures
      // (focus, mouse clicks, Ctrl+C/X/V). The right-click interception reads
      // this cache synchronously — the browser context menu cannot await.
      var clipboardCache = { ts: 0, hasImage: false }
      var probeScheduled = false
      var probeClipboardState = function () {
        if (probeScheduled) return
        probeScheduled = true
        setTimeout(function () {
          probeScheduled = false
          fetchWithTimeout(IMPORT_ROUTE + '?clipboardState=1', void 0, 8000).then(function (r) { return r.json() }).then(function (data) {
            if (data && data.ok && data.value) clipboardCache = { ts: Date.now(), hasImage: !!data.value.hasImage }
          }).catch(function () { /* probe is best-effort */ })
        }, 250)
      }

      // Mini context menu shown in place of the native one when the clipboard
      // carries an image: the native "粘贴" silently dies on CF_BITMAP (Win+V
      // history items), so we offer a path that always works.
      var imageMenuCleanup = null
      var closeImageMenu = function () {
        if (typeof imageMenuCleanup === 'function') imageMenuCleanup()
      }
      var showImageMenu = function (x, y) {
        closeImageMenu()
        closeLightbox()
        var menu = document.createElement('div')
        menu.setAttribute('data-drop-to-path-menu', '1')
        menu.style.cssText = 'position:fixed;z-index:2147483647;min-width:190px;' +
          'background:var(--dsw-alias-bg-primary,#ffffff);border:1px solid rgba(128,128,128,.25);' +
          'border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.18);padding:4px;font:13px/1.4 sans-serif'
        menu.style.left = Math.min(x, window.innerWidth - 210) + 'px'
        menu.style.top = Math.min(y, window.innerHeight - 60) + 'px'
        var item = document.createElement('button')
        item.textContent = '📋 粘贴图片到对话'
        item.style.cssText = 'display:block;width:100%;text-align:left;border:0;background:transparent;' +
          'padding:8px 10px;border-radius:6px;cursor:pointer;font:inherit;color:var(--dsw-alias-fg-primary,#222)'
        item.addEventListener('mouseenter', function () { item.style.background = 'rgba(92,108,213,.12)' })
        item.addEventListener('mouseleave', function () { item.style.background = 'transparent' })
        item.addEventListener('click', function () {
          closeImageMenu()
          readClipboardImages()
        })
        menu.appendChild(item)
        var onDocDown = function (e) { if (!menu.contains(e.target)) closeImageMenu() }
        var onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeImageMenu() } }
        setTimeout(function () { document.addEventListener('mousedown', onDocDown, true) }, 0)
        document.addEventListener('keydown', onKey, true)
        document.documentElement.appendChild(menu)
        imageMenuCleanup = function () {
          document.removeEventListener('mousedown', onDocDown, true)
          document.removeEventListener('keydown', onKey, true)
          if (menu.parentNode) menu.parentNode.removeChild(menu)
          imageMenuCleanup = null
        }
      }

      // Right-click in the composer with an image on the clipboard: replace
      // the native menu (whose paste silently fails for CF_BITMAP) with ours.
      var onContextMenu = function (event) {
        var card = findCard()
        if (!card || !card.contains(event.target)) return
        var fresh = Date.now() - clipboardCache.ts < 8000
        if (!(fresh && clipboardCache.hasImage)) return
        event.preventDefault()
        event.stopPropagation()
        beacon('contextmenu-image-menu')
        showImageMenu(event.clientX, event.clientY)
      }

      // Last resort: ask the HOST to extract a clipboard bitmap via .NET.
      // Browsers cannot consume CF_BITMAP (Win+V history panel restores only
      // carry a bitmap handle), but PowerShell/System.Drawing can read it and
      // save a PNG into .drops — returned as a ready-made chip path.
      var hostClipboardFallback = function () {
        fetchWithTimeout(IMPORT_ROUTE + '?clipboardImage=1', void 0, 20000).then(function (r) { return r.json() }).then(function (data) {
          if (data && data.ok && data.value && data.value.path) {
            beacon('clipboard-host-image', { name: data.value.name })
            addFile(data.value.path, data.value.name || 'clipboard.png')
          } else {
            beacon('clipboard-host-none', { message: data && data.error && data.error.message })
          }
        }).catch(function () { /* host unreachable: stay silent */ })
      }

      var readClipboardImages = function () {
        if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') { hostClipboardFallback(); return }
        navigator.clipboard.read().then(function (items) {
          var images = []
          var jobs = []
          items.forEach(function (item) {
            ;(item.types || []).forEach(function (type) {
              if (type.indexOf('image/') === 0) {
                jobs.push(item.getType(type).then(function (blob) {
                  images.push(blob)
                }))
              }
            })
          })
          return Promise.all(jobs).then(function () {
            if (images.length === 0) {
              // Browser sees nothing usable (e.g. CF_BITMAP-only clipboard):
              // hand over to the host extraction.
              beacon('clipboard-read-empty')
              hostClipboardFallback()
              return
            }
            var stamp = Date.now()
            var files = images.map(function (blob, i) {
              var ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
              return new File([blob], 'clipboard-' + stamp + (i > 0 ? '-' + i : '') + '.' + ext, { type: blob.type })
            })
            beacon('clipboard-read-image', { count: files.length, bytes: images.reduce(function (a, b) { return a + b.size }, 0) })
            enqueueFiles(files, null)
          })
        }).catch(function (error) {
          beacon('clipboard-read-denied', { message: String((error && error.message) || error).slice(0, 120) })
          hostClipboardFallback()
        })
      }

      var onKeydown = function (event) {
        // Keep the clipboard cache fresh on copy-ish gestures.
        if ((event.ctrlKey || event.metaKey) && !event.altKey && /^(c|x|v)$/i.test(event.key || '')) probeClipboardState()
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key !== 'v' && event.key !== 'V') return
        var target = event.target
        var editable = target && (target.isContentEditable === true || /^(INPUT|TEXTAREA)$/.test(target.tagName || ''))
        if (!editable) {
          // No editable focus (window-level paste attempt, or composer locked
          // while the agent runs): pull focus into the composer when possible
          // so a native paste can proceed.
          var el = document.querySelector('[data-input-scroll] [contenteditable="true"], [data-composer-card] [contenteditable="true"], [contenteditable="true"]')
          if (el && typeof el.focus === 'function') {
            try {
              el.focus({ preventScroll: true })
              beacon('paste-refocus')
            } catch (error) { /* focus is best-effort */ }
          }
        }
        // Give any native paste 200ms to fire. If none arrives — locked
        // composer, CF_BITMAP clipboard, or empty clipboard — take over:
        // read the clipboard directly and, when the browser sees nothing,
        // let the host extract the bitmap (Win+V history items).
        var keydownAt = Date.now()
        setTimeout(function () {
          if (pasteSeenAt >= keydownAt) return
          beacon('paste-direct-read')
          readClipboardImages()
        }, 200)
      }

      document.addEventListener('drop', onDrop, true)
      document.addEventListener('paste', onPaste, true)
      document.addEventListener('keydown', onKeydown, true)
      document.addEventListener('contextmenu', onContextMenu, true)
      document.addEventListener('mousedown', probeClipboardState, true)
      window.addEventListener('focus', probeClipboardState)
      probeClipboardState()
      beacon('listeners-installed')
      return function () {
        beacon('listeners-disposed')
        document.removeEventListener('drop', onDrop, true)
        document.removeEventListener('paste', onPaste, true)
        document.removeEventListener('keydown', onKeydown, true)
        document.removeEventListener('contextmenu', onContextMenu, true)
        document.removeEventListener('mousedown', probeClipboardState, true)
        window.removeEventListener('focus', probeClipboardState)
        closeLightbox()
        closeImageMenu()
      }
    }

    /** Wrap conversation.sendSession on the prototype: images + chips → paths.
     *  Current DSH API: sendSession(session, text, attachmentIds, mode, signal);
     *  drafts resolve via resolveDraftAttachments(ids) → { id, kind, file, ... }
     *  and are released via releaseDraftAttachment(s)(...). */
    function patchSendSession(conversation, sessions) {
      var proto = conversation.constructor && conversation.constructor.prototype
      if (!proto || typeof proto.sendSession !== 'function') return

      // Idempotent across HMR re-applies: keep the UNTOUCHED original once,
      // but ALWAYS replace the active wrapper so it closes over the live
      // module instance (fileQueue, upload, helpers). A previous apply's
      // wrapper is displaced outright — never left holding an orphaned queue.
      if (!proto[PATCH_MARK] || typeof proto[PATCH_MARK].original !== 'function') {
        proto[PATCH_MARK] = { original: proto.sendSession }
      }
      var original = proto[PATCH_MARK].original
      beacon('patch-installed', { api: 'sendSession-v2' })
      proto.sendSession = async function (session, text, attachmentIds, mode, signal) {
        // In-flight uploads first: chips materialize only when their upload
        // resolves, so a send mid-upload would silently omit those files.
        // Wait (bounded) for the enqueue chain to settle, THEN snapshot.
        if (!enqueueSettled) {
          var settled = await settleUploads(30000)
          if (!settled) {
            beacon('send-settle-timeout')
            showNotice('[dsh-drop-to-path] 仍有文件在上传，本次发送可能缺少未完成的文件')
          }
        }
        // ONE snapshot at entry: every branch below (length checks, beacon
        // counts, message tokens) must describe the SAME queue state even
        // when awaits let the user add/remove chips mid-send.
        var filePaths = fileQueue.map(function (item) { return item.path })
        var chipTokens = queuedPathTokens()
        var ids = Array.isArray(attachmentIds) ? attachmentIds.slice() : []

        // Plain text, nothing queued: behave exactly like the product.
        if (ids.length === 0 && filePaths.length === 0) {
          return original.call(this, session, text, attachmentIds, mode, signal)
        }

        // Resolve draft descriptors through the CURRENT client API. Missing
        // API or stale ids → untouched native send.
        var attachments = []
        if (ids.length > 0) {
          if (typeof this.resolveDraftAttachments !== 'function') {
            return original.call(this, session, text, attachmentIds, mode, signal)
          }
          attachments = this.resolveDraftAttachments(ids)
          if (attachments.length !== ids.length) {
            return original.call(this, session, text, attachmentIds, mode, signal)
          }
        }

        var images = attachments.filter(function (a) { return a && a.kind === 'image' })
        var keepIds = attachments
          .filter(function (a) { return !a || a.kind !== 'image' })
          .map(function (a) { return a.id })

        // Multimodal shortcut: when the session's CURRENT model accepts image
        // input (resolved with the same chain prompt admission applies —
        // picker selection → last used → deployment default), let the images
        // go natively; the model sees the real picture instead of a file
        // path. Queued chips (if any) still ride along as text paths.
        if (images.length > 0) {
          var verdict = await modelAcceptsImages(session)
          beacon('model-check', {
            images: images.length,
            accepts: verdict.accepts,
            provider: verdict.provider,
            model: verdict.model,
            source: verdict.source,
            effort: verdict.effort,
          })
          if (verdict.accepts) {
            if (filePaths.length === 0) {
              return original.call(this, session, text, attachmentIds, mode, signal)
            }
            var chipBody = chipTokens.join('\n') + (text && text.trim().length > 0 ? '\n' + text : '')
            var chipResult = await original.call(this, session, chipBody, attachmentIds, mode, signal)
            if (!(chipResult && chipResult.kind === 'error')) removeFilesByPaths(filePaths)
            return chipResult
          }
          // Text-only model: convert silently (normal operation, not an error);
          // the model-check beacon carries provider/model/source for
          // diagnostics if anyone ever needs to know why.
        }

        // Nothing to convert (file-kind drafts are natively supported by the
        // current composer): native send with the same ids.
        if (images.length === 0 && filePaths.length === 0) {
          return original.call(this, session, text, keepIds.length === ids.length ? attachmentIds : keepIds, mode, signal)
        }

        var ws = currentWorkspace(sessionsNow(), session && session.sessionId)
        var tokens = chipTokens.slice()
        try {
          for (var i = 0; i < images.length; i++) {
            var file = images[i] && images[i].file
            if (file) tokens.push(atToken((await upload(file, ws)).path))
          }
        } catch (error) {
          // Upload failed: tell the user why, then fall back to the native
          // path (the model preflight shows its usual rejection toast).
          var reason = error && error.message ? error.message : String(error)
          console.error('[drop-to-path] image upload failed, sending as attachment:', error)
          showNotice('[dsh-drop-to-path] 图片上传失败,已按原生附件发送: ' + reason)
          return original.call(this, session, text, attachmentIds, mode, signal)
        }
        if (tokens.length === 0) return original.call(this, session, text, keepIds, mode, signal)

        var lines = tokens.join('\n')
        var body = text && text.trim().length > 0 ? lines + '\n' + text : lines
        // Send through the ORIGINAL sendSession so the whole native
        // submission pipeline (local echo, host admission, attachment
        // retirement) stays intact — only the payload changes: image drafts
        // become workspace paths in the text, everything else is untouched.
        var result = await original.call(this, session, body, keepIds, mode, signal)
        if (!(result && result.kind === 'error')) {
          beacon('send-converted', { images: images.length, chips: filePaths.length })
          // Release the converted image drafts so they don't linger in the
          // composer rail after the send.
          try {
            if (images.length > 0 && typeof this.releaseDraftAttachments === 'function') {
              this.releaseDraftAttachments(images)
            } else if (images.length > 0 && typeof this.releaseDraftAttachment === 'function') {
              for (var j = 0; j < images.length; j++) this.releaseDraftAttachment(images[j].id)
            }
          } catch (error) { console.error('[drop-to-path] draft release failed:', error) }
          removeFilesByPaths(filePaths)
        }
        return result
      }
    }

    function apply(ctx) {
      liveCtx = ctx || null
      beacon('apply-start', { fix: '0.3.5' })
      try {
        var conversation = getService(ctx, 'conversation')
        var sessions = getService(ctx, 'sessions')
        var slots = getService(ctx, 'slots')

        // Core interception needs no services — always installed first.
        ctx.effect(function () { return startChipsGuard() }, 'drop-to-path: chips guard')
        ctx.effect(function () { return installFileInterception(sessions) }, 'drop-to-path: file/folder interception')

        // Visible liveness marker: a small dot pinned to the corner of the
        // page. Green = listeners active on THIS window; it pulses red when
        // the composer is locked. Lets the user identify the live window at
        // a glance and confirm the plugin survived boot.
        ctx.effect(function () {
          var dot = document.createElement('div')
          dot.setAttribute('data-drop-to-path-dot', '1')
          dot.title = 'drop-to-path 上传插件运行中'
          dot.style.cssText = 'position:fixed;right:10px;bottom:10px;width:9px;height:9px;border-radius:50%;background:#22c55e;opacity:.65;z-index:2147483647;pointer-events:none;transition:background .3s'
          document.documentElement.appendChild(dot)
          var dotTimer = setInterval(function () {
            var composer = document.querySelector('[data-input-scroll] [contenteditable], [data-composer-card] [contenteditable]')
            var locked = composer ? composer.getAttribute('contenteditable') !== 'true' : true
            dot.style.background = locked ? '#f59e0b' : '#22c55e'
            dot.title = locked ? 'drop-to-path 运行中（输入框被 agent 锁定，Ctrl+V 走直读通道）' : 'drop-to-path 上传插件运行中'
          }, 3000)
          return function () {
            clearInterval(dotTimer)
            if (dot.parentNode) dot.parentNode.removeChild(dot)
          }
        }, 'drop-to-path: liveness dot')

        // Liveness probe: heartbeat every 15s proves the module (and its
        // listeners) survived boot; a stop means the fiber was disposed.
        var beats = 0
        var heartbeat = setInterval(function () {
          beats += 1
          var composer = document.querySelector('[data-input-scroll] [contenteditable], [data-composer-card] [contenteditable]')
          beacon('alive', {
            beat: beats,
            chips: fileQueue.length,
            composer: composer ? composer.getAttribute('contenteditable') : 'absent',
          })
          if (beats >= 20) clearInterval(heartbeat)
        }, 15000)
        ctx.effect(function () { return function () { clearInterval(heartbeat); beacon('heartbeat-disposed') } }, 'drop-to-path: heartbeat')

        // sendSession patch: install immediately when the service is up,
        // otherwise poll briefly (boot order may place us before it).
        var installPatch = function () {
          var conv = getService(ctx, 'conversation')
          if (conv && typeof conv.sendSession === 'function') {
            patchSendSession(conv, getService(ctx, 'sessions'))
            return true
          }
          return false
        }
        if (!installPatch()) {
          var tries = 0
          var patchTimer = setInterval(function () {
            tries += 1
            if (installPatch() || tries >= 60) {
              clearInterval(patchTimer)
              beacon('patch-poll-end', { installed: tries < 60 || void 0, tries: tries })
            }
          }, 1000)
          ctx.effect(function () { return function () { clearInterval(patchTimer) } }, 'drop-to-path: patch poll')
        }

        // Register one invisible slot component: the plugin contributes no
        // visible UI, but the runtime expects every injected client plugin to
        // hold a legitimate slot registration (injector contract).
        if (slots && typeof slots.inject === 'function') {
          try {
            ctx.effect(function () {
              return slots.inject('conversation.composer.dock', function () {
                return slots.register({
                  name: 'conversation.composer.dock',
                  id: '@dsh-external/dsh-drop-to-path-dock',
                  label: function () { return 'drop-to-path' },
                  component: function () {
                    return {
                      render: function () {
                        var el = document.createElement('div')
                        el.style.display = 'none'
                        el.setAttribute('data-drop-to-path-dock', '1')
                        return el
                      },
                    }
                  },
                })
              })
            }, 'drop-to-path: dock')
          } catch (error) { /* slot contract is best-effort; interception still works */ }
        }

        beacon('apply-ok', {
          fix: '0.3.5',
          conversation: conversation !== void 0 && conversation !== null,
          sessions: sessions !== void 0 && sessions !== null,
          slots: slots !== void 0 && slots !== null,
        })
      } catch (error) {
        beacon('apply-error', { message: String((error && error.message) || error).slice(0, 200) })
        throw error
      }
    }

    exports.inject = []
    exports.apply = apply
    return module.exports
  },
})
