// scheduler-extension.js — Smart Hybrid scheduler (Sub-Fase 3)
//
// Reemplaza scheduler.js. En lugar de spawnear scripts Playwright que ya no
// son viables (multi-IP ban), inserta comandos en extension_commands y deja
// que extension-bridge.js los despache a la extension del usuario.
//
// Tick cada 5 min:
//   - Para cada campaña activa: search, invites, inbox, follow-ups
//   - Respeta schedule_hours / paused / gaps / caps / warmup / extension_online
//
// PM2 corre este script en lugar del scheduler.js viejo.

import dotenv from 'dotenv'
import { supabase, logActivity } from './lib/supabase.js'
import {
  mxTime, mxDateStr, minutesSince,
  isBusinessHours, isInboxHours,
  isExtensionOnline, getConnectedAccountIds,
  getEffectiveDailyCap, getDailyActivityToday, getPendingLeadsCount,
  passesTitleFilters,
  dispatchSearch, dispatchInvite, dispatchCheckInbox, dispatchCheckSentInvites, dispatchFollowup,
  checkCampaignActiveGates,
} from './lib/extension-dispatch.js'
import { generateLinkedInMessage } from './lib/ai-message.js'

dotenv.config()

const TICK_INTERVAL_MS = parseInt(process.env.TICK_INTERVAL_MS ?? '300000')  // 5 min default
const TICK_TIMEOUT_MS  = parseInt(process.env.TICK_TIMEOUT_MS  ?? '240000')  // 4 min: máx un tick
const HUNG_TIMEOUT_MS  = parseInt(process.env.HUNG_TIMEOUT_MS  ?? '600000')  // 10 min: watchdog mata el proceso
const DRY_RUN = process.env.DRY_RUN === 'true'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

// ── Watchdog: detecta scheduler hung (no tick en N min) ──────────────────────
// Cada tick exitoso actualiza lastTickAt. Si pasa más de HUNG_TIMEOUT_MS sin
// tick, mata el proceso y deja que PM2 lo restartee.
let lastTickAt = Date.now()
let tickInFlight = false

function watchdog() {
  const sinceTick = Date.now() - lastTickAt
  if (sinceTick > HUNG_TIMEOUT_MS) {
    console.error(`[SCH-EXT] 🔴 WATCHDOG: scheduler hung — sin tick desde hace ${Math.floor(sinceTick/1000)}s. Matando proceso para que PM2 reinicie.`)
    process.exit(1)
  }
  // Si hay un tick que lleva más de TICK_TIMEOUT_MS in-flight, también es señal
  if (tickInFlight && sinceTick > TICK_TIMEOUT_MS) {
    console.error(`[SCH-EXT] 🔴 WATCHDOG: tick en flight desde hace ${Math.floor(sinceTick/1000)}s (>${TICK_TIMEOUT_MS/1000}s). Matando proceso.`)
    process.exit(1)
  }
}

// Race wrapper para abortar ticks que tarden demasiado
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms)),
  ])
}

// ── Job logging ──────────────────────────────────────────────────────────────

async function logJob({ campaignId, accountId, jobType, status, skipReason, leadsFound, leadsSent, details }) {
  await supabase.from('scheduler_log').insert({
    campaign_id: campaignId ?? null,
    account_id:  accountId ?? null,
    job_type:    jobType,
    status,
    skip_reason: skipReason ?? null,
    leads_found: leadsFound ?? null,
    leads_sent:  leadsSent ?? null,
    details:     details ?? {},
  })
}

// ── Search trigger ───────────────────────────────────────────────────────────
// Dispara search si: !search_paused + gap respetado + pending_leads bajo + connected

