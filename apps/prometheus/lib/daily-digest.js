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

// Guard en memoria per-campaña (mismo motivo que _lastSentDateMem): si el upsert del
// estado per-campaña falla, no re-enviar al cliente el mismo digest cada tick hasta el
// restart. { [campaignId]: 'YYYY-MM-DD' }
const _sentCampaignsMem = {}

export async function fetchDigestRows(sinceIso, campaignId = null) {
  let q = supabase
    .from('leads')
    .select(`
      id, full_name, linkedin_url, profile_data, contact_info, connected_at,
      campaigns!inner ( name, linkedin_accounts!inner ( label ) )
    `)
    .gt('connected_at', sinceIso)
  if (campaignId) q = q.eq('campaign_id', campaignId)
  const { data, error } = await q.order('connected_at', { ascending: true })
  if (error) throw new Error(`fetchDigestRows: ${error.message}`)
  return data ?? []
}

async function readConfigRow(key) {
  const { data } = await supabase.from('runtime_config').select('value').eq('key', key).maybeSingle()
  return (data?.value && typeof data.value === 'object') ? data.value : null
}

// KPIs del encabezado del reporte: ACUMULADOS de la campaña ("desde su activación"),
// no del período del envío. El cuerpo sí lista solo lo nuevo desde el high-water.
// head:true → count sin traer filas (la instancia es pequeña, ver postmortem 19-ago).
async function campaignTotals(campaignId) {
  const base = () => supabase.from('leads').select('id', { count: 'exact', head: true }).eq('campaign_id', campaignId)
  const [{ count: conexiones }, { count: respuestas }] = await Promise.all([
    base().not('connected_at', 'is', null),
    base().not('replied_at', 'is', null),
  ])
  return { conexiones: conexiones ?? 0, respuestas: respuestas ?? 0 }
}

// Presentación por campaña, opcional, en runtime_config.daily_digest:
//   { ..., campaign_report: { "<campaignId>": { intro, speed, notice: {title, body} } } }
// Sin entrada → el reporte sale con su intro por defecto, 2 KPIs y sin caja de aviso.
// Vive aquí y NO en una columna de campaigns porque es copy editorial que cambia por
// temporada; el aviso de "operando limitado" es de UNA campaña, mandarlo a todas sería
// mentirle al resto de clientes.
function reportOpts(cfg, campaignId, totals) {
  const r = cfg?.campaign_report?.[campaignId] ?? {}
  return {
    intro: r.intro,
    notice: r.notice,
    kpis: [
      { value: String(totals.conexiones), label: 'Conexiones totales generadas' },
      { value: String(totals.respuestas), label: 'Leads con respuesta / oportunidad' },
      ...(r.speed ? [{ value: String(r.speed), label: 'Velocidad actual del sistema' }] : []),
    ],
  }
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
    subject: `🤝 Orion Lead Connections — ${total} ${total === 1 ? 'conexión nueva' : 'conexiones nuevas'} · ${today}`,
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

// ── Digest POR-CAMPAÑA ────────────────────────────────────────────────────────
// Independiente del switch global: se activa por tener campaigns.digest_recipients
// no vacío (NO exige daily_digest.enabled). Reusa send_hour/tz del global.
// Estado en un row SEPARADO (daily_digest_state_campaigns) para no pisar el global:
//   { [campaignId]: { last_sent_date: 'YYYY-MM-DD', high_water: ISO|null } }
// Un array vacío desde send_hour = 1 intento/día (marca last_sent_date, no envía);
// así los accepts que lleguen hoy después de la hora entran en el digest de mañana.
export async function maybeSendCampaignDigests() {
  const cfg = await readConfigRow('daily_digest')
  const tz = cfg?.tz || DEFAULT_TZ
  const sendHour = Number.isFinite(+cfg?.send_hour) ? +cfg.send_hour : DEFAULT_SEND_HOUR
  if (mxTime(tz).mxHour < sendHour) return { processed: 0, sent: 0, skipped: 0 }
  const today = mxDateStr(tz)

  const { data: campaigns, error } = await supabase
    .from('campaigns')
    .select('id, name, digest_recipients')
    .not('digest_recipients', 'is', null)
  if (error) throw new Error(`maybeSendCampaignDigests: ${error.message}`)

  const targets = (campaigns ?? [])
    .filter(c => Array.isArray(c.digest_recipients) && c.digest_recipients.filter(Boolean).length > 0)
  if (targets.length === 0) return { processed: 0, sent: 0, skipped: 0 }

  const state = (await readConfigRow('daily_digest_state_campaigns')) ?? {}
  let sent = 0, skipped = 0, dirty = false

  for (const camp of targets) {
    try {
      const cs = state[camp.id]
      if (cs?.last_sent_date === today || _sentCampaignsMem[camp.id] === today) { skipped++; continue }  // ya enviado hoy

      const since = cs?.high_water ?? startOfYesterdayIso(tz)
      const rows = await fetchDigestRows(since, camp.id)
      const total = rows.length

      if (total === 0) {
        // No spamear con emails vacíos; marca el intento (máx 1/día), high_water sin cambiar.
        state[camp.id] = { last_sent_date: today, high_water: cs?.high_water ?? null }
        _sentCampaignsMem[camp.id] = today
        dirty = true
        skipped++
        continue
      }

      const recipients = camp.digest_recipients.filter(Boolean)
      const dateLabel = new Intl.DateTimeFormat('es-MX', {
        timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      }).format(new Date())
      const res = await sendEmail({
        to: recipients,
        subject: `📇 Orion Lead Connections · ${camp.name} — ${total} ${total === 1 ? 'contacto nuevo' : 'contactos nuevos'} · ${today}`,
        html: buildDigestHtml(groupRows(rows), {
          dateLabel, total, ...reportOpts(cfg, camp.id, await campaignTotals(camp.id)),
        }),
      })
      if (!res.ok) {
        // Estado NO avanza → retry el próximo tick. Alerta deduped, no tumba las demás.
        notifyOps('campaign_digest_send_failed', `digest de campaña "${camp.name}" falló: ${res.error}`, { extra: { campaignId: camp.id, total } }).catch(() => {})
        skipped++
        continue
      }
      state[camp.id] = { last_sent_date: today, high_water: rows[rows.length - 1].connected_at }
      _sentCampaignsMem[camp.id] = today
      dirty = true
      sent++
    } catch (err) {
      notifyOps('campaign_digest_send_failed', `digest de campaña "${camp.name}" excepción: ${err?.message ?? err}`, { extra: { campaignId: camp.id } }).catch(() => {})
      skipped++
    }
  }

  if (dirty) {
    // ⚠️ updated_by NOT NULL sin default — mandar SIEMPRE y checar error (igual que el global).
    const { error: upErr } = await supabase.from('runtime_config')
      .upsert({ key: 'daily_digest_state_campaigns', value: state, updated_by: 'scheduler:campaign_digest' }, { onConflict: 'key' })
    if (upErr) {
      console.error(`[digest] estado per-campaña NO persistido (${upErr.message}) — reintenta el próximo tick`)
      notifyOps('campaign_digest_state_failed', `digest per-campaña enviado pero estado no persistido: ${upErr.message}`).catch(() => {})
    }
  }

  return { processed: targets.length, sent, skipped }
}
