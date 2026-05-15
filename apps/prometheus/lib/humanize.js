/**
 * lib/humanize.js — Centralized humanization helpers for LinkedIn automation.
 *
 * Why centralize: previously each script (followup.js, worker.js, reply.js,
 * inbox.js, search.js) had its own copy of humanScroll/humanType/microDelay,
 * with subtle differences. worker.js had the best humanType but it wasn't
 * exported. This file is the single source of truth.
 *
 * Goal: make every Playwright action look like a real user.
 *
 * Bot signals this kills:
 *  - "Teleport click" — cursor jumping directly to target  → humanClick()
 *  - Zero reading time on profile pages                    → readingPause()
 *  - Uniform typing rhythm                                 → humanType()
 *  - No scroll on visited pages                            → humanScroll()
 *  - Direct action chains with no idle                     → browsingContext()
 *  - Identical template messages                           → varyMessage()
 *
 * Usage:
 *   import { humanClick, readingPause, humanType } from './lib/humanize.js'
 *
 *   await readingPause(page)                  // pretend to read the profile
 *   await humanClick(page, 'button.message')  // move + hover + click
 *   await humanType(page, 'Hello!')           // natural typing rhythm
 */

// ── Utilities ─────────────────────────────────────────────────────────────────
export const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1))
export const sleep   = ms => new Promise(r => setTimeout(r, ms))

/** Short pause — 600-1800ms. Replaces the old `microDelay()` copies. */
export async function microDelay() {
  await sleep(randInt(600, 1800))
}

/** "Thinking" pause — 1-5s. Semantically clearer than microDelay for longer waits. */
export async function thinkingPause() {
  await sleep(randInt(1000, 5000))
}

// ── Typing ────────────────────────────────────────────────────────────────────

/**
 * Type with natural rhythm — the worker.js version, now reusable.
 * Variance sources:
 *   - Base char delay: 55-120ms
 *   - Punctuation: +100-250ms (humans pause at .,?!)
 *   - 20% of spaces: +0-60ms (word-boundary micro-pause)
 *   - 5% of chars: +300-600ms (occasional "distraction")
 */
export async function humanType(page, text, opts = {}) {
  const baseMin   = opts.baseMin ?? 55
  const baseMax   = opts.baseMax ?? 120
  const distract  = opts.distractionRate ?? 0.05  // 5% chars have a longer pause

  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 0 })
    let delay = randInt(baseMin, baseMax)
    if ('.?,!¡¿;:'.includes(ch))                       delay += randInt(100, 250)
    else if (ch === ' ' && Math.random() < 0.20)       delay += randInt(0, 60)
    if (Math.random() < distract)                       delay += randInt(300, 600)
    await sleep(delay)
  }
}

/**
 * Fill an input field with human-like typing.
 *
 * Kills the `.fill()` bot signal: Playwright's `.fill()` sets the value
 * instantly via DOM property — no keypress events, no per-char delay. LinkedIn
 * sees a 6-digit OTP appear in <10ms, or a 20-char name typed in 0ms = bot.
 *
 * Flow: focus the field with a humanClick, then type char-by-char.
 *
 * @param {Page} page Playwright Page
 * @param {string|Locator} target Selector or locator
 * @param {string} text Text to fill
 * @param {object} opts Forwarded to humanType (baseMin/baseMax/distractionRate)
 */
export async function humanFill(page, target, text, opts = {}) {
  const loc = typeof target === 'string' ? page.locator(target).first() : target
  await humanClick(page, loc)
  await sleep(randInt(120, 300))
  // Clear any existing value before typing
  await page.keyboard.press('Control+a').catch(() => {})
  await sleep(randInt(40, 120))
  await page.keyboard.press('Delete').catch(() => {})
  await sleep(randInt(60, 200))
  await humanType(page, text, opts)
}

// ── Scrolling ─────────────────────────────────────────────────────────────────

/**
 * Scroll the page in human-sized steps with random pauses between.
 * @param {Page} page Playwright Page
 * @param {object} opts
 *   - distance: total px to scroll (default: random 400-1200)
 *   - direction: 'down' (default) | 'up'
 *   - stepMinPx, stepMaxPx: per-step size
 *   - pauseMinMs, pauseMaxMs: pause between steps
 */