async function trySearchForCampaign(campaign, account) {
  if (campaign.search_paused) {
    return { skipped: true, reason: 'search_paused' }
  }

  const searchGapHours = campaign.search_gap_hours ?? 24
  const minsSince = minutesSince(campaign.last_searched_at)
  if (minsSince < searchGapHours * 60) {
    return { skipped: true, reason: 'search_gap_not_met', minsSince: Math.floor(minsSince) }
  }

  const minPending = campaign.min_pending_threshold ?? 10
  const pendingCount = await getPendingLeadsCount(campaign.id)
  if (pendingCount >= minPending) {
    return { skipped: true, reason: 'enough_pending_leads', pendingCount, minPending }
  }

  // Rota keywords: usa hour-of-day como índice (estabilidad intra-hora,
  // variación inter-hora). Si solo hay 1, siempre la misma.
  const kws = campaign.search_keywords ?? []
  if (kws.length === 0) {
    return { skipped: true, reason: 'no_search_keywords' }
  }
  const { mxHour } = mxTime()
  const keyword = kws[mxHour % kws.length]

  if (DRY_RUN) {
    console.log(`[SCH-EXT] DRY_RUN search "${campaign.name}" keyword="${keyword}"`)
    return { dispatched: false, dryRun: true, keyword }
  }

  const cmdId = await dispatchSearch(account, campaign, keyword)
  if (!cmdId) {
    return { skipped: true, reason: 'dispatch_failed' }
  }

  await supabase.from('campaigns')
    .update({ last_searched_at: new Date().toISOString() })
    .eq('id', campaign.id)

  await logJob({
    campaignId: campaign.id, accountId: account.id, jobType: 'search',
    status: 'dispatched',
    details: { commandId: cmdId, keyword, pendingBefore: pendingCount },
  })

  return { dispatched: true, commandId: cmdId, keyword }
}

// ── Invite trigger (3.3) ─────────────────────────────────────────────────────
// 1 invite por tick cuando: !batch_paused, gap respetado, bajo cap diario,
// hay leads scraped que pasan whitelist/blacklist.

async function tryInvitesForCampaign(campaign, account) {
  if (campaign.batch_paused) {
    return { skipped: true, reason: 'batch_paused' }
  }

  const gapMin = campaign.min_batch_gap_min ?? 30
  const minsSince = minutesSince(campaign.last_batch_at)
  if (minsSince < gapMin) {
    return { skipped: true, reason: 'batch_gap_not_met', minsSince: Math.floor(minsSince), gapMin }
  }

  const cap = getEffectiveDailyCap(account, campaign)
  const today = await getDailyActivityToday(account.id, account.timezone)
  const usedToday = today.invites_sent + today.messages_sent
  if (usedToday >= cap) {
    return { skipped: true, reason: 'daily_cap_reached', usedToday, cap }
  }

  // Buscar próximo lead recién scrapeado por la extension que pase whitelist/blacklist.
  // Excluímos 'pending' explícitamente — son leads viejos de pipelines anteriores
  // que pueden tener linkedin_url stale, perfiles ya conectados, o estar
  // inactivos. 'scraped' es la status que setea ingestSearch del extension.
  const { data: candidates } = await supabase
    .from('leads')
    .select('id, full_name, linkedin_url, profile_data, scraped_at')
    .eq('campaign_id', campaign.id)
    .eq('status', 'scraped')
    .not('linkedin_url', 'is', null)
    .order('scraped_at', { ascending: false })
    .limit(10)

  if (!candidates || candidates.length === 0) {
    return { skipped: true, reason: 'no_pending_leads' }
  }

  const whitelisted = candidates.filter(l =>
    passesTitleFilters(l.profile_data?.headline ?? '', campaign.title_whitelist, campaign.title_blacklist)
  )
  if (whitelisted.length === 0) {
    return { skipped: true, reason: 'no_leads_pass_whitelist', candidatesChecked: candidates.length }
  }

  // Pick aleatorio entre top 5 para humanización
  const pool = whitelisted.slice(0, 5)
  const lead = pool[Math.floor(Math.random() * pool.length)]

  // Decisión con/sin nota:
  // - campaign.invite_with_note=false (default) → SIEMPRE sin nota (mejor accept rate)
  // - campaign.invite_with_note=true → AI gen via gemini_system_prompt
  // - Override safety: cold warmup ignora invite_with_note y siempre sin nota
  //   (los primeros días LinkedIn observa con escrutinio extra)
  const useNota = !!campaign.invite_with_note &&
                  account.warmup_status !== 'cold' &&
                  !!campaign.gemini_system_prompt &&
                  campaign.gemini_system_prompt.trim().length > 20

  let message = null
  if (useNota) {
    const aiRes = await generateLinkedInMessage(campaign, lead, 'invite')
    if (aiRes.error) {
      console.warn(`[SCH-EXT]   AI gen failed: ${aiRes.error} — fallback sin nota`)
    } else {
      message = aiRes.message
    }
  }

  if (DRY_RUN) {
    console.log(`[SCH-EXT] DRY_RUN invite to "${lead.full_name}" — message: ${message ? `"${message}"` : '(sin nota)'}`)
    return { dispatched: false, dryRun: true, leadId: lead.id }
  }

  const cmdId = await dispatchInvite(account, lead, { message, dryRun: false })
  if (!cmdId) {
    return { skipped: true, reason: 'dispatch_failed' }
  }

  // No marcamos lead.status='processing': el gate min_batch_gap_min ya previene
  // duplicados entre ticks. Si el comando falla, el lead sigue 'scraped' y se
  // re-intentará en el próximo gap — retry implícito.
  await supabase.from('campaigns')
    .update({ last_batch_at: new Date().toISOString() })
    .eq('id', campaign.id)

  await logJob({
    campaignId: campaign.id, accountId: account.id, jobType: 'batch',
    status: 'dispatched',
    details: {
      commandId: cmdId,
      leadId: lead.id,
      leadName: lead.full_name,
      withNote: !!message,
      messageLength: message?.length ?? 0,
      capUsage: `${usedToday + 1}/${cap}`,
    },
  })

  return {
    dispatched: 1,
    commandId: cmdId,
    leadName: lead.full_name,
    withNote: !!message,
    capUsage: `${usedToday + 1}/${cap}`,
  }
}

