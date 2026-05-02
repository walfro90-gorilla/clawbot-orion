/**
 * batch.js — Prometheus batch processor
 *
 * Reads pending leads from Supabase and processes them one by one
 * using worker.js, with human-like delays between profiles.
 *
 * Usage:
 *   CAMPAIGN_ID=<uuid> node batch.js
 *   CAMPAIGN_ID=<uuid> BATCH_SIZE=10 DRY_RUN=false LIVE_SEND=true node batch.js
 *
 * The LinkedIn cookie (li_at) is resolved from the DB via the campaign's
 * linkedin_account_id — no need to set LI_AT in .env for multi-account setups.
 * LI_AT in .env is still accepted as a fallback override.
 */

import { spawn } from 'child_process';
import dotenv from 'dotenv';
import { supabase, logActivity, incrementDaily, checkDailyLimit, createAlert } from './lib/supabase.js';

dotenv.config();

const CAMPAIGN_ID = process.env.CAMPAIGN_ID;
const BATCH_SIZE  = parseInt(process.env.BATCH_SIZE || '5');
const DRY_RUN     = process.env.DRY_RUN !== 'false';
const LIVE_SEND   = process.env.LIVE_SEND === 'true';

// Delay between profiles: 60–180s in live mode, 5–10s in dry-run
// Simulates a human outreach session — reads profile, thinks, moves to next one
const DELAY_MIN_MS = DRY_RUN ? 5_000  :  60 * 1000;
const DELAY_MAX_MS = DRY_RUN ? 10_000 : 180 * 1000;

// Business hours gate — Mexico City time (UTC-5 in CDT / UTC-6 in CST)
// Runs Mon-Fri ONLY, 9:00am–7:00pm
function isBusinessHours() {
  const now = new Date();
  const mxHour = parseInt(
    new Intl.DateTimeFormat('es-MX', {
      timeZone: 'America/Mexico_City',
      hour: 'numeric', hour12: false,
    }).format(now)
  );
  const mxDay = new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City',
    weekday: 'long',
  }).format(now).toLowerCase(); // "lunes", "martes", ... "sábado", "domingo"

  const isWeekday = ['lunes','martes','miércoles','jueves','viernes'].some(d => mxDay.includes(d));
  const inHours   = mxHour >= 9 && mxHour < 19;
  return isWeekday && inHours; // SOLO lunes–viernes 9am–7pm MX
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Claim next pending lead for this campaign ─────────────────────────────
async function claimNextLead(campaignId) {
  const { data, error } = await supabase.rpc('claim_next_lead', {
    p_campaign_id: campaignId,
  });
  if (error) {
    console.error('[BATCH] claim_next_job error:', error.message);
    return null;
  }
  return Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
}

// ── Run worker.js for a single lead ──────────────────────────────────────
function runWorker(lead, liAt, proxyUrl) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      TARGET_PROFILE: lead.linkedin_url,
      LEAD_ID:        lead.id,
      CAMPAIGN_ID:    CAMPAIGN_ID,
      DRY_RUN:        String(DRY_RUN),
      LIVE_SEND:      String(LIVE_SEND),
      LI_AT:          liAt ?? '',
      ...(proxyUrl ? { PROXY_URL: proxyUrl } : {}),
    };

    const child = spawn('node', ['worker.js'], { env, stdio: 'pipe' });
    const lines = [];

    child.stdout.on('data', d => {
      const text = d.toString();
      process.stdout.write(text);
      lines.push(...text.split('\n').filter(Boolean));
    });

    child.stderr.on('data', d => {
      const text = d.toString();
      process.stderr.write(text);
      lines.push(...text.split('\n').filter(Boolean));
    });

    child.on('close', code => {
      resolve({ code, lines });
    });
  });
}

// ── Parse worker output to determine outcome ──────────────────────────────
function parseOutcome(lines, exitCode) {
  const all = lines.join('\n');

  if (exitCode === 2 || /CAPTCHA|checkpoint/i.test(all)) return 'captcha';
  if (/DISQUALIFIED/i.test(all))  return 'disqualified';
  if (/SENT|invitation sent|invitación/i.test(all)) return 'sent';
  if (/staged|STAGING/i.test(all)) return 'staged';
  if (/DRY.?RUN MODE|modo prueba/i.test(all)) return 'dry_run';
  if (/error|fatal/i.test(all))   return 'error';
  return 'unknown';
}