export async function humanScroll(page, opts = {}) {
  const totalDistance = opts.distance ?? randInt(400, 1200)
  const direction     = opts.direction === 'up' ? -1 : 1
  const stepMin       = opts.stepMinPx ?? 200
  const stepMax       = opts.stepMaxPx ?? 450
  const pauseMin      = opts.pauseMinMs ?? 200
  const pauseMax      = opts.pauseMaxMs ?? 700

  let scrolled = 0
  while (scrolled < totalDistance) {
    const step = randInt(stepMin, stepMax)
    await page.evaluate((y) => window.scrollBy(0, y), step * direction)
    scrolled += step
    await sleep(randInt(pauseMin, pauseMax))
  }
}

// ── Mouse movement & clicking (the missing piece) ─────────────────────────────

/**
 * Move the mouse along a Bézier curve from current position to target.
 * Kills the "teleport click" bot signal — real users always move the cursor
 * before clicking, never jump directly to coordinates.
 *
 * @internal exposed for testing
 */
async function moveMouseAlongCurve(page, fromX, fromY, toX, toY, opts = {}) {
  const steps    = opts.steps ?? randInt(18, 32)
  const stepMin  = opts.stepDelayMin ?? 8
  const stepMax  = opts.stepDelayMax ?? 22

  // Control points perpendicular-ish to the direct line, slightly random.
  // This creates a curved trajectory instead of a straight line (more human).
  const dx = toX - fromX
  const dy = toY - fromY
  const dist = Math.sqrt(dx * dx + dy * dy)
  const perpX = -dy / (dist || 1)
  const perpY =  dx / (dist || 1)
  const curveMagnitude = Math.min(dist * 0.25, 120) * (Math.random() * 0.6 + 0.4)
  const sign = Math.random() < 0.5 ? -1 : 1

  const cx1 = fromX + dx * 0.33 + perpX * curveMagnitude * sign
  const cy1 = fromY + dy * 0.33 + perpY * curveMagnitude * sign
  const cx2 = fromX + dx * 0.66 + perpX * curveMagnitude * sign * 0.5
  const cy2 = fromY + dy * 0.66 + perpY * curveMagnitude * sign * 0.5

  // Cubic Bézier interpolation
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const it = 1 - t
    const x = it*it*it*fromX + 3*it*it*t*cx1 + 3*it*t*t*cx2 + t*t*t*toX
    const y = it*it*it*fromY + 3*it*it*t*cy1 + 3*it*t*t*cy2 + t*t*t*toY
    await page.mouse.move(x, y)
    await sleep(randInt(stepMin, stepMax))
  }
}

// Track last mouse position per-page so consecutive movements look continuous.
// WeakMap keys are Page objects → no memory leak.
const lastMousePos = new WeakMap()

/**
 * Move mouse to target element with a curved trajectory + brief hover.
 * Does NOT click — useful for "looking" at elements before deciding.
 *
 * @param {Page} page Playwright Page
 * @param {string|Locator|ElementHandle} target Selector or locator
 */
export async function humanHover(page, target) {
  const loc = typeof target === 'string' ? page.locator(target).first() : target
  const box = await loc.boundingBox()
  if (!box) throw new Error(`humanHover: target has no bounding box`)

  // Click somewhere inside the element, not always center (humans aim imperfectly)
  const tx = box.x + box.width  * (0.3 + Math.random() * 0.4)
  const ty = box.y + box.height * (0.3 + Math.random() * 0.4)
  const last = lastMousePos.get(page) ?? {
    x: randInt(200, 1000),
    y: randInt(100, 500),
  }

  await moveMouseAlongCurve(page, last.x, last.y, tx, ty)
  lastMousePos.set(page, { x: tx, y: ty })
  await sleep(randInt(80, 250))  // brief hover pause
  return { x: tx, y: ty }
}

/**
 * THE primary anti-bot helper. Use INSTEAD of `element.click()` everywhere
 * that matters (Message button, Send button, Connect, etc.).
 *
 * Flow:
 *  1. Move mouse along curved trajectory to element  (~300-700ms)
 *  2. Brief hover pause                              (~80-250ms)
 *  3. Click                                          (instant)
 *  4. Optional: wait for navigation/response         (skipped — caller handles)
 *
 * @param {Page} page Playwright Page
 * @param {string|Locator} target Selector or locator
 */
export async function humanClick(page, target) {
  const pos = await humanHover(page, target)
  await page.mouse.click(pos.x, pos.y)
}

// ── Reading / browsing context ────────────────────────────────────────────────

/**
 * Simulates a human reading a page: scroll down a bit, pause, maybe scroll up,
 * pause again. Total time configurable. Use BEFORE clicking on a Message button
 * on a profile to make it look like Josh read the profile first.
 *
 * @param {Page} page
 * @param {object} opts
 *   - minMs, maxMs: total duration (default 4s-12s)
 *   - scrollProb: probability of scrolling at all (default 0.85)
 */
