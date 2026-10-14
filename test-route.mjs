// Offline sanity checks for the import route's Content-Type gate (run with: node test-route.mjs)
// The 0.3.6 local-origin guard (requestAuthorized) was removed so the route
// answers LAN pages behind a login gate; these assertions cover what remains.

let failed = 0
const check = (name, actual, expected) => {
  const ok = actual === expected
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (got ${actual}, want ${expected})`)
}

// Content-Type gate regex (same as route)
const ct = /^application\/json\b/i
check('CT json', ct.test('application/json'), true)
check('CT json+charset', ct.test('application/json; charset=utf-8'), true)
check('CT text/plain (CSRF vector)', ct.test('text/plain'), false)
check('CT multipart', ct.test('multipart/form-data'), false)

if (failed > 0) { console.error(`${failed} checks failed`); process.exit(1) }
console.log('all checks passed')