// ── Record outbound message in conversation_events ────────────────────────
async function recordOutbound(leadId, accountId) {
  // Fetch the AI message that was sent to this lead
  const { data: lead } = await supabase
    .from('leads')
    .select('ai_message, ai_subject')
    .eq('id', leadId)
    .single()

  const messageText = lead?.ai_message
  if (!messageText) return // no message text to record

  // Upsert conversation record (creates if not exists)
  const { data: conv } = await supabase
    .from('conversations')
    .upsert({
      lead_id:             leadId,
      linkedin_account_id: accountId,
      status:              'initiated',
    }, { onConflict: 'lead_id' })
    .select('id')
    .single()

  if (!conv?.id) return

  await supabase.from('conversation_events').insert({
    conversation_id: conv.id,
    event_type:      'invite_sent',
    direction:       'outbound',
    content:         messageText.slice(0, 4000),
    sent_at:         new Date().toISOString(),
  })
}

// ── Update lead status after worker run ──────────────────────────────────
// Returns true if the batch should stop (e.g., captcha detected)
async function updateLead(leadId, outcome, accountId) {
  let newStatus = null;

  if (outcome === 'sent') {
    newStatus = 'invite_sent';
  } else if (outcome === 'staged') {
    newStatus = 'pending';
  } else if (outcome === 'dry_run') {
    newStatus = 'scraped';
  } else if (outcome === 'disqualified') {
    newStatus = 'disqualified';
  } else if (outcome === 'captcha') {
    newStatus = 'pending'; // not the lead's fault — retry naturally
  } else if (outcome === 'error' || outcome === 'unknown') {
    // Retry logic: reset to pending up to 3 times before marking failed
    const { data: current } = await supabase
      .from('leads')
      .select('retry_count')
      .eq('id', leadId)
      .single();

    const retries = current?.retry_count ?? 0;
    if (retries < 3) {
      console.log(`[BATCH] Lead ${leadId} error — retry ${retries + 1}/3, resetting to pending.`);
      await supabase.from('leads').update({
        status:      'pending',
        retry_count: retries + 1,
      }).eq('id', leadId);
      return false; // don't stop batch
    }
    newStatus = 'failed';
    console.log(`[BATCH] Lead ${leadId} exhausted retries (${retries}) — marking failed.`);
  } else {
    newStatus = 'failed';
  }

  const updates = { status: newStatus };
  if (outcome === 'sent') updates.sent_at = new Date().toISOString();

  const { error } = await supabase
    .from('leads')
    .update(updates)
    .eq('id', leadId);

  if (error) console.warn(`[BATCH] Could not update lead ${leadId}:`, error.message);

  if (outcome === 'sent' && accountId) {
    await incrementDaily(accountId, 'invites_sent');
  }

  // Captcha means the LinkedIn session needs manual attention — stop the batch
  return outcome === 'captcha';
}