// ── Follow-up trigger (3.4) ──────────────────────────────────────────────────
// Sweep de leads listos para próximo step de FU. Plantilla > AI gen.

function substituteTemplate(template, lead) {
  if (!template) return null
  const first = (lead.full_name ?? '').split(/\s+/)[0]
  return template
    .replace(/\{nombre\}/gi, first)
    .replace(/\{first_name\}/gi, first)
    .replace(/\{nombre_completo\}/gi, lead.full_name ?? '')
    .replace(/\{full_name\}/gi, lead.full_name ?? '')
}

const FU_STEPS = [
  { num: 1, statusFrom: ['connected'],          statusTo: 'follow_up_sent',   delayField: 'follow_up_delay_days',         delayUnit: 'days',  tplField: 'follow_up_message',         lastField: 'last_followup_at' },
  { num: 2, statusFrom: ['follow_up_sent'],     statusTo: 'follow_up_sent_2', delayField: 'follow_up_step2_delay_hours', delayUnit: 'hours', tplField: 'follow_up_step2_message',  lastField: 'last_followup2_at' },
  { num: 3, statusFrom: ['follow_up_sent_2'],   statusTo: 'follow_up_sent_3', delayField: 'follow_up_step3_delay_hours', delayUnit: 'hours', tplField: 'follow_up_step3_message',  lastField: 'last_followup3_at' },
  { num: 4, statusFrom: ['follow_up_sent_3'],   statusTo: 'follow_up_sent_4', delayField: 'follow_up_step4_delay_hours', delayUnit: 'hours', tplField: 'follow_up_step4_message',  lastField: 'last_followup4_at' },
  { num: 5, statusFrom: ['follow_up_sent_4'],   statusTo: 'follow_up_sent_5', delayField: 'follow_up_step5_delay_hours', delayUnit: 'hours', tplField: 'follow_up_step5_message',  lastField: 'last_followup5_at' },
]

