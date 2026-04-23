/**
 * scheduler.js — Prometheus Orchestrator
 *
 * Proceso siempre activo (PM2) que orquesta search.js y batch.js
 * con timing aleatorio para no activar detección de bots en LinkedIn.
 *
 * Anti-ban principles:
 *   - Nunca corre a hora exacta (jitter ±10 min en cada tick)
 *   - Solo días hábiles, horario México City (9am–7pm)
 *   - Máx daily_invite_target invitaciones/día por cuenta
 *   - Gap mínimo configurable entre sesiones
 *   - Batch size aleatorio (no fijo)
 *   - Pausa automática si cuenta es rate_limited o banned
 *   - Todo logueado en scheduler_log para auditoría
 *
 * Usage:
 *   node scheduler.js                  # corre indefinidamente
 *   DRY_RUN=true node scheduler.js     # simula sin ejecutar workers
 */

import { spawn }  from 'child_process';
import dotenv     from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createAlert } from './lib/supabase.js';

dotenv.config();

const __dirname   = dirname(fileURLToPath(import.meta.url));
const DRY_RUN     = process.env.DRY_RUN === 'true';
const LIVE_SEND   = process.env.LIVE_SEND !== 'false'; // true by default in scheduler

// ── Supabase ──────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ── Helpers ───────────────────────────────────────────────────────────────────
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep   = (ms)       => new Promise(r => setTimeout(r, ms));

// ── Account locking — prevents two campaigns of the same account running in parallel ─
// Map<accountId, lockedAtMs> — auto-expires after 20 min to survive worker hangs.
const accountLocks = new Map();
const ACCOUNT_LOCK_TTL_MS = 20 * 60 * 1000; // 20 min max per campaign run

function acquireLock(accountId) {
  const existing = accountLocks.get(accountId);
  if (existing && Date.now() - existing < ACCOUNT_LOCK_TTL_MS) return false; // locked
  accountLocks.set(accountId, Date.now());
  return true;
}
function releaseLock(accountId) { accountLocks.delete(accountId); }

/** Hora actual en Mexico City */
function mxTime() {
  const now = new Date();
  const mxHour = parseInt(
    new Intl.DateTimeFormat('es-MX', {
      timeZone: 'America/Mexico_City', hour: 'numeric', hour12: false,
    }).format(now)
  );
  const mxDay = new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City', weekday: 'long',
  }).format(now).toLowerCase();
  const mxDate = new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: true,
  }).format(now);
  return { mxHour, mxDay, mxDate, now };
}

/** true si estamos en horario laboral México según config de campaña */
function isBusinessHours(startHour = 9, endHour = 19) {
  const { mxHour, mxDay } = mxTime();
  const weekdays = ['lunes','martes','miércoles','jueves','viernes'];
  return weekdays.some(d => mxDay.includes(d)) && mxHour >= startHour && mxHour < endHour;
}

/** Inbox puede correr Lun–Sáb 8–21h — solo lectura, riesgo muy bajo */
function isInboxHours() {
  const { mxHour, mxDay } = mxTime();
  const inboxDays = ['lunes','martes','miércoles','jueves','viernes','sábado'];
  return inboxDays.some(d => mxDay.includes(d)) && mxHour >= 8 && mxHour < 21;
}

/** Minutos transcurridos desde una fecha ISO */
function minutesSince(isoDate) {
  if (!isoDate) return Infinity;
  return (Date.now() - new Date(isoDate).getTime()) / 60_000;
}

/** Log en scheduler_log */
async function logJob({ campaignId, accountId, jobType, status, skipReason, leadsFound, leadsSent, batchSize, durationMs, details }) {
  await supabase.from('scheduler_log').insert({
    campaign_id:  campaignId  ?? null,
    account_id:   accountId   ?? null,
    job_type:     jobType,
    status,
    skip_reason:  skipReason  ?? null,
    leads_found:  leadsFound  ?? null,
    leads_sent:   leadsSent   ?? null,
    batch_size:   batchSize   ?? null,
    duration_ms:  durationMs  ?? null,
    details:      details     ?? {},
  });
}

// ── Worker runner ─────────────────────────────────────────────────────────────

/** Corre un script Node.js como proceso hijo y espera a que termine */
function runScript(scriptName, envOverrides = {}) {
  return new Promise((resolve) => {
    const scriptPath = join(__dirname, scriptName);
    const env = { ...process.env, ...envOverrides };
    const child = spawn('node', [scriptPath], { env, stdio: 'pipe' });
    const lines = [];

    child.stdout.on('data', d => {
      const text = d.toString();
      process.stdout.write(`[${scriptName}] ${text}`);
      lines.push(...text.split('\n').filter(Boolean));
    });
    child.stderr.on('data', d => {
      const text = d.toString();
      process.stderr.write(`[${scriptName}] ${text}`);
      lines.push(...text.split('\n').filter(Boolean));
    });
    child.on('close', code => resolve({ code, lines }));
  });
}

// ── Parse outcome from batch.js output ───────────────────────────────────────
function parseBatchOutput(lines) {
  const all = lines.join('\n');
  const sentMatch  = all.match(/Sent:\s*(\d+)/i);
  const procMatch  = all.match(/Processed:\s*(\d+)/i);
  return {
    sent:      sentMatch  ? parseInt(sentMatch[1])  : 0,
    processed: procMatch  ? parseInt(procMatch[1])  : 0,
  };
}