// ── Main ──────────────────────────────────────────────────────────────────
async function run() {
  if (!CAMPAIGN_ID) {
    console.error('[BATCH] ERROR: CAMPAIGN_ID not set'); process.exit(1);
  }

  // ── Resolve LinkedIn account from campaign (multi-account safe) ──────────
  // Primary: read li_at_cookie from the campaign's linked linkedin_account.
  // Fallback: LI_AT env var (single-account / legacy mode).
  const { data: campaignAccount, error: caErr } = await supabase
    .rpc('get_campaign_account', { p_campaign_id: CAMPAIGN_ID });

  let liAt       = null;
  let accountId  = null;
  let proxyUrl   = null;

  if (campaignAccount && campaignAccount.length > 0) {
    const acc = campaignAccount[0];
    liAt      = acc.li_at_cookie;
    accountId = acc.account_id;
    proxyUrl  = acc.proxy_url ?? null;
    console.log(`[BATCH] Account: ${acc.label ?? acc.account_id} | status=${acc.account_status} | limit=${acc.daily_limit}/day`);

    if (acc.account_status === 'banned') {
      console.error('[BATCH] LinkedIn account is banned — stopping.'); process.exit(1);
    }
    if (acc.account_status === 'rate_limited') {
      console.error('[BATCH] LinkedIn account is rate_limited — stopping.'); process.exit(1);
    }
  } else {
    if (caErr) console.warn('[BATCH] Could not load campaign account from DB:', caErr.message);
    // Fallback to env var (legacy / override)
    liAt = process.env.LI_AT ?? null;
    if (liAt && liAt !== 'PASTE_YOUR_LI_AT_COOKIE_HERE') {
      const { data: envAccount } = await supabase
        .from('linkedin_accounts')
        .select('id')
        .eq('li_at_cookie', liAt)
        .maybeSingle();
      accountId = envAccount?.id ?? null;
      console.log('[BATCH] Account resolved from LI_AT env var (fallback).');
    }
  }

  if (!liAt || liAt === 'PASTE_YOUR_LI_AT_COOKIE_HERE') {
    console.error('[BATCH] ERROR: No LinkedIn cookie found — set linkedin_account_id on the campaign or LI_AT in .env');
    process.exit(1);
  }

  if (accountId) {
    const withinLimit = await checkDailyLimit(accountId);
    if (!withinLimit) {
      console.log('[BATCH] Daily limit reached for this account — stopping.');
      process.exit(0);
    }
  }

  console.log(`[BATCH] Campaign ${CAMPAIGN_ID} | batch_size=${BATCH_SIZE} | dry_run=${DRY_RUN} | live_send=${LIVE_SEND}`);

  let processed = 0;
  let sent      = 0;
  let errors    = 0;

  for (let i = 0; i < BATCH_SIZE; i++) {
    // Business hours gate (skip in dry-run or if SKIP_HOURS_CHECK=true)
    if (!DRY_RUN && process.env.SKIP_HOURS_CHECK !== 'true' && !isBusinessHours()) {
      const now = new Intl.DateTimeFormat('es-MX', {
        timeZone: 'America/Mexico_City',
        hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: true,
      }).format(new Date());
      console.log(`[BATCH] Outside business hours (${now} MX) — stopping. Run again Mon-Fri 9am-7pm.`);
      break;
    }

    // Re-check daily limit each iteration
    if (accountId) {
      const withinLimit = await checkDailyLimit(accountId);
      if (!withinLimit) {
        console.log('[BATCH] Daily limit reached — stopping early.');
        break;
      }
    }

    // Claim next lead (sets status='processing' atomically)
    const lead = await claimNextLead(CAMPAIGN_ID);
    if (!lead) {
      console.log('[BATCH] No more pending leads — done.');
      break;
    }

    console.log(`\n[BATCH] ─────────────────────────────────────────────`);
    console.log(`[BATCH] Lead ${i + 1}/${BATCH_SIZE}: ${lead.full_name ?? lead.linkedin_url}`);
    console.log(`[BATCH] URL: ${lead.linkedin_url}`);

    const started = Date.now();
    const { code, lines } = await runWorker(lead, liAt, proxyUrl);
    const durationMs = Date.now() - started;

    const outcome = parseOutcome(lines, code);
    console.log(`[BATCH] Outcome: ${outcome} (exit ${code}, ${durationMs}ms)`);

    const shouldStop = await updateLead(lead.id, outcome, accountId);

    // Record outbound message in conversation history
    if (outcome === 'sent' && accountId) {
      await recordOutbound(lead.id, accountId)
    }

    if (shouldStop) {
      console.error('[BATCH] ⛔ CAPTCHA detected — stopping batch to protect account.');
      await logActivity(accountId, lead.id, 'captcha_detected', 'error', { campaign_id: CAMPAIGN_ID });
      // Crear alerta persistente visible en el dashboard
      await createAlert(
        accountId, CAMPAIGN_ID,
        'captcha', 'critical',
        `Captcha detectado durante el batch — la automatización fue pausada para proteger la cuenta.`,
        { lead_id: lead.id, lead_name: lead.full_name, profile_url: lead.linkedin_url },
        true // pauseCampaign
      );
      break;
    }
    await logActivity(accountId, lead.id, 'batch_process', outcome === 'error' ? 'error' : 'success', {
      campaign_id: CAMPAIGN_ID,
      outcome,
      exit_code: code,
    }, durationMs);

    processed++;
    if (outcome === 'sent') sent++;
    if (outcome === 'error') errors++;

    // Delay before next profile (skip on last iteration)
    if (i < BATCH_SIZE - 1) {
      const delay = randInt(DELAY_MIN_MS, DELAY_MAX_MS);
      const nextAt = new Date(Date.now() + delay).toLocaleTimeString('es-MX');
      console.log(`[BATCH] Cooling down ${Math.round(delay / 1000)}s — next profile at ~${nextAt}`);
      await sleep(delay);
    }
  }

  console.log(`\n[BATCH] ═════════════════════════════════════════════`);
  console.log(`[BATCH] Done. Processed: ${processed} | Sent: ${sent} | Errors: ${errors}`);

  await logActivity(accountId, null, 'batch_completed', 'success', {
    campaign_id: CAMPAIGN_ID,
    processed,
    sent,
    errors,
    dry_run:   DRY_RUN,
    live_send: LIVE_SEND,
  });
}

run().catch(err => {
  console.error('[BATCH] Fatal:', err);
  process.exit(1);
});
