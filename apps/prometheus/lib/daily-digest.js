// ── Digest diario de conexiones aceptadas ────────────────────────────────────
// Cada mañana (send_hour, tz) envía UN email a los destinatarios configurados con
// los leads que aceptaron la invitación desde el último envío, agrupados por
// cuenta → campaña, con nombre / empresa / cargo / email / teléfono / URL.
//
// Config  (runtime_config.daily_digest, la edita Orion /dashboard/settings):
//   { enabled, recipients: string[], send_hour: 0-23, tz }
// Estado  (runtime_config.daily_digest_state, SOLO lo escribe este módulo):
//   { last_sent_date: 'YYYY-MM-DD', high_water: ISO }
//
// Diseño:
// - Corre dentro del tick del scheduler (5 min) ANTES del early-return de
//   extensiones conectadas → catch-up automático si el server estaba caído.
// - Ventana por high-water mark de connected_at (= momento de DETECCIÓN del
//   accept, monotónico) → sin duplicados ni huecos. Reverts de falso-accept
//   ponen connected_at=null → se autoexcluyen.
// - El estado avanza SOLO tras envío 2xx; si Resend falla, reintenta el
//   próximo tick con notifyOps deduped.
// - Se envía aunque haya 0 conexiones: un email vacío distingue "no hubo
//   accepts" de "el sistema murió en silencio".
// Las funciones puras (HTML/agrupación/fechas) viven en digest-format.js para
// que el self-check corra sin .env.

import { supabase } from './supabase.js'
import { mxTime, mxDateStr } from './extension-dispatch.js'
import { sendEmail } from './send-email.js'
import { notifyOps } from './notify-ops.js'
import { groupRows, buildDigestHtml, startOfYesterdayIso } from './digest-format.js'

const DEFAULT_SEND_HOUR = 7
const DEFAULT_TZ = 'America/Mexico_City'

// Guard en memoria contra doble envío si el upsert del estado falla (el email ya
// salió; sin esto, cada tick reenviaría hasta el restart).
let _lastSentDateMem = null

export async function fetchDigestRows(sinceIso) {
  const { data, error } = await supabase
    .from('leads')
    .select(`
      id, full_name, linkedin_url, profile_data, contact_info, connected_at,
      campaigns!inner ( name, linkedin_accounts!inner ( label ) )
    `)
    .gt('connected_at', sinceIso)
    .order('connected_at', { ascending: true })
  if (error) throw new Error(`fetchDigestRows: ${error.message}`)
  return data ?? []
}

async function readConfigRow(key) {
  const { data } = await supabase.from('runtime_config').select('value').eq('key', key).maybeSingle()
  return (data?.value && typeof data.value === 'object') ? data.value : null
}

/**
 * Llamado cada tick. Envía el digest 1×/día a partir de send_hour (tz).
 * @returns {Promise<{sent?: true, total?: number, recipients?: number, skipped?: true, reason?: string}>}
 */
export async function maybeSendDailyDigest() {
  const cfg = await readConfigRow('daily_digest')
  const recipients = Array.isArray(cfg?.recipients) ? cfg.recipients.filter(Boolean) : []
  if (!cfg?.enabled || recipients.length === 0) return { skipped: true, reason: 'disabled' }

  const tz = cfg.tz || DEFAULT_TZ
  const today = mxDateStr(tz)
  if (_lastSentDateMem === today) return { skipped: true, reason: 'already_sent_mem' }

  const state = (await readConfigRow('daily_digest_state')) ?? {}
  if (state.last_sent_date === today) return { skipped: true, reason: 'already_sent' }
  const sendHour = Number.isFinite(+cfg.send_hour) ? +cfg.send_hour : DEFAULT_SEND_HOUR
  if (mxTime(tz).mxHour < sendHour) return { skipped: true, reason: 'too_early' }

  const since = state.high_water ?? startOfYesterdayIso(tz)
  const rows = await fetchDigestRows(since)
  const total = rows.length
  const dateLabel = new Intl.DateTimeFormat('es-MX', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date())

  const res = await sendEmail({
    to: recipients,
    subject: `🤝 ClawBot — ${total} conexión${total === 1 ? '' : 'es'} nueva${total === 1 ? '' : 's'} · ${today}`,
    html: buildDigestHtml(groupRows(rows), { dateLabel, total }),
  })
  if (!res.ok) {
    // Estado NO avanza → retry el próximo tick. Alerta deduped (15 min default).
    notifyOps('digest_send_failed', `digest diario falló: ${res.error}`, { extra: { total, recipients: recipients.length } }).catch(() => {})
    return { skipped: true, reason: `send_failed: ${res.error}` }
  }

  _lastSentDateMem = today
  const highWater = total ? rows[rows.length - 1].connected_at : (state.high_water ?? since)
  // ⚠️ updated_by NOT NULL sin default (lección v0.7.50) — mandar SIEMPRE y checar error.
  const { error: upErr } = await supabase.from('runtime_config')
    .upsert({ key: 'daily_digest_state', value: { last_sent_date: today, high_water: highWater }, updated_by: 'scheduler:daily_digest' }, { onConflict: 'key' })
  if (upErr) {
    console.error(`[digest] estado NO persistido (${upErr.message}) — guard en memoria evita reenvío hasta restart`)
    notifyOps('digest_state_failed', `digest enviado pero estado no persistido: ${upErr.message}`).catch(() => {})
  }
  return { sent: true, total, recipients: recipients.length }
}