async function tryFollowupsForCampaign(campaign, account) {
  if (campaign.follow_up_paused) {
    return { skipped: true, reason: 'follow_up_paused' }
  }

  // Para cada step, buscar leads que se cumplen
  for (const step of FU_STEPS) {
    const template = campaign[step.tplField]
    const hasAiFallback = !!campaign.gemini_system_prompt &&
                          campaign.gemini_system_prompt.trim().length > 20
    if (!template && !hasAiFallback) continue  // ni template ni gemini prompt → skip

    const delay = campaign[step.delayField]
    if (!delay && delay !== 0) continue  // sin delay = step deshabilitado

    // ¿Cuánto tiempo desde el último step para este lead?
    const cutoffMs = step.delayUnit === 'days' ? delay * 86_400_000 : delay * 3_600_000
    const cutoffIso = new Date(Date.now() - cutoffMs).toISOString()
    const prevTimeField = step.num === 1 ? 'connected_at' : FU_STEPS[step.num - 2].lastField

    const { data: due } = await supabase
      .from('leads')
      .select(`id, full_name, linkedin_url, status, ${prevTimeField},
               conversations!inner(linkedin_thread_id, linkedin_account_id)`)
      .eq('campaign_id', campaign.id)
      .eq('conversations.linkedin_account_id', account.id)
      .in('status', step.statusFrom)
      .lt(prevTimeField, cutoffIso)
      .not('conversations.linkedin_thread_id', 'is', null)
      .limit(3)

    if (!due || due.length === 0) continue

    // auto_dead_after_days: si lead lleva más de X días sin reply, marcar dead
    if (campaign.auto_dead_after_days) {
      const deadCutoffIso = new Date(Date.now() - campaign.auto_dead_after_days * 86_400_000).toISOString()
      for (const lead of due) {
        if (lead[prevTimeField] < deadCutoffIso) {
          await supabase.from('leads').update({ status: 'dead', dead_reason: 'auto_dead_no_reply' }).eq('id', lead.id)
          console.log(`[SCH-EXT]   💀 lead ${lead.id.slice(0,8)} (${lead.full_name}) auto-dead: ${campaign.auto_dead_after_days}d sin reply`)
        }
      }
    }

    // Tomar uno (humanización: 1 FU por tick por step)
    const lead = due[0]
    let message = substituteTemplate(template, lead)

    // Si no hay template configurado, generar via AI con gemini_system_prompt
    if (!message && hasAiFallback) {
      const aiType = `follow_up_${step.num}`
      const aiRes = await generateLinkedInMessage(campaign, lead, aiType)
      if (aiRes.error) {
        console.warn(`[SCH-EXT]   AI FU gen failed (${aiType}): ${aiRes.error}`)
        continue
      }
      message = aiRes.message
    }

    if (!message) continue

    const threadId = lead.conversations?.[0]?.linkedin_thread_id
    if (!threadId) continue
    const threadUrl = `https://www.linkedin.com/messaging/thread/${threadId}/`

    if (DRY_RUN) {
      console.log(`[SCH-EXT] DRY_RUN FU${step.num} → "${lead.full_name}" (${threadUrl})`)
      return { dispatched: false, dryRun: true, step: step.num }
    }

    const cmdId = await dispatchFollowup(account, lead, step.num, message, threadUrl)
    if (!cmdId) continue

    await logJob({
      campaignId: campaign.id, accountId: account.id, jobType: `followup_${step.num}`,
      status: 'dispatched',
      details: { commandId: cmdId, leadId: lead.id, step: step.num, threadUrl },
    })

    return { dispatched: 1, step: step.num, commandId: cmdId, leadName: lead.full_name }
  }

  return { skipped: true, reason: 'no_followups_due' }
}

// ── Auto-reply trigger (3.6) ─────────────────────────────────────────────────
// Cuando un lead responde, el ingest lo marca status='replied' y la cadena FU
// se pausa automáticamente (porque FU_STEPS solo procesa connected/follow_up_sent_*).
// Este trigger detecta esos replied y genera una respuesta AI personalizada.

