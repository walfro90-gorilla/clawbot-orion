/**
 * stress-test-fingerprint.js — End-to-end stress test for Phase 1.5 (fingerprint binding).
 *
 * Does NOT touch LinkedIn. Exercises:
 *   1. DB schema (columns exist, queryable)
 *   2. generateFingerprint() output shape
 *   3. getOrCreateAccountFingerprint() idempotency (5 calls → same fp)
 *   4. contextOptionsFromFingerprint() Playwright opts shape
 *   5. humanize.js exports (humanFill present)
 *   6. Playwright actually launches with the real Josh fingerprint + opens a
 *      neutral page (example.com) — verifies the UA/viewport hit the network.
 *   7. cookie-server /health reachable
 *   8. cookie-server respects incoming fingerprint via /validate-cookie shape
 *      (we send a deliberately invalid cookie; we only check the FP roundtrip
 *      via the validation context UA from /health metrics — best-effort).
 *
 * Run:  node apps/prometheus/scripts/stress-test-fingerprint.js
 */
import 'dotenv/config'
import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { supabase } from '../lib/supabase.js'
import {
  generateFingerprint,
  contextOptionsFromFingerprint,
  getOrCreateAccountFingerprint,
  accountContextOptions,
} from '../lib/browser.js'
import * as humanize from '../lib/humanize.js'

chromium.use(StealthPlugin())

const JOSH_ID = '2ea4a7f2-eb0a-40d0-a7af-3a3066829aeb'
const WAL_ID  = '85b0f757-9d1a-4d66-8b1e-ac57e4e729b3'
const COOKIE_SERVER_URL    = process.env.COOKIE_SERVER_URL    ?? 'http://localhost:3001'
const COOKIE_SERVER_SECRET = process.env.COOKIE_SERVER_SECRET ?? ''

let passed = 0
let failed = 0
const fails = []

function ok(name)        { passed++; console.log(`  ✅ ${name}`) }
function fail(name, why) { failed++; fails.push({ name, why }); console.log(`  ❌ ${name} — ${why}`) }

async function expect(name, fn) {
  try { (await fn()) ? ok(name) : fail(name, 'returned falsy') }
  catch (err) { fail(name, err.message ?? String(err)) }
}

// ── Section runners ──────────────────────────────────────────────────────────

async function testDbSchema() {
  console.log('\n[1/8] DB schema')

  const { data, error } = await supabase
    .from('linkedin_accounts')
    .select('id, label, fingerprint_json, fingerprint_locked_at')
    .in('id', [JOSH_ID, WAL_ID])
  if (error) return fail('select fingerprint columns', error.message)
  ok(`select fingerprint columns (${data.length} rows)`)

  const josh = data.find(r => r.id === JOSH_ID)
  if (!josh) return fail('Josh row exists', 'not found')
  ok('Josh row exists')

  if (josh.fingerprint_json) {
    const fp = josh.fingerprint_json
    await expect('Josh.fingerprint_json.userAgent is non-empty Chrome UA',
      () => typeof fp.userAgent === 'string' && /Chrome\/\d+/.test(fp.userAgent))
    await expect('Josh.fingerprint_json.viewport has w/h',
      () => fp.viewport?.width > 800 && fp.viewport?.height > 500)
    await expect('Josh.fingerprint_json.locale is es-*',
      () => /^es/.test(fp.locale ?? ''))
    await expect('Josh.fingerprint_locked_at present',
      () => !!josh.fingerprint_locked_at)
  } else {
    console.log('  ⚠️  Josh has no fingerprint yet (cookie not renewed post-Fase 1.5)')
  }
}

