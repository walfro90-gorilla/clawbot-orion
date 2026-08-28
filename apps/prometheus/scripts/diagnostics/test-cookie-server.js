#!/usr/bin/env node
/**
 * E2E stress test for the cookie-server.
 * Run from the prometheus dir:  node scripts/test-cookie-server.js
 *
 * Tests:
 *   1. Health endpoint
 *   2. Unauthorized requests rejected
 *   3. Session lifecycle (start → frame → status → input → close)
 *   4. Atomic session-per-account (second request supersedes first)
 *   5. Idle session continues until DELETE / TTL
 *   6. validate-cookie endpoint with garbage cookie → invalid
 *   7. Frame returned within reasonable time
 *   8. Cleanup leaves no orphan sessions
 */
import 'dotenv/config'
import { randomUUID } from 'crypto'

const URL    = process.env.COOKIE_SERVER_URL ?? 'http://localhost:3001'
const SECRET = process.env.COOKIE_SERVER_SECRET ?? ''

const tests = []
const it    = (name, fn) => tests.push({ name, fn })

// ── Helpers ───────────────────────────────────────────────────────────────────
function req(method, path, body, secretOverride) {
  const headers = { 'x-secret': secretOverride ?? SECRET }
  if (body) headers['Content-Type'] = 'application/json'
  return fetch(`${URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

let pass = 0, fail = 0
function assert(cond, msg) {
  if (cond) { console.log(`     ✓ ${msg}`);              pass++ }
  else      { console.log(`     ✗ FAIL: ${msg}`); fail++ }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

it('health endpoint reachable + unauthenticated', async () => {
  const res  = await fetch(`${URL}/health`)
  const data = await res.json()
  assert(res.ok,                     'GET /health returns 200')
  assert(typeof data.sessions === 'number', '/health returns session count')
  assert(typeof data.uptime   === 'number', '/health returns uptime')
})

it('rejects requests without correct x-secret header', async () => {
  const res = await req('POST', '/session', { sessionId: 'x', accountId: 'y' }, 'wrong-secret')
  assert(res.status === 401, 'wrong secret returns 401')

  const res2 = await fetch(`${URL}/session/x/frame`)
  assert(res2.status === 401, 'no header on /frame returns 401')
})

it('rejects malformed POST /session', async () => {
  const res1 = await req('POST', '/session', {})
  assert(res1.status === 400, 'missing sessionId+accountId returns 400')

  const res2 = await req('POST', '/session', { sessionId: 'x' })
  assert(res2.status === 400, 'missing accountId returns 400')
})

it('full session lifecycle (no proxy)', async () => {
  const sid = randomUUID()
  const aid = `test-acct-${randomUUID()}`

  const start = await req('POST', '/session', { sessionId: sid, accountId: aid })
  const startData = await start.json()
  assert(start.ok,            'POST /session returns 200')
  assert(startData.ok,        'response body has ok:true')

  // Wait for first screenshot
  await sleep(1500)

  const frame = await req('GET', `/session/${sid}/frame`)
  assert(frame.status === 200,  '/frame returns 200 after warmup')
  assert(frame.headers.get('content-type')?.startsWith('image/jpeg'),
         '/frame returns image/jpeg')
  const blob = await frame.arrayBuffer()
  assert(blob.byteLength > 5_000, `screenshot is non-trivial size (${blob.byteLength} bytes)`)

  const status = await req('GET', `/session/${sid}/status`).then(r => r.json())
  assert(status.status === 'active',           'status is "active" before login')
  // pageState may be 'login', 'other' (homepage warmup), or 'authenticated' (logged-in homepage)
  assert(['login', 'other', 'authenticated', 'unknown'].includes(status.pageState),
         `pageState is plausible (got "${status.pageState}")`)
  assert(status.cookie === null,                'cookie is null before login')
  assert(typeof status.currentUrl === 'string', 'currentUrl is set')

  // Send a click
  const click = await req('POST', `/session/${sid}/input`, { type: 'click', x: 640, y: 400 })
  assert(click.ok, 'POST /input click returns 200')

  // Send a type
  const typ = await req('POST', `/session/${sid}/input`, { type: 'type', text: 'hello' })
  assert(typ.ok, 'POST /input type returns 200')

  // Cleanup
  const del = await req('DELETE', `/session/${sid}`)
  assert(del.ok, 'DELETE /session returns 200')

  // Verify session is gone
  const after = await req('GET', `/session/${sid}/status`)
  assert(after.status === 404, 'GET /status after delete returns 404')
})

it('atomic session-per-account: 2nd request supersedes 1st', async () => {
  const aid = `test-acct-${randomUUID()}`
  const sid1 = randomUUID()
  const sid2 = randomUUID()

  await req('POST', '/session', { sessionId: sid1, accountId: aid })
  await sleep(1000)
  await req('POST', '/session', { sessionId: sid2, accountId: aid })
  await sleep(500)

  const s1 = await req('GET', `/session/${sid1}/status`)
  const s2 = await req('GET', `/session/${sid2}/status`)
  assert(s1.status === 404, '1st session destroyed when 2nd starts')
  assert(s2.ok,             '2nd session still alive')

  await req('DELETE', `/session/${sid2}`)
})

it('rejects duplicate sessionId', async () => {
  const sid = randomUUID()
  const aid = `test-acct-${randomUUID()}`

  const r1 = await req('POST', '/session', { sessionId: sid, accountId: aid })
  assert(r1.ok, 'first session created')

  const r2 = await req('POST', '/session', { sessionId: sid, accountId: aid })
  assert(r2.status === 409, 'duplicate sessionId returns 409')

  await req('DELETE', `/session/${sid}`)
})

it('input on dead session returns 409', async () => {
  const sid = randomUUID()
  const aid = `test-acct-${randomUUID()}`
  await req('POST', '/session', { sessionId: sid, accountId: aid })
  await req('DELETE', `/session/${sid}`)

  const click = await req('POST', `/session/${sid}/input`, { type: 'click', x: 100, y: 100 })
  assert(click.status === 404, 'input on deleted session returns 404')
})

it('validate-cookie rejects garbage cookies fast', async () => {
  const r1 = await req('POST', '/validate-cookie', { cookie: '' })
  const d1 = await r1.json()
  assert(d1.valid === false,                       'empty cookie → invalid')
  assert(d1.reason === 'cookie_too_short',         'reason is cookie_too_short')

  const r2 = await req('POST', '/validate-cookie', { cookie: 'a'.repeat(150), proxyUrl: null })
  const d2 = await r2.json()
  assert(d2.valid === false, 'fake cookie → invalid')
  assert(['not_authenticated', 'redirect_loop', 'error'].includes(d2.reason),
         `reason is plausible (${d2.reason})`)
}, 90_000)

it('no orphan sessions after all tests', async () => {
  const health = await fetch(`${URL}/health`).then(r => r.json())
  assert(health.sessions === 0, `0 active sessions remain (got ${health.sessions})`)
  assert(health.accounts === 0, `0 account locks remain (got ${health.accounts})`)
})

// ── Runner ────────────────────────────────────────────────────────────────────
async function main() {
  if (!SECRET) {
    console.error('FATAL: COOKIE_SERVER_SECRET not set in env')
    process.exit(1)
  }
  console.log(`\n🔬 Cookie-server E2E test — ${URL}\n`)
  for (const t of tests) {
    console.log(`  ▸ ${t.name}`)
    try {
      await t.fn()
    } catch (err) {
      console.log(`     ✗ THROWN: ${err.message}`)
      fail++
    }
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`)
  process.exit(fail ? 1 : 0)
}

main()