async function tryAutoReplyForCampaign(campaign, account) {
  const mode = campaign.auto_reply_mode ?? 'manual'
  if (mode === 'off' || mode === 'manual') {
    return { skipped: true, reason: `auto_reply_mode_${mode}` }
  }

  // Find leads que respondieron y aún no les hemos contestado
  const { data: replied } = await supabase
    .from('leads')
    .select(`id, full_name, replied_at, profile_data,
             conversations!inner(id, linkedin_thread_id, last_message_text, last_message_at, linkedin_account_id)`)
    .eq('campaign_id', campaign.id)
    .eq('conversations.linkedin_account_id', account.id)
    .eq('status', 'replied')
    .not('conversations.linkedin_thread_id', 'is', null)
    .order('replied_at', { ascending: true })
    .limit(5)

  if (!replied || replied.length === 0) {
    return { skipped: true, reason: 'no_replies_pending' }
  }

  // Filter: solo leads donde el último outbound es ANTERIOR al último inbound
  // (i.e., todavía no respondimos al último mensaje del lead)
  for (const lead of replied) {
    const conv = lead.conversations?.[0]
    if (!conv) continue

    const { data: lastOutbound } = await supabase
      .from('conversation_events')
      .select('sent_at')
      .eq('conversation_id', conv.id)
      .eq('direction', 'outbound')
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const lastInboundAt = conv.last_message_at ? new Date(conv.last_message_at).getTime() : 0
    const lastOutAt = lastOutbound?.sent_at ? new Date(lastOutbound.sent_at).getTime() : 0
    if (lastOutAt > lastInboundAt) continue  // ya respondimos a este reply

    // Delay aleatorio entre detección y respuesta (humanización)
    const delayMin = account.reply_delay_min ?? campaign.auto_reply_delay_min ?? 1
    const delayMax = account.reply_delay_max ?? campaign.auto_reply_delay_max ?? 5
    const minutesSinceReply = (Date.now() - lastInboundAt) / 60_000
    if (minutesSinceReply < randInt(delayMin, delayMax)) {
      console.log(`[SCH-EXT]   ⏸️  AI reply para ${lead.full_name}: aguardando humanization delay (${delayMin}-${delayMax}min)`)
      continue
    }

    // Determinar qué FM step usar: cuenta cuántos outbound events hay en este thread
    const { count: outboundCount } = await supabase
      .from('conversation_events')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conv.id)
      .eq('direction', 'outbound')
    const fmStep = Math.min((outboundCount ?? 0) + 1, 3)  // FM1, FM2, FM3 max

    // Generar respuesta vía AI
    const aiType = `fm_${fmStep}`
    const aiRes = await generateAIReply(campaign, lead, conv.last_message_text, fmStep)
    if (aiRes.error) {
      console.warn(`[SCH-EXT]   AI reply gen failed: ${aiRes.error}`)
      return { skipped: true, reason: 'ai_gen_failed', error: aiRes.error }
    }

    if (DRY_RUN) {
      console.log(`[SCH-EXT] DRY_RUN ${aiType} → ${lead.full_name}: "${aiRes.message.slice(0, 80)}..."`)
      return { dispatched: false, dryRun: true }
    }

    const threadUrl = `https://www.linkedin.com/messaging/thread/${conv.linkedin_thread_id}/`
    // Dispatch send_followup pero con kind='reply' para que el ingest NO cambie status
    const cmdId = await dispatchCommand(account.id, 'send_followup', {
      threadUrl,
      leadId:   lead.id,
      leadName: lead.full_name,
      message:  aiRes.message,
      step:     0,        // FM no es FU
      kind:     'reply',  // ingestSendFollowup respeta esto para no cambiar status
    }, { relatedLeadId: lead.id, expiresInMinutes: 10 })

    if (!cmdId) continue

    await logJob({
      campaignId: campaign.id, accountId: account.id, jobType: aiType,
      status: 'dispatched',
      details: { commandId: cmdId, leadId: lead.id, fmStep, replyTo: conv.last_message_text?.slice(0, 100) },
    })

    return {
      dispatched: 1,
      leadName: lead.full_name,
      fmStep,
      commandId: cmdId,
      messagePreview: aiRes.message.slice(0, 60),
    }
  }

  return { skipped: true, reason: 'no_replies_due' }
}