function parseSearchOutput(lines) {
  const all = lines.join('\n');
  const savedMatch = all.match(/Saved\s+(\d+)\s+new/i);
  return { saved: savedMatch ? parseInt(savedMatch[1]) : 0 };
}

// ── Cookie staleness guard ────────────────────────────────────────────────────
// Retorna true si la cookie tiene >60 días y no se debe ejecutar ningún script browser
function isCookieExpiredCritical(account) {
  if (!account.li_at_cookie_updated_at) return false; // sin fecha → permitir (alerta separada)
  const daysSince = (Date.now() - new Date(account.li_at_cookie_updated_at).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince >= 60;
}

// ── Inbox job ─────────────────────────────────────────────────────────────────

// Corre inbox.js para una cuenta si pasó el cooldown mínimo
async function runInboxJob(account) {
  const minInboxGapMin = account.inbox_gap_min ?? 45; // 45 min default: ~3 revisiones por hora hábil
  const minutesSinceCheck = minutesSince(account.last_inbox_check_at);

  if (minutesSinceCheck < minInboxGapMin) {
    const remaining = Math.round(minInboxGapMin - minutesSinceCheck);
    console.log(`[SCHEDULER] 📬 Inbox "${account.label}" — cooldown activo (faltan ~${remaining} min).`);
    return;
  }

  if (isCookieExpiredCritical(account)) {
    console.error(`[SCHEDULER] 🚫 Cookie de "${account.label}" tiene >60 días — saltando inbox para evitar auth wall.`);
    return;
  }

  console.log(`[SCHEDULER] 📬 Revisando inbox de "${account.label}"...`);
  if (!account.proxy_url) {
    console.warn(`[SCHEDULER] ⚠️  Sin proxy para inbox "${account.label}" — ban risk alto.`);
  }
  const t0 = Date.now();

  if (DRY_RUN) {
    console.log(`[SCHEDULER] [DRY_RUN] Simularía: node inbox.js ACCOUNT_ID=${account.id}`);
    return;
  }

  const { code, lines } = await runScript('inbox.js', {
    ACCOUNT_ID: account.id,
    ...(account.proxy_url ? { PROXY_URL: account.proxy_url } : {}),
  });

  const durationMs = Date.now() - t0;
  const allOutput  = lines.join('\n');

  // Detectar cookie expirada
  if (/cookie expired|re-login required/i.test(allOutput)) {
    console.warn(`[SCHEDULER] ⚠️  Cookie expirada en cuenta "${account.label}" — marcando como rate_limited.`);
    await supabase.from('linkedin_accounts')
      .update({ status: 'rate_limited' })
      .eq('id', account.id);
    await createAlert(
      account.id, null,
      'cookie_expiry', 'critical',
      `Cookie expirada en cuenta "${account.label}" — requiere re-login manual.`,
      { account_label: account.label, detected_in: 'inbox' }
    );
  }

  const connectedMatch = allOutput.match(/Connected:\s*(\d+)/i);
  const repliedMatch   = allOutput.match(/Replied:\s*(\d+)/i);

  console.log(`[SCHEDULER] ✅ Inbox done: connected=${connectedMatch?.[1]??0} replied=${repliedMatch?.[1]??0} (${(durationMs/1000).toFixed(1)}s)`);
}

// ── Main tick ─────────────────────────────────────────────────────────────────

async function tick() {
  const { mxDate } = mxTime();
  console.log(`\n[SCHEDULER] ═══════════════════════════════════════`);
  console.log(`[SCHEDULER] Tick @ ${mxDate}`);

  // Check horario global: batch/search solo Lun–Vie 9–19h; inbox también sábado 8–21h
  const inGlobalHours  = isBusinessHours();
  const inInboxHours   = isInboxHours();

  if (!inGlobalHours && !inInboxHours) {
    console.log(`[SCHEDULER] Fuera de horario (batch: Lun–Vie 9–19 / inbox: Lun–Sáb 8–21) — skip.`);
    await logJob({ jobType: 'tick', status: 'skipped', skipReason: 'outside_business_hours' });
    return;
  }

  // ── Cargar campañas activas con su cuenta LinkedIn ──────────────────────────
  const { data: campaigns, error } = await supabase
    .from('campaigns')
    .select(`
      id, name, batch_paused, search_paused, follow_up_paused, min_pending_threshold, daily_invite_target,
      min_batch_gap_min, search_gap_hours, schedule_start_hour, schedule_end_hour,
      last_searched_at, last_batch_at, last_followup_at, last_followup2_at, last_followup3_at,
      follow_up_message, follow_up_delay_days,
      follow_up_step2_message, follow_up_step2_delay_days,
      follow_up_step3_message, follow_up_step3_delay_days,
      auto_dead_after_days,
      search_keywords, search_location, search_count,
      linkedin_account_id,
      linkedin_accounts (
        id, label, li_at_cookie, status, daily_connection_limit, proxy_url,
        last_inbox_check_at, inbox_paused, inbox_gap_min, li_at_cookie_updated_at,
        warmup_status, warmup_started_at
      )
    `)
    .eq('is_active', true);

  if (error || !campaigns?.length) {
    console.log('[SCHEDULER] No hay campañas activas.');
    return;
  }

  await logJob({ jobType: 'tick', status: 'started', details: { campaigns: campaigns.length, inGlobalHours, inInboxHours } });

  // ── Procesar campañas (search + batch) — solo en horario de negocio ──────────
  if (inGlobalHours) {
    for (const campaign of campaigns) {
      await processCampaign(campaign);
      await sleep(randInt(3000, 8000));
    }
  } else {
    console.log('[SCHEDULER] Fuera de horario batch/search — solo correrá inbox.');
  }

  // ── Revisar inbox por cada cuenta única ─────────────────────────────────────
  // El inbox se revisa por cuenta, no por campaña — dedup por account.id
  // Corre Lun–Sáb 8–21h (solo lectura = bajo riesgo de baneo)
  if (inInboxHours) {
    const accountsSeen = new Map();
    for (const c of campaigns) {
      if (c.linkedin_accounts && !accountsSeen.has(c.linkedin_accounts.id)) {
        accountsSeen.set(c.linkedin_accounts.id, c.linkedin_accounts);
      }
    }

    // ── Cookie staleness check (una vez por tick) ───────────────────────────
    for (const account of accountsSeen.values()) {
      if (!account.li_at_cookie_updated_at) {
        // Cookie nunca actualizada — siempre crear alerta
        const { data: existing } = await supabase
          .from('account_alerts')
          .select('id')
          .eq('linkedin_account_id', account.id)
          .eq('alert_type', 'cookie_expiry')
          .is('resolved_at', null)
          .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
          .maybeSingle();
        if (!existing) {
          console.warn(`[SCHEDULER] ⚠️  Cookie de "${account.label}" nunca fue registrada — verifica que li_at_cookie_updated_at esté seteado.`);
          await createAlert(
            account.id, null,
            'cookie_expiry', 'warning',
            `Cookie de LinkedIn de "${account.label}" no tiene fecha de actualización registrada. Actualízala en la sección Cuentas.`,
            { account_label: account.label, days_old: null }
          );
        }
        continue;
      }
      const daysSince = (Date.now() - new Date(account.li_at_cookie_updated_at).getTime()) / (1000 * 60 * 60 * 24);
      // Umbrales: warning ≥ 30 días, critical ≥ 60 días
      // LinkedIn li_at cookies duran ~1 año pero en automatización rotar cada 30-60 días reduce riesgo de detección
      if (daysSince >= 30) {
        const { data: existing } = await supabase
          .from('account_alerts')
          .select('id')
          .eq('linkedin_account_id', account.id)
          .eq('alert_type', 'cookie_expiry')
          .is('resolved_at', null)
          .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
          .maybeSingle();

        if (!existing) {
          const isCritical = daysSince >= 60;
          console.warn(`[SCHEDULER] ⚠️  Cookie de "${account.label}" tiene ${Math.round(daysSince)} días — ${isCritical ? 'CRÍTICO' : 'advertencia'}.`);
          await createAlert(
            account.id, null,
            'cookie_expiry', isCritical ? 'critical' : 'warning',
            `Cookie de LinkedIn de "${account.label}" tiene ${Math.round(daysSince)} días sin renovar. ${isCritical ? 'Riesgo alto de desconexión — renuévala ahora.' : 'Renuévala antes de los 60 días para mantener la automatización estable.'}`,
            { account_label: account.label, days_old: Math.round(daysSince) }
          );
        }
      }
    }

    for (const account of accountsSeen.values()) {
      if (account.status !== 'active') continue;
      if (account.inbox_paused) {
        console.log(`[SCHEDULER] ⏸  Inbox pausado para cuenta "${account.label}".`);
        continue;
      }
      await sleep(randInt(5000, 15000)); // pausa natural antes del inbox
      await runInboxJob(account);
    }

    // ── Auto-reply: enviar drafts programados por Gemini ─────────────────────
    for (const account of accountsSeen.values()) {
      if (account.status !== 'active') continue;
      await runAutoReplyJob(account).catch(e =>
        console.error(`[SCHEDULER] runAutoReplyJob error para "${account.label}":`, e.message)
      );
    }
  }

  console.log(`[SCHEDULER] Tick completado.`);
}

// ── Procesar una campaña ──────────────────────────────────────────────────────

async function processCampaign(campaign) {
  const account = campaign.linkedin_accounts;
  const cid     = campaign.id;
  const cname   = campaign.name;
  const accountId = account?.id;

  console.log(`\n[SCHEDULER] Campaña: "${cname}"`);

  // Guard: cookie expirada (>60 días) — no correr scripts browser
  if (account && isCookieExpiredCritical(account)) {
    console.error(`[SCHEDULER] 🚫 Cookie de "${account.label}" tiene >60 días — saltando campaña "${cname}" para evitar auth wall.`);
    await logJob({ campaignId: cid, accountId, jobType: 'tick', status: 'skipped', skipReason: 'cookie_expired_critical' });
    return;
  }

  // Guard: otra campaña del mismo account ya está en proceso este tick
  if (accountId && !acquireLock(accountId)) {
    console.log(`[SCHEDULER] ⚠️  Cuenta "${account?.label}" ocupada (otra campaña en curso) — skip "${cname}".`);
    await logJob({ campaignId: cid, accountId, jobType: 'tick', status: 'skipped', skipReason: 'account_locked' });
    return;
  }

  try {
    // Guard: horario específico de la campaña (puede diferir del global)
    const campStartHour = campaign.schedule_start_hour ?? 9;
    const campEndHour   = campaign.schedule_end_hour   ?? 19;
    if (!isBusinessHours(campStartHour, campEndHour)) {
      const { mxHour } = mxTime();
      console.log(`[SCHEDULER] ⏰ "${cname}" fuera de su horario (${campStartHour}–${campEndHour}h, ahora ${mxHour}h MX) — skip.`);
      return;
    }

    // Guard: campaña pausada manualmente (ambos jobs)
    if (campaign.batch_paused && campaign.search_paused) {
      console.log(`[SCHEDULER] ⏸  Campaña completamente pausada — skip.`);
      await logJob({ campaignId: cid, jobType: 'tick', status: 'skipped', skipReason: 'campaign_paused' });
      return;
    }

    // Guard: sin cuenta asignada
    if (!account) {
      console.log(`[SCHEDULER] ⚠️  Sin cuenta LinkedIn — skip.`);
      await logJob({ campaignId: cid, jobType: 'batch', status: 'skipped', skipReason: 'no_account' });
      return;
    }

    // Guard: cuenta no activa
    if (account.status !== 'active') {
      console.log(`[SCHEDULER] ⛔ Cuenta "${account.label ?? accountId}" status=${account.status} — skip.`);
      await logJob({ campaignId: cid, accountId, jobType: 'batch', status: 'skipped', skipReason: `account_${account.status}` });
      return;
    }

    // Guard: límite diario ya alcanzado
    const { data: limitOk } = await supabase.rpc('check_daily_limit', { p_account_id: accountId });
    if (!limitOk) {
      console.log(`[SCHEDULER] 🛑 Límite diario alcanzado para "${account.label ?? accountId}".`);
      await logJob({ campaignId: cid, accountId, jobType: 'batch', status: 'skipped', skipReason: 'daily_limit_reached' });
      return;
    }

    // Contar pending leads
    const { count: pendingCount } = await supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', cid)
      .eq('status', 'pending');

    console.log(`[SCHEDULER] Pending leads: ${pendingCount ?? 0} | Threshold: ${campaign.min_pending_threshold}`);

    // ── SEARCH: buscar más leads si están por debajo del umbral ─────────────────
    const searchedHoursAgo = minutesSince(campaign.last_searched_at) / 60;
    const needsSearch      = (pendingCount ?? 0) < campaign.min_pending_threshold;
    const searchGapHours   = campaign.search_gap_hours ?? 20;
    const searchCooldownOk = searchedHoursAgo > searchGapHours;

    if (campaign.search_paused) {
      console.log(`[SCHEDULER] ⏸  Search pausado para esta campaña.`);
    } else if (needsSearch && searchCooldownOk) {
      await runSearchJob(campaign, accountId);
    } else if (needsSearch && !searchCooldownOk) {
      console.log(`[SCHEDULER] 🔍 Necesita leads pero último search fue hace ${searchedHoursAgo.toFixed(1)}h (gap: ${searchGapHours}h) — cooldown activo.`);
    }

    // ── BATCH: contactar leads si hay pending y pasó el gap mínimo ──────────────
    const batchGapOk = minutesSince(campaign.last_batch_at) >= campaign.min_batch_gap_min;
    const hasPending = (pendingCount ?? 0) > 0;

    if (campaign.batch_paused) {
      console.log(`[SCHEDULER] ⏸  Batch pausado para esta campaña.`);
    } else if (hasPending && batchGapOk) {
      await runBatchJob(campaign, account);
    } else if (hasPending && !batchGapOk) {
      const remaining = Math.round(campaign.min_batch_gap_min - minutesSince(campaign.last_batch_at));
      console.log(`[SCHEDULER] ⏳ Hay leads pero gap mínimo no cumplido — faltan ~${remaining} min.`);
    } else if (!hasPending) {
      console.log(`[SCHEDULER] 📭 Sin leads pending — nada que enviar.`);
    }

    // ── FOLLOW-UP step 1: mensajes de seguimiento a leads conectados sin respuesta ──
    if (campaign.follow_up_message) {
      // Gap mínimo entre runs de follow-up: 6h
      const followupGapOk = minutesSince(campaign.last_followup_at) >= 6 * 60;
      if (campaign.follow_up_paused) {
        console.log(`[SCHEDULER] ⏸  Follow-up pausado para esta campaña.`);
      } else if (followupGapOk) {
        await runFollowupJob(campaign, account, 1);
      } else {
        const remaining = Math.round(6 * 60 - minutesSince(campaign.last_followup_at));
        console.log(`[SCHEDULER] ⏳ Follow-up step 1 gap activo — faltan ~${remaining} min.`);
      }
    }

    // ── FOLLOW-UP step 2: segundo seguimiento a leads que recibieron step 1 ──────
    if (campaign.follow_up_step2_message && !campaign.follow_up_paused) {
      const followup2GapOk = minutesSince(campaign.last_followup2_at) >= 8 * 60; // 8h gap
      if (followup2GapOk) {
        await runFollowupJob(campaign, account, 2);
      } else {
        const remaining = Math.round(8 * 60 - minutesSince(campaign.last_followup2_at));
        console.log(`[SCHEDULER] ⏳ Follow-up step 2 gap activo — faltan ~${remaining} min.`);
      }
    }

    // ── FOLLOW-UP step 3: mensaje de cierre — gap conservador 24h ────────────────
    if (campaign.follow_up_step3_message && !campaign.follow_up_paused) {
      const followup3GapOk = minutesSince(campaign.last_followup3_at) >= 24 * 60; // 24h gap
      if (followup3GapOk) {
        await runFollowupJob(campaign, account, 3);
      } else {
        const remaining = Math.round(24 * 60 - minutesSince(campaign.last_followup3_at));
        console.log(`[SCHEDULER] ⏳ Follow-up step 3 gap activo — faltan ~${remaining} min.`);
      }
    }

    // ── GHOST: marcar como muertos los leads que no respondieron tras FU2 ────────
    await runGhostJob(campaign);

  } finally {
    // Siempre liberar el lock aunque haya error o return temprano
    if (accountId) releaseLock(accountId);
  }
}

// ── Ghost job — auto-dead leads sin respuesta después del último follow-up ────
//
// Reglas:
//   FU2 enviado (follow_up_sent_2) + last_followup2_at > auto_dead_after_days → dead
//   FU1 enviado (follow_up_sent)  + sin FU2 configurado + last_followup_at > (auto_dead_after_days + 7) → dead
//   invite_sent sin conexión aceptada en 30 días → dead (ghosted antes de conectar)
//
async function runGhostJob(campaign) {
  const deadDays  = campaign.auto_dead_after_days ?? 21;
  const cid       = campaign.id;
  const now       = new Date();

  // Helper: timestamp of X days ago
  const daysAgo = (d) => new Date(now - d * 86400000).toISOString();

  let ghosted = 0;

  // ── Case 1a: follow_up_sent_3 + no reply after deadDays ────────────────────
  if (campaign.follow_up_step3_message) {
    const { data: fu3Leads } = await supabase
      .from('leads')
      .select('id, full_name')
      .eq('campaign_id', cid)
      .eq('status', 'follow_up_sent_3')
      .lte('last_followup3_at', daysAgo(deadDays));

    if (fu3Leads?.length) {
      const ids = fu3Leads.map(l => l.id);
      await supabase.from('leads').update({
        status:      'dead',
        dead_reason: `ghosted_after_fu3 — sin respuesta ${deadDays}d tras último follow-up`,
      }).in('id', ids);
      ghosted += ids.length;
      console.log(`[SCHEDULER] 💀 Ghost job: ${ids.length} leads → dead (FU3 sin respuesta en ${deadDays}d) — "${campaign.name}"`);
    }
  }

  // ── Case 1b: follow_up_sent_2 + no reply after deadDays (sin FU3 configurado) ─
  if (!campaign.follow_up_step3_message) {
  const { data: fu2Leads } = await supabase
    .from('leads')
    .select('id, full_name')
    .eq('campaign_id', cid)
    .eq('status', 'follow_up_sent_2')
    .lte('last_followup2_at', daysAgo(deadDays));

  if (fu2Leads?.length) {
    const ids = fu2Leads.map(l => l.id);
    await supabase.from('leads').update({
      status:      'dead',
      dead_reason: `ghosted_after_fu2 — sin respuesta ${deadDays}d tras último follow-up`,
    }).in('id', ids);
    ghosted += ids.length;
    console.log(`[SCHEDULER] 💀 Ghost job: ${ids.length} leads → dead (FU2 sin respuesta en ${deadDays}d) — "${campaign.name}"`);
  }
  }

  // ── Case 2: follow_up_sent (sin FU2 configurado) + no reply after deadDays+7 ─
  if (!campaign.follow_up_step2_message) {
    const fu1DeadDays = deadDays + 7;
    const { data: fu1Leads } = await supabase
      .from('leads')
      .select('id, full_name, sent_at')
      .eq('campaign_id', cid)
      .eq('status', 'follow_up_sent')
      .lte('sent_at', daysAgo(fu1DeadDays));

    if (fu1Leads?.length) {
      const ids = fu1Leads.map(l => l.id);
      await supabase.from('leads').update({
        status:      'dead',
        dead_reason: `ghosted_after_fu1 — sin respuesta ${fu1DeadDays}d tras último follow-up`,
      }).in('id', ids);
      ghosted += ids.length;
      console.log(`[SCHEDULER] 💀 Ghost job: ${ids.length} leads → dead (FU1 sin respuesta en ${fu1DeadDays}d) — "${campaign.name}"`);
    }
  }

  // ── Case 3: invite_sent + 30 días sin aceptar ────────────────────────────────
  const INVITE_EXPIRE_DAYS = 30;
  const { data: inviteLeads } = await supabase
    .from('leads')
    .select('id, full_name')
    .eq('campaign_id', cid)
    .eq('status', 'invite_sent')
    .lte('sent_at', daysAgo(INVITE_EXPIRE_DAYS));

  if (inviteLeads?.length) {
    const ids = inviteLeads.map(l => l.id);
    await supabase.from('leads').update({
      status:      'dead',
      dead_reason: `invite_expired — invitación sin aceptar en ${INVITE_EXPIRE_DAYS} días`,
    }).in('id', ids);
    ghosted += ids.length;
    console.log(`[SCHEDULER] 💀 Ghost job: ${ids.length} leads → dead (invite expirada ${INVITE_EXPIRE_DAYS}d) — "${campaign.name}"`);
  }

  if (ghosted === 0) {
    console.log(`[SCHEDULER] 👻 Ghost job: sin leads para marcar como muertos — "${campaign.name}"`);
  }
}

// ── Auto-reply job — envía drafts de Gemini programados ──────────────────────
// Scope: por cuenta (no por campaña). Corre en cada tick de inbox.
// Busca conversaciones con ai_reply_scheduled_at vencido y las envía via reply.js.

async function runAutoReplyJob(account) {
  const { data: dueDrafts, error } = await supabase
    .from('conversations')
    .select('id, lead_id, ai_reply_draft, conversation_turn')
    .eq('linkedin_account_id', account.id)
    .not('ai_reply_scheduled_at', 'is', null)
    .lte('ai_reply_scheduled_at', new Date().toISOString())
    .not('ai_reply_draft', 'is', null)
    .limit(3); // máx 3 auto-replies por tick (anti-ban)

  if (error) {
    console.error(`[SCHEDULER] runAutoReplyJob query error:`, error.message);
    return;
  }

  if (!dueDrafts?.length) return;

  console.log(`[SCHEDULER] 🤖 Auto-reply: ${dueDrafts.length} draft(s) listos para "${account.label}"`);

  for (const conv of dueDrafts) {
    // Guard: draft must be a non-empty string before sending
    if (!conv.ai_reply_draft?.trim()) {
      console.warn(`[SCHEDULER] ⚠️  Draft vacío/nulo para conv ${conv.id} — cancelando scheduled_at.`);
      await supabase.from('conversations').update({ ai_reply_scheduled_at: null }).eq('id', conv.id);
      continue;
    }

    // Limpiar scheduling ANTES de enviar (evita doble envío si el tick se solapa)
    await supabase.from('conversations')
      .update({ ai_reply_scheduled_at: null })
      .eq('id', conv.id);

    const { code } = await runScript('reply.js', {
      LEAD_ID:       conv.lead_id,
      REPLY_MESSAGE: conv.ai_reply_draft,
      DRY_RUN:       'false',
      LIVE_SEND:     'true',
      PROXY_URL:     account.proxy_url ?? '',
    });

    if (code === 0) {
      const nextTurn = (conv.conversation_turn ?? 0) + 1;
      await supabase.from('conversations').update({
        ai_reply_draft:        null,
        ai_draft_generated_at: null,
        conversation_turn:     nextTurn,
      }).eq('id', conv.id);
      console.log(`[SCHEDULER] 🤖 Auto-reply enviado → turno ${nextTurn} (conv ${conv.id})`);
    } else {
      // Fallo en el envío — restaurar scheduled_at para reintentar en el siguiente tick
      const retryAt = new Date(Date.now() + 15 * 60_000).toISOString(); // +15 min
      await supabase.from('conversations')
        .update({ ai_reply_scheduled_at: retryAt })
        .eq('id', conv.id);
      console.warn(`[SCHEDULER] ⚠️  Auto-reply falló (code=${code}) para conv ${conv.id} — reintento en 15 min`);
    }

    await sleep(randInt(3000, 8000)); // pequeña pausa entre envíos
  }
}

// ── Search job ────────────────────────────────────────────────────────────────

async function runSearchJob(campaign, accountId) {
  console.log(`[SCHEDULER] 🔍 Iniciando search para "${campaign.name}"...`);
  const t0 = Date.now();

  await logJob({ campaignId: campaign.id, accountId, jobType: 'search', status: 'started' });

  // Actualizar last_searched_at
  await supabase.from('campaigns').update({ last_searched_at: new Date().toISOString() }).eq('id', campaign.id);

  if (!campaign.linkedin_accounts?.proxy_url) {
    console.warn(`[SCHEDULER] ⚠️  Sin proxy para search "${campaign.name}" — ban risk alto en IPs de datacenter.`);
  }

  if (DRY_RUN) {
    console.log(`[SCHEDULER] [DRY_RUN] Simularía: node search.js CAMPAIGN_ID=${campaign.id}`);
    await logJob({ campaignId: campaign.id, accountId, jobType: 'search', status: 'skipped', skipReason: 'dry_run' });
    return;
  }

  const { code, lines } = await runScript('search.js', {
    CAMPAIGN_ID: campaign.id,
    LI_AT:       campaign.linkedin_accounts?.li_at_cookie,
    ...(campaign.linkedin_accounts?.proxy_url ? { PROXY_URL: campaign.linkedin_accounts.proxy_url } : {}),
  });

  const { saved } = parseSearchOutput(lines);
  const durationMs = Date.now() - t0;

  await logJob({
    campaignId: campaign.id, accountId, jobType: 'search',
    status:     code === 0 ? 'completed' : 'error',
    leadsFound: saved, durationMs,
    details:    { exit_code: code },
  });

  console.log(`[SCHEDULER] ✅ Search done: +${saved} leads (${(durationMs/1000).toFixed(1)}s)`);
}

// Warmup caps: limitan las invitaciones diarias según la temperatura de la cuenta
// Esto es independiente del daily_invite_target de la campaña — se usa el mínimo de ambos.
const WARMUP_CAPS = { cold: 3, warming: 8, warm: 15, hot: Infinity };

// ── Batch job ─────────────────────────────────────────────────────────────────

async function runBatchJob(campaign, account) {
  // Batch size aleatorio: entre 3 y min(6, daily_target - ya_enviados_hoy)
  const { data: todayStats } = await supabase
    .from('daily_activity')
    .select('invites_sent, messages_sent')
    .eq('linkedin_account_id', account.id)
    .eq('date', new Date().toISOString().split('T')[0])
    .maybeSingle();

  const sentToday    = (todayStats?.invites_sent ?? 0) + (todayStats?.messages_sent ?? 0);
  const warmupCap    = WARMUP_CAPS[account.warmup_status ?? 'cold'] ?? 3;
  const effectiveCap = Math.min(campaign.daily_invite_target, warmupCap);

  if (warmupCap < campaign.daily_invite_target) {
    console.log(`[SCHEDULER] 🌡️  Warmup cap activo: "${account.label}" es ${account.warmup_status ?? 'cold'} → max ${warmupCap}/día (campaña pide ${campaign.daily_invite_target}/día)`);
  }

  const remaining   = Math.max(0, effectiveCap - sentToday);

  if (remaining === 0) {
    console.log(`[SCHEDULER] 🛑 Cap diario alcanzado (${sentToday}/${effectiveCap} — warmup: ${account.warmup_status ?? 'cold'}).`);
    await logJob({
      campaignId: campaign.id, accountId: account.id, jobType: 'batch',
      status: 'skipped', skipReason: 'daily_target_reached',
      details: { sent_today: sentToday, effective_cap: effectiveCap, warmup_status: account.warmup_status },
    });
    return;
  }

  if (!account.proxy_url) {
    console.warn(`[SCHEDULER] ⚠️  Sin proxy para batch "${campaign.name}" (cuenta: ${account.label ?? account.id}) — ban risk alto.`);
  }

  // Batch size: aleatorio entre 3 y min(6, remaining) para variar el patrón
  const batchSize = randInt(3, Math.min(6, remaining));
  console.log(`[SCHEDULER] 📤 Batch "${campaign.name}" | size=${batchSize} | enviados hoy=${sentToday}/${campaign.daily_invite_target}`);

  const t0 = Date.now();
  await logJob({
    campaignId: campaign.id, accountId: account.id, jobType: 'batch',
    status: 'started', batchSize,
  });

  // Actualizar last_batch_at
  await supabase.from('campaigns').update({ last_batch_at: new Date().toISOString() }).eq('id', campaign.id);

  if (DRY_RUN) {
    console.log(`[SCHEDULER] [DRY_RUN] Simularía: node batch.js CAMPAIGN_ID=${campaign.id} BATCH_SIZE=${batchSize}`);
    await logJob({
      campaignId: campaign.id, accountId: account.id, jobType: 'batch',
      status: 'skipped', skipReason: 'dry_run', batchSize,
    });
    return;
  }

  const { code, lines } = await runScript('batch.js', {
    CAMPAIGN_ID: campaign.id,
    BATCH_SIZE:  String(batchSize),
    DRY_RUN:     'false',
    LIVE_SEND:   String(LIVE_SEND),
    LI_AT:       account.li_at_cookie,
    ...(account.proxy_url ? { PROXY_URL: account.proxy_url } : {}),
  });

  const { sent } = parseBatchOutput(lines);
  const durationMs = Date.now() - t0;

  await logJob({
    campaignId: campaign.id, accountId: account.id, jobType: 'batch',
    status:     code === 0 ? 'completed' : 'error',
    leadsSent:  sent, batchSize, durationMs,
    details:    { exit_code: code },
  });

  console.log(`[SCHEDULER] ✅ Batch done: ${sent} enviados (${(durationMs/1000).toFixed(1)}s)`);

  // Si el worker falló con exit 2 = captcha detectado
  if (code === 2) {
    console.error(`[SCHEDULER] ⛔ Captcha detectado en batch — cuenta: "${account.label}".`);
    await supabase.from('linkedin_accounts').update({ status: 'rate_limited' }).eq('id', account.id);
    await createAlert(
      account.id, campaign.id,
      'captcha', 'critical',
      `Captcha detectado en cuenta "${account.label}" — campaña "${campaign.name}" pausada automáticamente.`,
      { account_label: account.label, campaign_name: campaign.name, exit_code: code },
      true // pauseCampaign
    );
  } else if (code !== 0) {
    // Detectar patrones de rate limit / cookie expirada en el output
    const allOutput = lines.join('\n');
    if (/rate.?limit|checkpoint|authwall|cookie.?expired/i.test(allOutput)) {
      console.warn(`[SCHEDULER] ⚠️  Posible rate limit en cuenta "${account.label}" — marcando como rate_limited.`);
      await supabase.from('linkedin_accounts').update({ status: 'rate_limited' }).eq('id', account.id);
      await createAlert(
        account.id, campaign.id,
        'rate_limited', 'critical',
        `Rate limit / authwall detectado en cuenta "${account.label}" — campaña "${campaign.name}" pausada.`,
        { account_label: account.label, campaign_name: campaign.name, exit_code: code },
        true // pauseCampaign
      );
    } else if (code !== 0) {
      // Error genérico — warning sin pausar
      await createAlert(
        account.id, campaign.id,
        'error_spike', 'warning',
        `Batch falló con exit code ${code} en cuenta "${account.label}" (campaña "${campaign.name}").`,
        { account_label: account.label, campaign_name: campaign.name, exit_code: code, output_tail: lines.slice(-5).join('\n') }
      );
    }
  }
}

// ── Follow-up job ─────────────────────────────────────────────────────────────

async function runFollowupJob(campaign, account, step = 1) {
  const jobType = step === 3 ? 'followup_3' : step === 2 ? 'followup_2' : 'followup';
  console.log(`[SCHEDULER] 💬 Iniciando follow-up step ${step}/3 para "${campaign.name}"...`);

  // Actualizar timestamp del step correspondiente
  const tsField = step === 3 ? 'last_followup3_at' : step === 2 ? 'last_followup2_at' : 'last_followup_at';
  await supabase.from('campaigns').update({ [tsField]: new Date().toISOString() }).eq('id', campaign.id);

  await logJob({ campaignId: campaign.id, accountId: account.id, jobType, status: 'started' });

  if (!account.proxy_url) {
    console.warn(`[SCHEDULER] ⚠️  Sin proxy para follow-up step ${step} "${campaign.name}" — ban risk alto.`);
  }

  const t0 = Date.now();

  if (DRY_RUN) {
    console.log(`[SCHEDULER] [DRY_RUN] Simularía: node followup.js CAMPAIGN_ID=${campaign.id} FOLLOW_UP_STEP=${step}`);
    await logJob({ campaignId: campaign.id, accountId: account.id, jobType, status: 'skipped', skipReason: 'dry_run' });
    return;
  }

  const { code, lines } = await runScript('followup.js', {
    CAMPAIGN_ID:    campaign.id,
    FOLLOW_UP_STEP: String(step),
    DRY_RUN:        'false',
    LIVE_SEND:      String(LIVE_SEND),
    LI_AT:          account.li_at_cookie,
    ...(account.proxy_url ? { PROXY_URL: account.proxy_url } : {}),
  });

  const allOutput  = lines.join('\n');
  const sentMatch  = allOutput.match(/Sent:\s*(\d+)/i);
  const sent       = sentMatch ? parseInt(sentMatch[1]) : 0;
  const durationMs = Date.now() - t0;

  await logJob({
    campaignId: campaign.id, accountId: account.id, jobType,
    status:     code === 0 ? 'completed' : (code === 2 ? 'captcha' : 'error'),
    leadsSent:  sent, durationMs,
    details:    { exit_code: code, step },
  });

  if (code === 2) {
    console.error(`[SCHEDULER] ⛔ Captcha detectado en follow-up step ${step} — cuenta: "${account.label}".`);
    await supabase.from('linkedin_accounts').update({ status: 'rate_limited' }).eq('id', account.id);
    await createAlert(
      account.id, campaign.id,
      'captcha', 'critical',
      `Captcha detectado en cuenta "${account.label}" durante follow-up step ${step} — campaña "${campaign.name}".`,
      { account_label: account.label, campaign_name: campaign.name, step }
    );
  } else {
    console.log(`[SCHEDULER] ✅ Follow-up step ${step} done: ${sent} mensajes enviados (${(durationMs/1000).toFixed(1)}s)`);
  }
}

// ── Loop principal ────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n[SCHEDULER] 🚀 Prometheus Scheduler iniciado`);
  console.log(`[SCHEDULER] DRY_RUN=${DRY_RUN} | LIVE_SEND=${LIVE_SEND}`);
  console.log(`[SCHEDULER] Tick base: ~30 min con jitter ±10 min`);
  console.log(`[SCHEDULER] Horario: Lun-Vie 9am-7pm Mexico City\n`);

  // Primer tick con delay inicial aleatorio (1-5 min) para no arrancar exacto
  const initialDelay = randInt(60_000, 5 * 60_000);
  console.log(`[SCHEDULER] Esperando ${Math.round(initialDelay/60000)} min antes del primer tick...`);
  await sleep(initialDelay);

  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error('[SCHEDULER] Error en tick:', err.message);
      await logJob({ jobType: 'tick', status: 'error', details: { error: err.message } });
    }

    // Intervalo aleatorio: 20-40 min (patrón no predecible)
    const nextMs  = randInt(20 * 60_000, 40 * 60_000);
    const nextMin = Math.round(nextMs / 60_000);
    const { mxDate } = mxTime();
    console.log(`[SCHEDULER] Próximo tick en ~${nextMin} min (${mxDate})`);
    await sleep(nextMs);
  }
}

run().catch(err => {
  console.error('[SCHEDULER] Fatal:', err);
  process.exit(1);
});