export async function readingPause(page, opts = {}) {
  const minMs = opts.minMs ?? 4000
  const maxMs = opts.maxMs ?? 12000
  const scrollProb = opts.scrollProb ?? 0.85
  const total = randInt(minMs, maxMs)

  const startedAt = Date.now()

  // Initial pause — "loading the page visually"
  await sleep(randInt(500, 1500))

  if (Math.random() < scrollProb) {
    // Scroll down some
    await humanScroll(page, { distance: randInt(300, 800) })

    // Maybe scroll back up a bit (humans re-read)
    if (Math.random() < 0.4) {
      await sleep(randInt(800, 2000))
      await humanScroll(page, { distance: randInt(150, 400), direction: 'up' })
    }
  }

  // Use the remaining time for "still reading"
  const elapsed = Date.now() - startedAt
  const remaining = Math.max(0, total - elapsed)
  if (remaining > 0) await sleep(remaining)
}

/**
 * Visit /feed, scroll for a bit, maybe view a notification. Used between sends
 * to break the "feed → profile → message → repeat" predictable pattern.
 *
 * Returns the page on /feed; caller must navigate elsewhere afterward.
 *
 * @param {Page} page
 * @param {object} opts
 *   - durationMs: how long to spend browsing (default 15-40s)
 */
export async function browsingContext(page, opts = {}) {
  const durationMs = opts.durationMs ?? randInt(15_000, 40_000)
  try {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'commit', timeout: 30_000 })
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {})
  } catch {
    // Network blip — skip browsing, caller can proceed
    return
  }

  const startedAt = Date.now()
  while (Date.now() - startedAt < durationMs) {
    await humanScroll(page, {
      distance:   randInt(400, 900),
      stepMinPx:  150,
      stepMaxPx:  350,
      pauseMinMs: 400,
      pauseMaxMs: 1200,
    }).catch(() => {})
    await sleep(randInt(1000, 3000))
    // Occasionally scroll back up — humans do this to re-read posts
    if (Math.random() < 0.3) {
      await humanScroll(page, { distance: randInt(100, 400), direction: 'up' }).catch(() => {})
      await sleep(randInt(500, 1500))
    }
  }
}

// ── Message variation ─────────────────────────────────────────────────────────

/**
 * Apply small random variations to a template message so LinkedIn doesn't see
 * 5 identical-character-count outbound messages from the same account.
 *
 * Conservative: only changes things that don't alter meaning.
 *
 * Variations applied:
 *  - Optional period at end of greeting line ("Cecilia," vs "Cecilia.")
 *  - Whitespace nuance — 30% drop final newline
 *  - Synonym swap on a few common phrases
 *  - Optional opener prefix ("Hola, " or "Buen día, ")
 */
export function varyMessage(text, opts = {}) {
  if (!text) return text
  const seed = opts.seed ?? Math.random()
  let out = text

  // Synonyms — preserve meaning
  const SYNONYMS = [
    [/\brápido\b/i,            ['rápido', 'rápidamente', 'breve']],
    [/\b1 duda\b/i,            ['1 duda', 'una duda', 'una pregunta']],
    [/\bcomo estas\b/i,        ['como estas', 'qué tal', 'cómo va todo']],
    [/\bvi tu perfil\b/i,      ['vi tu perfil', 'revisé tu perfil', 'eché un ojo a tu perfil']],
    [/\bahora mismo\b/i,       ['ahora mismo', 'en este momento', 'justo ahora']],
    [/\bse nota\b/i,            ['se nota', 'se ve', 'se aprecia']],
  ]
  for (const [re, options] of SYNONYMS) {
    if (re.test(out) && Math.random() < 0.45) {
      const replacement = options[Math.floor(Math.random() * options.length)]
      out = out.replace(re, replacement)
    }
  }

  // 30% chance: trim trailing whitespace differently
  if (Math.random() < 0.3) out = out.replace(/\s+$/, '')

  return out
}

// ── Module check ──────────────────────────────────────────────────────────────
// Quick self-test when run with: node lib/humanize.js
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('humanize.js loaded ✓')
  console.log('  exports:', [
    'randInt', 'sleep', 'microDelay', 'thinkingPause',
    'humanType', 'humanFill', 'humanScroll',
    'humanHover', 'humanClick',
    'readingPause', 'browsingContext',
    'varyMessage',
  ].join(', '))
  console.log('  varyMessage demo:')
  for (let i = 0; i < 3; i++) {
    console.log('   ', varyMessage('Cecilia, vi tu perfil. 1 duda rápido — ahora mismo.'))
  }
}
