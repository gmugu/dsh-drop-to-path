// Offline sanity checks for the 0.3.6 route hardening (run with: node test-route.mjs)
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('lib/index.js', import.meta.url), 'utf8')

// Extract requestAuthorized verbatim from the source and eval it in isolation.
const fnMatch = src.match(/function requestAuthorized\(req\) \{[\s\S]*?\n\}/)
if (!fnMatch) throw new Error('requestAuthorized not found')
const requestAuthorized = new Function('req', fnMatch[0] + '; return requestAuthorized(req)')

let failed = 0
const check = (name, actual, expected) => {
  const ok = actual === expected
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (got ${actual}, want ${expected})`)
}

// Happy paths — the GUI itself
check('GUI GET 127.0.0.1', requestAuthorized({ headers: { host: '127.0.0.1:3080' } }), true)
check('GUI GET localhost', requestAuthorized({ headers: { host: 'localhost:3080' } }), true)
check('GUI GET [::1]', requestAuthorized({ headers: { host: '[::1]:3080' } }), true)
check('same-origin POST Origin matches', requestAuthorized({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }), true)
check('no host header', requestAuthorized({ headers: {} }), false)

// Attack paths
check('evil-site Origin mismatch', requestAuthorized({ headers: { host: '127.0.0.1:3080', origin: 'https://evil.com' } }), false)
check('null Origin (sandboxed)', requestAuthorized({ headers: { host: '127.0.0.1:3080', origin: 'null' } }), false)
check('DNS rebinding Host', requestAuthorized({ headers: { host: 'evil.com:3080', origin: 'http://evil.com:3080' } }), false)
check('Origin host-decoy', requestAuthorized({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.com:3080' } }), false)
check('LAN Host', requestAuthorized({ headers: { host: '192.168.1.5:3080' } }), false)

// Content-Type gate regex (same as route)
const ct = /^application\/json\b/i
check('CT json', ct.test('application/json'), true)
check('CT json+charset', ct.test('application/json; charset=utf-8'), true)
check('CT text/plain (CSRF vector)', ct.test('text/plain'), false)
check('CT multipart', ct.test('multipart/form-data'), false)

if (failed > 0) { console.error(`${failed} checks failed`); process.exit(1) }
console.log('all checks passed')
