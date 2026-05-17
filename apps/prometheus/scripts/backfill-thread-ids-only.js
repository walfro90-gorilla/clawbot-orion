/**
 * backfill-thread-ids-only.js — Recupera linkedin_thread_id usando SEARCH por nombre.
 * Más confiable que paginación (LinkedIn rate-limita la paginación rápida).
 *
 * Filtra a leads PRIORITARIOS: connected/follow_up_sent que están vulnerables al SPA stale.
 */
import 'dotenv/config'
import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { supabase } from '../lib/supabase.js'
import { getOrCreateAccountFingerprint, contextOptionsFromFingerprint } from '../lib/browser.js'

chromium.use(StealthPlugin())

const ACCOUNT_ID = process.env.ACCOUNT_ID ?? '2ea4a7f2-eb0a-40d0-a7af-3a3066829aeb'

const sleep   = ms => new Promise(r => setTimeout(r, ms))
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1))

function parseProxy(url) {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return { server: `${u.protocol}//${u.host}`, username: u.username, password: u.password }
  } catch { return undefined }
}

function normalizeName(s) {
  return (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

async function run() {
  const { data: account } = await supabase
    .from('linkedin_accounts')
    .select('id, label, li_at_cookie, proxy_url').eq('id', ACCOUNT_ID).single()
  console.log(`[BACKFILL-TID] Account: ${account.label}`)

  // SOLO leads en status que necesitan FU/auto-reply Y sin thread_id
  const { data: pendingLeads } = await supabase
    .from('leads')
    .select(`
      id, full_name, status,
      conversations!inner(id, linkedin_thread_id, linkedin_account_id)
    `)
    .eq('conversations.linkedin_account_id', ACCOUNT_ID)
    .is('conversations.linkedin_thread_id', null)
    .in('status', ['connected','follow_up_sent','follow_up_sent_2','follow_up_sent_3','follow_up_sent_4','follow_up_sent_5','replied'])

  if (!pendingLeads?.length) {
    console.log('[BACKFILL-TID] ✅ No hay leads pendientes')
    return
  }

  console.log(`[BACKFILL-TID] ${pendingLeads.length} leads prioritarios pendientes:`)
  for (const l of pendingLeads) console.log(`  - ${l.full_name} (${l.status})`)

  const fp = await getOrCreateAccountFingerprint(supabase, ACCOUNT_ID)
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const ctx = await browser.newContext(contextOptionsFromFingerprint(fp, parseProxy(account.proxy_url)))
  await ctx.addCookies([{
    name: 'li_at', value: account.li_at_cookie,
    domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None',
  }])
  const page = await ctx.newPage()

  // Captura todas las responses de messaging (incluye search results)
  const responses = []
  page.on('response', async r => {
    const u = r.url()
    if (/messengerConversation|messengerSearchConversations|messagingConversations/i.test(u)) {
      try { responses.push({ url: u, json: await r.json() }) } catch {}
    }
  })

  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 25_000 })
  if (/login|authwall|checkpoint/.test(page.url())) {
    console.error('[BACKFILL-TID] ❌ Cookie inválida'); process.exit(1)
  }
  await sleep(randInt(2000, 4000))

  await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await sleep(6000)

  let matched = 0
  const notFound = []

  for (const lead of pendingLeads) {
    const firstName = lead.full_name.split(' ')[0]
    console.log(`\n[BACKFILL-TID] 🔍 Buscando "${lead.full_name}"...`)

    // Limpiar capturas previas
    responses.length = 0

    // Encontrar el search bar
    const searchInput = page.locator(
      'input[placeholder*="Buscar mensajes" i], input[placeholder*="Search messages" i], ' +
      'input[aria-label*="Buscar" i], input[aria-label*="Search" i]'
    ).first()

    if (!await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('  ⚠️  Search bar no visible — saltando')
      notFound.push(lead.full_name)
      continue
    }

    // Limpiar y escribir
    await searchInput.click()
    await page.waitForTimeout(randInt(300, 600))
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.keyboard.type(lead.full_name, { delay: randInt(50, 100) })
    await sleep(randInt(2500, 4500))   // LinkedIn busca

    // Buscar el thread del lead en las responses capturadas
    let threadId = null
    for (const { json } of responses) {
      const elements = json?.data?.messengerConversationsBySyncToken?.elements
                    ?? json?.data?.messengerSearchConversationsByKeyword?.elements
                    ?? json?.data?.messengerSearchConversations?.elements
                    ?? []
      for (const e of elements) {
        const other = (e.conversationParticipants ?? []).find(p => p?.participantType?.member?.distance !== 'SELF')
        const m = other?.participantType?.member
        const name = `${m?.firstName?.text ?? ''} ${m?.lastName?.text ?? ''}`.trim()
        if (normalizeName(name) === normalizeName(lead.full_name) ||
            (normalizeName(name).includes(normalizeName(firstName)) && normalizeName(lead.full_name).includes(normalizeName(name.split(' ')[0])))) {
          const backendUrn = e.backendUrn ?? ''
          threadId = backendUrn.replace('urn:li:messagingThread:', '') || null
          if (threadId) break
        }
      }
      if (threadId) break
    }

    if (!threadId) {
      console.log(`  ⚠️  No encontrado en search`)
      notFound.push(lead.full_name)
      continue
    }

    const conv = lead.conversations[0]
    const { error: upErr } = await supabase
      .from('conversations')
      .update({ linkedin_thread_id: threadId })
      .eq('id', conv.id)

    if (upErr) {
      console.log(`  ❌ DB error: ${upErr.message}`)
    } else {
      console.log(`  ✅ Backfilled → thread=${threadId.slice(0, 25)}...`)
      matched++
    }

    // Cerrar el search clear para próxima iteración
    await page.keyboard.press('Escape').catch(() => {})
    await sleep(randInt(800, 1500))
  }

  console.log(`\n[BACKFILL-TID] ─────────────────────────────────`)
  console.log(`[BACKFILL-TID] ✅ Backfilled: ${matched} / ${pendingLeads.length}`)
  if (notFound.length) {
    console.log(`[BACKFILL-TID] ⚠️  No encontrados (${notFound.length}):`)
    for (const n of notFound) console.log(`     - ${n}`)
  }

  await browser.close()
}

run().catch(err => { console.error('[BACKFILL-TID] Fatal:', err); process.exit(1) })