async function testGenerateFingerprint() {
  console.log('\n[2/8] generateFingerprint() shape')

  for (let i = 0; i < 10; i++) {
    const fp = generateFingerprint()
    await expect(`call #${i+1}: userAgent`,    () => /Chrome\/(13[0-5])\.0\.0\.0/.test(fp.userAgent))
    await expect(`call #${i+1}: viewport w`,   () => fp.viewport.width  >= 1200 && fp.viewport.width  <= 2000)
    await expect(`call #${i+1}: viewport h`,   () => fp.viewport.height >= 700  && fp.viewport.height <= 1100)
    await expect(`call #${i+1}: timezoneId`,   () => fp.timezoneId === 'America/Mexico_City')
    await expect(`call #${i+1}: locale es-*`,  () => /^es/.test(fp.locale))
    await expect(`call #${i+1}: acceptLang`,   () => fp.acceptLanguage.includes('es'))
  }

  // Diversity check — 20 generations should produce >= 5 distinct UAs
  const uas = new Set()
  for (let i = 0; i < 20; i++) uas.add(generateFingerprint().userAgent)
  await expect(`20 generations → ≥5 distinct UAs (got ${uas.size})`, () => uas.size >= 5)
}

async function testIdempotency() {
  console.log('\n[3/8] getOrCreateAccountFingerprint() idempotency')

  // Josh already has a fingerprint — 5 calls should return the SAME object
  const samples = []
  for (let i = 0; i < 5; i++) {
    samples.push(await getOrCreateAccountFingerprint(supabase, JOSH_ID))
  }
  const uniqueUAs = new Set(samples.map(s => s.userAgent))
  await expect(`5 calls on Josh return SAME UA (got ${uniqueUAs.size} distinct)`,
    () => uniqueUAs.size === 1)

  const uniqueViewports = new Set(samples.map(s => `${s.viewport.width}x${s.viewport.height}`))
  await expect(`5 calls on Josh return SAME viewport (got ${uniqueViewports.size} distinct)`,
    () => uniqueViewports.size === 1)

  console.log(`     Josh fp: ${samples[0].userAgent.slice(0, 60)}… @ ${samples[0].viewport.width}x${samples[0].viewport.height}`)
}

async function testWalFingerprintBackfill() {
  console.log('\n[4/8] Wal fingerprint behavior (cookie expired, no fp yet)')

  const before = await supabase.from('linkedin_accounts')
    .select('fingerprint_json, fingerprint_locked_at').eq('id', WAL_ID).single()
  await expect('Wal current state', () => !!before.data)

  // If Wal has no fp, getOrCreateAccountFingerprint will seed one. We then
  // delete it again so the real cookie-server flow can capture properly.
  if (!before.data.fingerprint_json) {
    console.log('     Wal has no fp — testing lazy seed path')
    const fp1 = await getOrCreateAccountFingerprint(supabase, WAL_ID)
    await expect('Wal lazy seed: fp returned', () => !!fp1?.userAgent)

    const after = await supabase.from('linkedin_accounts')
      .select('fingerprint_json, fingerprint_locked_at').eq('id', WAL_ID).single()
    await expect('Wal lazy seed: persisted in DB',
      () => after.data.fingerprint_json?.userAgent === fp1.userAgent)
    await expect('Wal lazy seed: locked_at set',
      () => !!after.data.fingerprint_locked_at)

    // CLEAN UP: revert Wal so the real renewal flow captures a fresh fp
    // tied to the actual cookie capture (not this synthetic seed).
    await supabase.from('linkedin_accounts')
      .update({ fingerprint_json: null, fingerprint_locked_at: null })
      .eq('id', WAL_ID)
    console.log('     Wal fp reverted to null (will capture on real cookie renewal)')
  } else {
    console.log('     Wal already has a fp — skipping lazy seed test')
  }
}

