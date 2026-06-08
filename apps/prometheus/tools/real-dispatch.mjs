#!/usr/bin/env node
// real-dispatch.mjs — dispatches REAL action (NO dryRun, NO stress flag) for manual test.
// Use: node tools/real-dispatch.mjs <action> --account Wal [--lead Name] [--keyword "..."] [--count N]

import { supabase } from '../lib/supabase.js'
import { dispatchCommand } from '../lib/extension-dispatch.js'

const argv = process.argv.slice(2)
const action = argv[0]
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`)
  if (i === -1) return d
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

if (!action) {
  console.error('Uso: node tools/real-dispatch.mjs <action> --account <label>')
  console.error('  actions: search, send_invite')
  console.error('  search: --account Wal [--keyword "..."] [--count 10]')
  console.error('  send_invite: --account Wal --lead "Name"')
  process.exit(1)
}

const accountLabel = flag('account', 'Wal')
const { data: account } = await supabase
  .from('linkedin_accounts')
  .select('id, label, status, extension_paused, ext_version')
  .eq('label', accountLabel)
  .maybeSingle()
if (!account) { console.error(`Account ${accountLabel} no encontrada`); process.exit(1) }
if (account.extension_paused) { console.error(`Account ${accountLabel} PAUSED — unpause first`); process.exit(1) }
console.log(`  Account: ${account.label} (${account.id.slice(0,8)}) ext=${account.ext_version}`)

if (action === 'search') {
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, name, search_keywords, search_location, search_2nd_degree_only, gemini_system_prompt, title_blacklist, title_whitelist')
    .eq('linkedin_account_id', account.id)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()
  if (!campaign) { console.error(`No active campaign for ${account.label}`); process.exit(1) }

  const keyword = flag('keyword') || (Array.isArray(campaign.search_keywords) ? campaign.search_keywords[0] : 'Director')
  const count = parseInt(flag('count', '10'), 10)
  console.log(`  Campaign: ${campaign.name}`)
  console.log(`  Keyword: ${keyword}, Count: ${count}, Location: ${campaign.search_location ?? 'Mexico'}`)

  const payload = {
    keywords: keyword,
    locations: campaign.search_location ?? 'Mexico',
    targetCount: count,
    maxPages: 2,
    secondDegreeOnly: campaign.search_2nd_degree_only ?? true,
    campaignId: campaign.id,  // INGEST a campaña
    titleBlacklist: campaign.title_blacklist ?? [],
    titleWhitelist: campaign.title_whitelist ?? [],
    geminiPrompt: campaign.gemini_system_prompt ?? null,
    // NO dryRun, NO is_stress_test → real ingest
  }
  console.log('  Dispatching REAL search…')
  const cmdId = await dispatchCommand(account.id, 'search', payload, { expiresInMinutes: 5 })
  console.log(`  cmd: ${cmdId}`)
  console.log(`  Monitor: SELECT id, status, current_phase, error, result->>'totalFound' as found FROM extension_commands WHERE id='${cmdId}';`)
  process.exit(0)
}

if (action === 'send_invite') {
  const leadName = flag('lead')
  if (!leadName) { console.error(`--lead required`); process.exit(1) }
  const { data: lead } = await supabase
    .from('leads')
    .select('id, full_name, linkedin_url, status, campaign_id, ai_message, ai_subject')
    .ilike('full_name', `%${leadName}%`)
    .eq('status', 'scraped')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!lead) { console.error(`Lead "${leadName}" no scraped`); process.exit(1) }
  console.log(`  Lead: ${lead.full_name} (${lead.id.slice(0,8)}) status=${lead.status}`)
  console.log(`  URL: ${lead.linkedin_url}`)
  console.log(`  AI message: ${lead.ai_message ? lead.ai_message.slice(0,80) + '…' : '(none)'}`)

  const payload = {
    profileUrl: lead.linkedin_url,
    leadId: lead.id,
    leadName: lead.full_name,
    message: lead.ai_message || null,  // REAL message (Gemini-generated o null = no-note flow)
    // NO dryRun → REAL CLICK SEND
    // NO is_stress_test → counts as production
  }
  console.log('  Dispatching REAL send_invite (NO dryRun)…')
  const cmdId = await dispatchCommand(account.id, 'send_invite', payload, {
    relatedLeadId: lead.id,
    expiresInMinutes: 5,
  })
  console.log(`  cmd: ${cmdId}`)
  console.log(`  Monitor: SELECT id, status, current_phase, error, result FROM extension_commands WHERE id='${cmdId}';`)
  process.exit(0)
}

console.error(`Unknown action: ${action}`)
process.exit(1)