// Genera AI reply usando gemini_system_prompt + fm{N}_example_reply como guía
async function generateAIReply(campaign, lead, leadReplyText, fmStep) {
  // Construir un campaign sintético que incluye el texto del lead como contexto
  const augmentedLead = {
    ...lead,
    profile_data: {
      ...(lead.profile_data || {}),
      lastInboundMessage: leadReplyText,  // se incluye en el user prompt
    },
  }
  // Usar el tipo follow_up_N que tiene más libertad de longitud (500 chars vs 150)
  return await generateLinkedInMessage(campaign, augmentedLead, `follow_up_${fmStep}`)
}

// ── Inbox trigger (3.4) ──────────────────────────────────────────────────────

async function tryInboxForAccount(account) {
  if (account.inbox_paused) {
    return { skipped: true, reason: 'inbox_paused' }
  }

  const gapMin = account.inbox_gap_min ?? 60
  const minsSince = minutesSince(account.last_inbox_check_at)
  if (minsSince < gapMin) {
    return { skipped: true, reason: 'inbox_gap_not_met', minsSince: Math.floor(minsSince), gapMin }
  }

  if (DRY_RUN) {
    console.log(`[SCH-EXT] DRY_RUN check_inbox for ${account.label}`)
    return { dispatched: false, dryRun: true }
  }

  const cmdId = await dispatchCheckInbox(account)
  if (!cmdId) return { skipped: true, reason: 'dispatch_failed' }

  await supabase.from('linkedin_accounts')
    .update({ last_inbox_check_at: new Date().toISOString() })
    .eq('id', account.id)

  await logJob({
    accountId: account.id, jobType: 'inbox',
    status: 'dispatched',
    details: { commandId: cmdId },
  })

  return { dispatched: true, commandId: cmdId }
}

// ── Check Sent Invites trigger (3.5) ─────────────────────────────────────────
// Scrapea /mynetwork/invitation-manager/sent/ para detectar accepts sin nota.
// Más espaciado que inbox (default 6h) — los accepts no necesitan detección rápida.

async function tryCheckSentInvitesForAccount(account) {
  const gapMin = account.sent_invites_gap_min ?? 360
  const minsSince = minutesSince(account.last_sent_invites_check_at)
  if (minsSince < gapMin) {
    return { skipped: true, reason: 'sent_invites_gap_not_met', minsSince: Math.floor(minsSince), gapMin }
  }

  if (DRY_RUN) {
    console.log(`[SCH-EXT] DRY_RUN check_sent_invites for ${account.label}`)
    return { dispatched: false, dryRun: true }
  }

  const cmdId = await dispatchCheckSentInvites(account)
  if (!cmdId) return { skipped: true, reason: 'dispatch_failed' }

  await supabase.from('linkedin_accounts')
    .update({ last_sent_invites_check_at: new Date().toISOString() })
    .eq('id', account.id)

  await logJob({
    accountId: account.id, jobType: 'check_sent_invites',
    status: 'dispatched',
    details: { commandId: cmdId },
  })

  return { dispatched: true, commandId: cmdId }
}

// ── Main tick ────────────────────────────────────────────────────────────────