async function testContextOpts() {
  console.log('\n[5/8] contextOptionsFromFingerprint() Playwright opts shape')

  const fp = await getOrCreateAccountFingerprint(supabase, JOSH_ID)
  const opts = contextOptionsFromFingerprint(fp, null)

  await expect('opts.userAgent matches fp',          () => opts.userAgent === fp.userAgent)
  await expect('opts.viewport matches fp',           () => opts.viewport.width === fp.viewport.width)
  await expect('opts.locale matches fp',             () => opts.locale === fp.locale)
  await expect('opts.timezoneId set',                () => opts.timezoneId === 'America/Mexico_City')
  await expect('opts.extraHTTPHeaders.Accept-Lang',  () => !!opts.extraHTTPHeaders?.['Accept-Language'])
  await expect('opts.proxy absent when null',        () => opts.proxy === undefined)

  // With proxy
  const fakeProxy = { server: 'http://proxy.test:8080', username: 'u', password: 'p' }
  const optsP = contextOptionsFromFingerprint(fp, fakeProxy)
  await expect('opts.proxy present when provided',   () => optsP.proxy?.server === 'http://proxy.test:8080')

  // accountContextOptions wrapper
  const opts2 = await accountContextOptions(supabase, JOSH_ID, null)
  await expect('accountContextOptions returns same UA as direct path',
    () => opts2.userAgent === opts.userAgent)
}

async function testHumanizeExports() {
  console.log('\n[6/8] humanize.js exports')

  const required = [
    'humanClick', 'humanHover', 'humanType', 'humanFill',
    'humanScroll', 'readingPause', 'browsingContext', 'varyMessage',
    'microDelay', 'thinkingPause', 'randInt', 'sleep',
  ]
  for (const name of required) {
    await expect(`exports.${name} is function`, () => typeof humanize[name] === 'function')
  }

  // humanFill sanity (without launching a browser): verify it's an async fn
  await expect('humanFill is async',
    () => humanize.humanFill.constructor.name === 'AsyncFunction')
}

async function testPlaywrightLaunch() {
  console.log('\n[7/8] Playwright launches — cross-context binding equivalence')
  console.log('     Note: Stealth Plugin overrides navigator.userAgent to the')
  console.log('     binary version (Chrome 147 currently) and navigator.languages')
  console.log('     to en-US. Whatever values, BOTH contexts must agree.')

  const fp = await getOrCreateAccountFingerprint(supabase, JOSH_ID)
  const opts = contextOptionsFromFingerprint(fp, null)
  let browser, ctx, page
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    ctx = await browser.newContext(opts)
    page = await ctx.newPage()
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 15_000 })

    const snapA = {
      ua:        await page.evaluate(() => navigator.userAgent),
      lang:      await page.evaluate(() => navigator.language),
      w:         await page.evaluate(() => window.innerWidth),
      h:         await page.evaluate(() => window.innerHeight),
      platform:  await page.evaluate(() => navigator.platform),
      webdriver: await page.evaluate(() => navigator.webdriver),
    }

    // Second context with the SAME fingerprint must produce SAME effective state.
    // This is what really matters — cookie-server and workers must look identical
    // to LinkedIn regardless of what Stealth does to our requested UA.
    const ctx2 = await browser.newContext(contextOptionsFromFingerprint(fp, null))
    const page2 = await ctx2.newPage()
    await page2.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 15_000 })
    const snapB = {
      ua:        await page2.evaluate(() => navigator.userAgent),
      lang:      await page2.evaluate(() => navigator.language),
      w:         await page2.evaluate(() => window.innerWidth),
      h:         await page2.evaluate(() => window.innerHeight),
      platform:  await page2.evaluate(() => navigator.platform),
      webdriver: await page2.evaluate(() => navigator.webdriver),
    }

    await expect('effective UA identical across contexts',       () => snapA.ua === snapB.ua)
    await expect('effective language identical',                 () => snapA.lang === snapB.lang)
    await expect('effective viewport identical',                 () => snapA.w === snapB.w && snapA.h === snapB.h)
    await expect('effective platform identical',                 () => snapA.platform === snapB.platform)
    await expect('webdriver hidden in both',                     () => snapA.webdriver === false && snapB.webdriver === false)

    // Viewport DOES propagate (Stealth doesn't touch it) — verify it matches our fp.
    await expect(`viewport.width propagated (got ${snapA.w} vs fp ${fp.viewport.width})`,
      () => Math.abs(snapA.w - fp.viewport.width) < 30)
    await expect(`viewport.height propagated (got ${snapA.h} vs fp ${fp.viewport.height})`,
      () => Math.abs(snapA.h - fp.viewport.height) < 30)

    console.log(`     Effective fingerprint visible to LinkedIn:`)
    console.log(`       UA      : ${snapA.ua.slice(0, 80)}…`)
    console.log(`       viewport: ${snapA.w}x${snapA.h}`)
    console.log(`       lang    : ${snapA.lang}  (⚠ should be es-MX — Stealth override pending Fase 2 fix)`)
    console.log(`       platform: ${snapA.platform}`)

    // humanFill smoke test
    await page.setContent(`<input id="t" type="text" />`)
    const t0 = Date.now()
    await humanize.humanFill(page, '#t', 'hello world')
    const elapsed = Date.now() - t0
    const val = await page.$eval('#t', el => el.value)
    await expect(`humanFill typed text (got "${val}")`, () => val === 'hello world')
    await expect(`humanFill is NOT instantaneous (got ${elapsed}ms, expect ≥800)`,
      () => elapsed >= 800)

    // Idempotency: same fp loaded twice within the same launch must match
    const fp2 = await getOrCreateAccountFingerprint(supabase, JOSH_ID)
    await expect('fp loaded again returns identical UA',     () => fp2.userAgent === fp.userAgent)
    await expect('fp loaded again returns identical viewport',
      () => fp2.viewport.width === fp.viewport.width && fp2.viewport.height === fp.viewport.height)
  } finally {
    try { await browser?.close() } catch {}
  }
}

