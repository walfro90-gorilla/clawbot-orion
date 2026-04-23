/**
 * trigger-drafts.js — Genera drafts de IA para leads ya respondidos sin draft
 *
 * Usage:
 *   node trigger-drafts.js
 *
 * Genera draft + programa envío (respeta auto_reply_mode de la campaña)
 * para los lead IDs especificados en LEAD_IDS.
 */

import { createClient } from '@supabase/supabase-js'
import { generateReplyDraft } from './ai.js'
import dotenv from 'dotenv'
dotenv.config()

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ── Lead IDs a procesar ───────────────────────────────────────────────────────
const LEAD_IDS = [
  'a233000a-addd-47e9-93d5-a195d2c41fc0', // Patricio Diez de Bonilla
  '8cb6c4c0-9ae4-4bef-8c45-b2a47db2184f', // Nicolas Ferreras
  'b9909cbe-5fb4-471c-a705-d5c09a76e33b', // Christian Alejandro Pantoja Tovar
  '6766056e-3378-4f2d-abe4-8e9967bc2aa7', // Adolfo Borrego
]

async function generateForLead(leadId) {
  // 1. Lead + profile
  const { data: lead } = await supabase.from('leads')
    .select('id, full_name, profile_data, campaign_id')
    .eq('id', leadId).single()
  if (!lead) { console.error(`Lead ${leadId} not found`); return }

  // 2. Conversation + turn
  const { data: conv } = await supabase.from('conversations')
    .select('id, conversation_turn, last_message_text')
    .eq('lead_id', leadId).maybeSingle()
  if (!conv) { console.error(`No conversation for lead ${leadId}`); return }

  // 3. Full history
  const { data: events } = await supabase.from('conversation_events')
    .select('direction, content, sent_at, event_type')
    .eq('conversation_id', conv.id)
    .in('event_type', ['reply_received', 'reply_sent', 'follow_up_sent',
                       'follow_up_sent_2', 'follow_up_sent_3', 'message_sent'])
    .order('sent_at', { ascending: true })

  // 4. Campaign config
  const { data: campaign } = await supabase.from('campaigns')
    .select('auto_reply_mode, auto_reply_delay_min, auto_reply_delay_max, linkedin_account_id')
    .eq('id', lead.campaign_id).single()

  // 5. Cal.com URL
  const { data: account } = await supabase.from('linkedin_accounts')
    .select('cal_com_url').eq('id', campaign.linkedin_account_id).single()

  const turnCount    = conv.conversation_turn ?? 0
  const inboundText  = conv.last_message_text ?? ''
  const mode         = campaign.auto_reply_mode ?? 'manual'
  const delayMin     = campaign.auto_reply_delay_min ?? 45
  const delayMax     = campaign.auto_reply_delay_max ?? 90

  console.log(`\n[${lead.full_name}] turno=${turnCount} modo=${mode} inbound="${inboundText.slice(0, 60)}"`)

  // 6. Generate draft
  const draft = await generateReplyDraft({
    leadName:           lead.full_name,
    leadProfileData:    lead.profile_data ?? {},
    conversationHistory: events ?? [],
    inboundMessage:     inboundText,
    calUrl:             account?.cal_com_url,
    turnCount,
  })

  console.log(`[${lead.full_name}] draft → "${draft.slice(0, 100)}..."`)

  // 7. Schedule if not manual
  const delayMs    = (Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin) * 60_000
  const scheduledAt = mode !== 'manual' ? new Date(Date.now() + delayMs).toISOString() : null

  await supabase.from('conversations').update({
    ai_reply_draft:        draft,
    ai_draft_generated_at: new Date().toISOString(),
    ...(scheduledAt ? { ai_reply_scheduled_at: scheduledAt } : {}),
  }).eq('id', conv.id)

  if (scheduledAt) {
    console.log(`[${lead.full_name}] ✅ Programado para ${new Date(scheduledAt).toLocaleTimeString('es-MX')} (~${delayMin}-${delayMax}min)`)
  } else {
    console.log(`[${lead.full_name}] ✅ Draft guardado — esperando aprobación manual`)
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
console.log(`Generando drafts para ${LEAD_IDS.length} leads...`)
for (const id of LEAD_IDS) {
  await generateForLead(id).catch(e => console.error(`Error para ${id}:`, e.message))
}
console.log('\n¡Listo! Recarga /dashboard/conversations en Orion.')