async function tick() {
  const { mxDate, mxHour } = mxTime()
  console.log(`\n[SCH-EXT] ════════════════════════════`)
  console.log(`[SCH-EXT] Tick @ ${mxDate} CDMX`)

  // Pre-fetch connected accounts (cached 5s)
  const connectedIds = await getConnectedAccountIds()
  console.log(`[SCH-EXT] Bridge connected accounts: ${connectedIds.size} [${[...connectedIds].map(id => id.slice(0,8)).join(', ')}]`)

  if (connectedIds.size === 0) {
    console.log(`[SCH-EXT] Nadie conectado — skip tick`)
    await logJob({ jobType: 'tick', status: 'skipped', skipReason: 'no_extensions_connected' })
    return
  }

  // Load active campaigns + their accounts
  const { data: campaigns, error } = await supabase
    .from('campaigns')
    .select(`
      id, name, is_active,
      search_paused, batch_paused, follow_up_paused,
      search_keywords, search_location, search_count, search_2nd_degree_only,
      search_company_names, search_min_employees,
      title_whitelist, title_blacklist,
      invite_with_note,
      auto_reply_mode, auto_reply_delay_min, auto_reply_delay_max,
      fm1_example_reply, fm2_example_reply, fm3_example_reply,
      min_pending_threshold, daily_invite_target, min_batch_gap_min, search_gap_hours,
      schedule_start_hour, schedule_end_hour, schedule_days,
      last_searched_at, last_batch_at,
      last_followup_at, last_followup2_at, last_followup3_at, last_followup4_at, last_followup5_at,
      follow_up_message, follow_up_delay_days,
      follow_up_step2_message, follow_up_step2_delay_hours,
      follow_up_step3_message, follow_up_step3_delay_hours,
      follow_up_step4_message, follow_up_step4_delay_hours,
      follow_up_step5_message, follow_up_step5_delay_hours,
      auto_dead_after_days,
      gemini_system_prompt, target_audience, ai_tone, ai_sender_persona, ai_company_context,
      linkedin_account_id,
      linkedin_accounts (
        id, label, status, daily_connection_limit,
        warmup_status, warmup_started_at,
        inbox_gap_min, inbox_paused, last_inbox_check_at,
        sent_invites_gap_min, last_sent_invites_check_at,
        reply_delay_min, reply_delay_max,
        extension_paused, timezone,
        extension_last_seen_at
      )
    `)
    .eq('is_active', true)

  if (error || !campaigns?.length) {
    console.log('[SCH-EXT] No hay campañas activas')
    return
  }

  console.log(`[SCH-EXT] ${campaigns.length} campañas activas`)
  await logJob({ jobType: 'tick', status: 'started', details: { campaigns: campaigns.length, connected: connectedIds.size } })

  // Per-account inbox dedup (varias campañas, una cuenta)
  const accountsSeen = new Map()

  for (const campaign of campaigns) {
    const account = campaign.linkedin_accounts
    if (!account) {
      console.log(`[SCH-EXT] Campaña "${campaign.name}" sin cuenta — skip`)
      continue
    }
    if (!connectedIds.has(account.id)) {
      console.log(`[SCH-EXT] Campaña "${campaign.name}" — cuenta ${account.label} desconectada — skip`)
      continue
    }
    accountsSeen.set(account.id, account)

    const skipReason = await checkCampaignActiveGates(campaign, account)
    if (skipReason) {
      console.log(`[SCH-EXT] "${campaign.name}" — gate skip: ${skipReason}`)
      await logJob({ campaignId: campaign.id, accountId: account.id, jobType: 'tick',
        status: 'skipped', skipReason })
      continue
    }

    console.log(`[SCH-EXT] ━━ "${campaign.name}" (${account.label}) ━━`)

    // SEARCH (3.2)
    const searchRes = await trySearchForCampaign(campaign, account)
    if (searchRes.dispatched) {
      console.log(`[SCH-EXT]   ✅ search dispatched (cmd ${searchRes.commandId.slice(0,8)}, "${searchRes.keyword}")`)
    } else {
      console.log(`[SCH-EXT]   ⏭️  search: ${searchRes.reason}`)
    }

    // INVITES (3.3 — stub)
    const inviteRes = await tryInvitesForCampaign(campaign, account)
    if (inviteRes.dispatched) {
      console.log(`[SCH-EXT]   ✅ ${inviteRes.dispatched} invites dispatched`)
    } else {
      console.log(`[SCH-EXT]   ⏭️  invites: ${inviteRes.reason}`)
    }

    // AUTO-REPLY / FM (3.6) — antes que FU para no spamear con FU si ya respondió
    const replyRes = await tryAutoReplyForCampaign(campaign, account)
    if (replyRes.dispatched) {
      console.log(`[SCH-EXT]   💬 AI reply FM${replyRes.fmStep} dispatched to ${replyRes.leadName}: "${replyRes.messagePreview}..."`)
    } else if (replyRes.reason !== 'no_replies_pending' && replyRes.reason !== 'auto_reply_mode_off' && replyRes.reason !== 'auto_reply_mode_manual') {
      console.log(`[SCH-EXT]   ⏭️  auto-reply: ${replyRes.reason}`)
    }

    // FOLLOWUPS (3.4)
    const fuRes = await tryFollowupsForCampaign(campaign, account)
    if (fuRes.dispatched) {
      console.log(`[SCH-EXT]   ✅ ${fuRes.dispatched} follow-ups dispatched`)
    } else {
      console.log(`[SCH-EXT]   ⏭️  follow-ups: ${fuRes.reason}`)
    }

    // Pequeño jitter entre campañas (no ráfaga)
    await sleep(randInt(1000, 3000))
  }

  // INBOX + CHECK_SENT_INVITES per-account (only in inbox hours, per account TZ)
  for (const account of accountsSeen.values()) {
    if (!connectedIds.has(account.id)) continue
    if (!isInboxHours(undefined, account.timezone)) continue  // fuera de inbox hours en TZ de cuenta

    const inboxRes = await tryInboxForAccount(account)
    if (inboxRes.dispatched) {
      console.log(`[SCH-EXT]   ✅ inbox dispatched for ${account.label}`)
    }

    // No despachar dos comandos al mismo tab en el mismo tick
    if (inboxRes.dispatched) continue

    const sentRes = await tryCheckSentInvitesForAccount(account)
    if (sentRes.dispatched) {
      console.log(`[SCH-EXT]   ✅ check_sent_invites dispatched for ${account.label}`)
    }
  }

  console.log(`[SCH-EXT] Tick done @ ${mxTime().mxDate}`)
}

