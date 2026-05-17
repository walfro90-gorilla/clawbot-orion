/**
 * backfill-manual-replies.js — ⚠️ OBSOLETO (2026-05-15)
 *
 * Probado y descartado. El dedupe contra outbounds históricos NO tiene URN en
 * metadata (los inserts antiguos no incluían `linkedin_msg_urn`) ni hace
 * content match fiable (humanType + varyMessage alteran el texto). Resultado:
 * marca como `linkedin_manual` mensajes que fueron `orion_auto` históricos →
 * falsos positivos.
 *
 * NO EJECUTAR. La detección de drift funciona solo hacia adelante: inbox.js
 * (helper recordManualOutbounds) registra correctamente los nuevos outbounds
 * con URN en metadata, así que el dedupe sí funciona para mensajes futuros.
 *
 * Si en el futuro se quiere recuperar histórico, hay que:
 *   1. Backfillear los inserts antiguos de followup.js/reply.js/batch.js con
 *      `metadata.linkedin_msg_urn` extraído via API.
 *   2. ENTONCES el dedupe por URN funciona, y este script puede correr.
 */
import 'dotenv/config'
import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { supabase } from '../lib/supabase.js'
import { getOrCreateAccountFingerprint, contextOptionsFromFingerprint } from '../lib/browser.js'

chromium.use(StealthPlugin())

const ACCOUNT_ID = process.env.ACCOUNT_ID
if (!ACCOUNT_ID) { console.error('ACCOUNT_ID requerido'); process.exit(1) }

const sleep = ms => new Promise(r => setTimeout(r, ms))
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1))

function parseProxy(url) {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return { server: `${u.protocol}//${u.host}`, username: u.username, password: u.password }
  } catch { return undefined }
}

async function run() {
  // Load account
  const { data: account, error } = await supabase
    .from('linkedin_accounts')
    .select('id, label, li_at_cookie, proxy_url')
    .eq('id', ACCOUNT_ID).single()
  if (error || !account) throw new Error(`Account not found: ${error?.message}`)

  console.log(`[BACKFILL] Account: ${account.label}`)

  // Load conversations with linkedin_thread_id
  const { data: convs } = await supabase
    .from('conversations')
    .select('id, lead_id, linkedin_thread_id, leads(full_name)')
    .eq('linkedin_account_id', ACCOUNT_ID)
    .not('linkedin_thread_id', 'is', null)
    .order('last_message_at', { ascending: false })
    .limit(50)

  console.log(`[BACKFILL] ${convs?.length ?? 0} conversaciones con thread_id`)
  if (!convs?.length) return

  // Launch browser with the account's fingerprint
  const fp = await getOrCreateAccountFingerprint(supabase, ACCOUNT_ID)
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  const context = await browser.newContext(
    contextOptionsFromFingerprint(fp, parseProxy(account.proxy_url))
  )
  await context.addCookies([{
    name: 'li_at', value: account.li_at_cookie,
    domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None',
  }])
  const page = await context.newPage()

  // Capture messengerMessages responses
  const responses = new Map()
  page.on('response', async resp => {
    const u = resp.url()
    if (/messengerMessages/i.test(u)) {
      try { responses.set(u, await resp.json()) } catch {}
    }
  })

  // Warmup feed
  console.log(`[BACKFILL] Warmup feed...`)
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
  if (/login|authwall|checkpoint/.test(page.url())) {
    console.error('[BACKFILL] Cookie inválida — auth wall'); process.exit(1)
  }
  await sleep(randInt(2000, 4000))

  let totalRecorded = 0

  for (let i = 0; i < convs.length; i++) {
    const conv = convs[i]
    const name = conv.leads?.full_name ?? '?'
    console.log(`\n[BACKFILL] (${i+1}/${convs.length}) ${name} thread=${conv.linkedin_thread_id.slice(0, 20)}`)

    // Limpiar capturas previas
    for (const k of [...responses.keys()]) {
      if (/messengerMessages/i.test(k)) responses.delete(k)
    }

    try {
      await page.goto(`https://www.linkedin.com/messaging/thread/${conv.linkedin_thread_id}/`, {
        waitUntil: 'domcontentloaded', timeout: 25_000,
      })
      await sleep(randInt(2500, 4500))   // dar tiempo a que LinkedIn pida messengerMessages

      // Buscar la captura
      let msgElements = []
      for (const [url, json] of responses.entries()) {
        if (/messengerMessages/i.test(url)) {
          msgElements = json?.data?.messengerMessagesBySyncToken?.elements
                     ?? json?.data?.messengerMessagesByAnchorTimestamp?.elements
                     ?? json?.data?.messengerMessages?.elements ?? []
          if (msgElements.length) break
        }
      }
      console.log(`     ${msgElements.length} mensajes en thread`)

      if (!msgElements.length) continue

      const isSelf = m => m.sender?.participantType?.member?.distance === 'SELF'

      // Outbounds con texto y URN
      const outbounds = msgElements
        .filter(isSelf)
        .map(m => {
          const urn = m.entityUrn ?? m.backendUrn ?? null
          const text = (m.body?.text ?? m.body ?? '').trim()
          const deliveredAt = m.deliveredAt ?? m.createdAt ?? null
          return urn && text ? { urn, text, deliveredAt } : null
        })
        .filter(Boolean)

      if (!outbounds.length) continue

      // Ya registrados (cualquier sent_via)
      const { data: existing } = await supabase
        .from('conversation_events')
        .select('metadata')
        .eq('conversation_id', conv.id)
        .eq('direction', 'outbound')

      const existingUrns = new Set(
        (existing ?? []).map(e => e?.metadata?.linkedin_msg_urn).filter(Boolean)
      )

      // También considera duplicate por contenido (URN nuevo en BD, pero ya hay outbound con el mismo texto)
      const existingTexts = new Set(
        (await supabase.from('conversation_events')
          .select('content').eq('conversation_id', conv.id).eq('direction', 'outbound')
        ).data?.map(e => (e.content ?? '').slice(0, 200)) ?? []
      )

      const toInsert = outbounds
        .filter(o => !existingUrns.has(o.urn))
        .filter(o => !existingTexts.has(o.text.slice(0, 200)))   // anti-dup por contenido
        .map(o => ({
          conversation_id: conv.id,
          event_type:      'message_sent',
          direction:       'outbound',
          sent_via:        'linkedin_manual',
          content:         o.text.slice(0, 4000),
          sent_at:         o.deliveredAt ? new Date(o.deliveredAt).toISOString() : new Date().toISOString(),
          metadata:        { linkedin_msg_urn: o.urn, backfilled: true },
        }))

      if (toInsert.length === 0) {
        console.log(`     Sin outbounds nuevos para registrar`)
        continue
      }

      const { error: insErr } = await supabase.from('conversation_events').insert(toInsert)
      if (insErr) {
        console.warn(`     INSERT error:`, insErr.message)
      } else {
        console.log(`     ✅ ${toInsert.length} outbound(s) manual(es) registrados`)
        totalRecorded += toInsert.length
      }
    } catch (err) {
      console.warn(`     Error: ${err.message.slice(0, 100)}`)
    }

    // Pausa humanizada entre threads (anti-ban)
    await sleep(randInt(3000, 7000))
  }

  await browser.close()
  console.log(`\n[BACKFILL] ✅ Done. Total registrados: ${totalRecorded}`)
}

run().catch(err => { console.error('[BACKFILL] Fatal:', err); process.exit(1) })
