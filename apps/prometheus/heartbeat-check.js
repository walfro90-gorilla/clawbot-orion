#!/usr/bin/env node
/**
 * heartbeat-check.js — External scheduler watchdog
 *
 * Runs via system cron every 30 min during business hours.
 * If the scheduler hasn't logged a tick in 2+ hours → creates an
 * account_alert in Supabase (visible in Orion monitor) and optionally
 * sends a Slack notification.
 *
 * Cron (add via `crontab -e`):
 *   0,30 9-19 * * 1-5 node /root/clawbot/apps/prometheus/heartbeat-check.js >> /root/.pm2/logs/heartbeat.log 2>&1
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '/root/clawbot/apps/prometheus/.env' });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL || null;
const ALERT_TYPE    = 'scheduler_dead';
const STALE_MINS    = 120; // 2 hours

async function check() {
  // Get most recent scheduler tick
  const { data: lastLog } = await supabase
    .from('scheduler_log')
    .select('created_at, status')
    .eq('job_type', 'tick')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const now       = Date.now();
  const lastAt    = lastLog?.created_at ? new Date(lastLog.created_at).getTime() : null;
  const ageMins   = lastAt ? Math.round((now - lastAt) / 60000) : null;
  const isStale   = ageMins === null || ageMins > STALE_MINS;

  const stamp = new Date().toISOString();

  if (!isStale) {
    console.log(`[${stamp}] heartbeat OK — último tick hace ${ageMins} min`);
    // Resolve any existing open scheduler_dead alerts
    await supabase.from('account_alerts')
      .update({ resolved_at: stamp, resolved_by: 'auto — heartbeat recovered' })
      .eq('alert_type', ALERT_TYPE)
      .is('resolved_at', null);
    return;
  }

  const msg = ageMins === null
    ? 'El scheduler nunca ha registrado un tick. Verifica que esté corriendo con: pm2 status'
    : `El scheduler lleva ${ageMins} minutos sin actividad (último tick: ${new Date(lastAt).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}).`;

  console.error(`[${stamp}] ⚠️  SCHEDULER INACTIVO — ${msg}`);

  // Dedup: don't create duplicate alert if one already exists in last 4h
  const { data: existing } = await supabase
    .from('account_alerts')
    .select('id')
    .eq('alert_type', ALERT_TYPE)
    .is('resolved_at', null)
    .gte('created_at', new Date(now - 4 * 60 * 60 * 1000).toISOString())
    .maybeSingle();

  if (!existing) {
    await supabase.from('account_alerts').insert({
      alert_type:           ALERT_TYPE,
      severity:             'critical',
      message:              `Scheduler inactivo: ${msg}`,
      details:              { age_mins: ageMins, last_tick_at: lastLog?.created_at ?? null },
      linkedin_account_id:  null,
      campaign_id:          null,
    });
    console.log(`[${stamp}] Alerta creada en Orion.`);
  }

  // Optional Slack notification
  if (SLACK_WEBHOOK) {
    await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `🔴 *ClawBot — Scheduler inactivo*\n${msg}\nRevisa: \`pm2 restart prometheus-scheduler\``,
      }),
    }).catch(e => console.error('Slack error:', e.message));
  }
}

check().catch(e => {
  console.error(`[${new Date().toISOString()}] heartbeat-check fatal:`, e.message);
  process.exit(1);
});