// ── Main loop ────────────────────────────────────────────────────────────────

async function runTickSafely() {
  if (tickInFlight) {
    console.warn(`[SCH-EXT] ⚠️  tick anterior aún en flight — skipeando este ciclo`)
    return
  }
  tickInFlight = true
  const start = Date.now()
  try {
    await withTimeout(tick(), TICK_TIMEOUT_MS, 'tick')
    lastTickAt = Date.now()
    const dur = Date.now() - start
    if (dur > 30_000) console.warn(`[SCH-EXT] ⚠️  tick lento: ${dur}ms`)
  } catch (err) {
    console.error(`[SCH-EXT] Tick error: ${err.message}`)
    // Si fue por timeout, watchdog matará si se repite — pero sí actualizamos
    // lastTickAt para no doble-matar por el mismo tick lento
    lastTickAt = Date.now()
  } finally {
    tickInFlight = false
  }
}

async function run() {
  console.log(`[SCH-EXT] 🚀 Scheduler-extension iniciando (tick=${TICK_INTERVAL_MS/1000}s, tickTimeout=${TICK_TIMEOUT_MS/1000}s, hungTimeout=${HUNG_TIMEOUT_MS/1000}s, DRY_RUN=${DRY_RUN})`)
  // Watchdog cada 60s
  setInterval(watchdog, 60_000)
  // Heartbeat to log file for external monitoring (e.g., bash `tail`)
  setInterval(() => {
    console.log(`[SCH-EXT] ♥ heartbeat — lastTickAt ${Math.floor((Date.now()-lastTickAt)/1000)}s ago, tickInFlight=${tickInFlight}`)
  }, 120_000)
  // First tick immediate
  runTickSafely()
  // Then on interval
  setInterval(runTickSafely, TICK_INTERVAL_MS)
}

// Handlers para que crash logs sean visibles
process.on('uncaughtException', (err) => {
  console.error(`[SCH-EXT] 💥 uncaughtException: ${err.stack ?? err.message ?? err}`)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error(`[SCH-EXT] 💥 unhandledRejection: ${reason?.stack ?? reason?.message ?? reason}`)
  process.exit(1)
})

run()
