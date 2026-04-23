import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || url.includes('your-project')) {
  throw new Error('[DB] SUPABASE_URL not set in .env');
}
if (!key || key.includes('your_service')) {
  throw new Error('[DB] SUPABASE_SERVICE_ROLE_KEY not set in .env');
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

export async function logActivity(accountId, leadId, action, result, details = {}, durationMs = null) {
  const { error } = await supabase.from('activity_log').insert({
    linkedin_account_id: accountId || null,
    lead_id:             leadId    || null,
    action,
    result,
    details,
    duration_ms: durationMs,
  });
  if (error) console.warn('[DB] logActivity failed:', error.message);
}

export async function incrementDaily(accountId, field) {
  if (!accountId) return;
  const { error } = await supabase.rpc('increment_daily_activity', {
    p_account_id: accountId,
    p_field:      field,
  });
  if (error) console.warn('[DB] incrementDaily failed:', error.message);
}

export async function checkDailyLimit(accountId) {
  if (!accountId) return true;
  const { data, error } = await supabase.rpc('check_daily_limit', {
    p_account_id: accountId,
  });
  if (error) { console.warn('[DB] checkDailyLimit failed:', error.message); return true; }
  return data ?? true;
}

/**
 * Crea una alerta en account_alerts y opcionalmente pausa la campaña.
 *
 * @param {string|null} accountId  - linkedin_accounts.id
 * @param {string|null} campaignId - campaigns.id
 * @param {'captcha'|'rate_limited'|'banned'|'cookie_expiry'|'error_spike'} alertType
 * @param {'info'|'warning'|'critical'} severity
 * @param {string} message         - Descripción legible del problema
 * @param {object} details         - Contexto adicional (urls, exit codes, etc.)
 * @param {boolean} pauseCampaign  - Si true, pone campaign.batch_paused = true
 */
// ── Slack notification ────────────────────────────────────────────────────────
const SLACK_ICONS = { critical: '🔴', warning: '🟡', info: '🔵' };

async function notifySlack(severity, alertType, message, details = {}) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return;

  const icon    = SLACK_ICONS[severity] ?? '🔔';
  const detailLine = Object.keys(details).length
    ? '\n```' + JSON.stringify(details, null, 2).slice(0, 400) + '```'
    : '';

  const body = {
    text: `${icon} *ClawBot — ${alertType.replace(/_/g, ' ').toUpperCase()}*\n${message}${detailLine}`,
  };

  await fetch(webhook, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }).catch(e => console.warn('[SLACK] notify failed:', e.message));
}

export async function createAlert(accountId, campaignId, alertType, severity, message, details = {}, pauseCampaign = false) {
  let autoPaused = false;

  // Auto-pausar la campaña si se pide y hay campaignId
  if (pauseCampaign && campaignId) {
    const { error: pauseErr } = await supabase
      .from('campaigns')
      .update({ batch_paused: true })
      .eq('id', campaignId);
    if (pauseErr) {
      console.warn('[DB] createAlert: could not pause campaign:', pauseErr.message);
    } else {
      autoPaused = true;
      console.warn(`[DB] ⛔ Campaña ${campaignId} pausada automáticamente.`);
    }
  }

  const { error } = await supabase.from('account_alerts').insert({
    linkedin_account_id: accountId || null,
    campaign_id:         campaignId || null,
    alert_type:          alertType,
    severity,
    message,
    details,
    auto_paused:         autoPaused,
  });

  if (error) console.warn('[DB] createAlert failed:', error.message);
  else       console.warn(`[ALERT] [${severity.toUpperCase()}] ${alertType}: ${message}`);

  // Slack: siempre en critical, nunca en info
  if (severity === 'critical' || severity === 'warning') {
    await notifySlack(severity, alertType, message, details);
  }
}