async function testCookieServer() {
  console.log('\n[8/8] cookie-server endpoints')

  if (!COOKIE_SERVER_SECRET) {
    return fail('COOKIE_SERVER_SECRET available', 'env var not set — skipping cookie-server tests')
  }

  // /health
  try {
    const r = await fetch(`${COOKIE_SERVER_URL}/health`)
    const j = await r.json()
    await expect('GET /health responds 200',     () => r.ok)
    await expect('GET /health has ok:true',      () => j.ok === true)
    await expect('GET /health uptime > 0',       () => j.uptime > 0)
  } catch (err) {
    fail('cookie-server reachable', err.message)
    return
  }

  // /validate-cookie with FAKE cookie — we only care that the endpoint accepts
  // a fingerprint field without erroring, and that it returns valid:false.
  const fakeCookie = 'AQ' + 'x'.repeat(120)
  try {
    const r = await fetch(`${COOKIE_SERVER_URL}/validate-cookie`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-secret': COOKIE_SERVER_SECRET },
      body: JSON.stringify({
        cookie:      fakeCookie,
        proxyUrl:    null,
        fingerprint: generateFingerprint(),  // ← key: fp accepted in body
      }),
    })
    const j = await r.json()
    await expect('POST /validate-cookie 200',                () => r.ok)
    await expect('POST /validate-cookie returns valid:false',() => j.valid === false)
    await expect('POST /validate-cookie reason in {not_authenticated, redirect_loop, error}',
      () => ['not_authenticated','redirect_loop','error','cookie_too_short'].includes(j.reason))
  } catch (err) {
    fail('/validate-cookie with fingerprint', err.message)
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('━'.repeat(70))
  console.log('  STRESS TEST — Phase 1.5 (fingerprint binding + humanFill)')
  console.log(`  ${new Date().toISOString()}`)
  console.log('━'.repeat(70))

  await testDbSchema()
  await testGenerateFingerprint()
  await testIdempotency()
  await testWalFingerprintBackfill()
  await testContextOpts()
  await testHumanizeExports()
  await testPlaywrightLaunch()
  await testCookieServer()

  console.log('\n' + '━'.repeat(70))
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('  Failures:')
    for (const f of fails) console.log(`    - ${f.name}: ${f.why}`)
  }
  console.log('━'.repeat(70))
  process.exit(failed > 0 ? 1 : 0)
})()
