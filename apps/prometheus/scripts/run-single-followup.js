#!/usr/bin/env node
/**
 * Runs the followup.js sendFollowUp flow for ONE specific lead.
 * Minimizes proxy load (single lead = single sequence of navigations) so we
 * can validate the fast-path fix without burning the cookie.
 *
 * Read-only by default. Pass --send to actually send the message.
 *
 * Usage:
 *   node scripts/run-single-followup.js "Carlos Castañeda"            # dry-run (types but doesn't send)
 *   node scripts/run-single-followup.js "Carlos Castañeda" --send     # real send
 */
import 'dotenv/config'
import { spawn } from 'child_process'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const LEAD_ARG = process.argv[2]
const LIVE_SEND = process.argv.includes('--send')

if (!LEAD_ARG) {
  console.error('Usage: node scripts/run-single-followup.js "<Lead Full Name>" [--send]')
  process.exit(1)
}

async function main() {
  // Find the lead and its campaign
  const { data: lead } = await supabase
    .from('leads')
    .select('id, full_name, status, campaign_id, campaigns(id, name, linkedin_account_id)')
    .ilike('full_name', `%${LEAD_ARG}%`)
    .limit(1)
    .single()

  if (!lead) { console.error(`Lead "${LEAD_ARG}" not found`); process.exit(1) }

  // Determine which FU step to run based on status
  let step
  switch (lead.status) {
    case 'connected':         step = 1; break
    case 'follow_up_sent':    step = 2; break
    case 'follow_up_sent_2':  step = 3; break
    case 'follow_up_sent_3':  step = 4; break
    case 'follow_up_sent_4':  step = 5; break
    default:
      console.error(`Lead "${lead.full_name}" status=${lead.status} — not eligible for followup`)
      process.exit(1)
  }

  console.log(`\n🎯 Single lead followup test`)
  console.log(`  Lead:     ${lead.full_name}`)
  console.log(`  Status:   ${lead.status}`)
  console.log(`  FU step:  ${step}`)
  console.log(`  Mode:     ${LIVE_SEND ? '🔴 LIVE SEND' : '🟢 DRY RUN (types but does not send)'}`)
  console.log()

  // Verify Josh is active
  const { data: account } = await supabase
    .from('linkedin_accounts')
    .select('label, status, li_at_cookie_updated_at')
    .eq('id', lead.campaigns.linkedin_account_id)
    .single()

  if (account.status !== 'active') {
    console.error(`Account "${account.label}" is ${account.status} — renew cookie via Orion first`)
    process.exit(1)
  }

  // Spawn followup.js with env that targets this single lead
  // followup.js doesn't have a single-lead mode by default, so we use SINGLE_LEAD_ID
  // (we'll need to add support in followup.js — see comment below).
  const env = {
    ...process.env,
    CAMPAIGN_ID:    lead.campaign_id,
    FOLLOW_UP_STEP: String(step),
    SINGLE_LEAD_ID: lead.id,   // followup.js will filter to just this one lead
    DRY_RUN:        'false',
    LIVE_SEND:      LIVE_SEND ? 'true' : 'false',
  }

  console.log(`▸ Spawning followup.js (step=${step}, single lead)...\n`)

  const child = spawn('node', ['followup.js'], {
    cwd: '/root/clawbot/apps/prometheus',
    env,
    stdio: 'inherit',
  })

  child.on('close', code => {
    console.log(`\n▸ followup.js exited with code ${code}`)

    // Re-query lead status to see if it moved
    supabase.from('leads').select('status, last_followup_at, last_followup2_at, last_followup3_at')
      .eq('id', lead.id).single()
      .then(({ data }) => {
        console.log(`▸ Lead status now: ${data.status}`)
        console.log(`  fu1: ${data.last_followup_at ?? 'null'}`)
        console.log(`  fu2: ${data.last_followup2_at ?? 'null'}`)
        console.log(`  fu3: ${data.last_followup3_at ?? 'null'}`)
        process.exit(code)
      })
  })
}

main().catch(e => { console.error('FATAL:', e); process.exit(2) })
