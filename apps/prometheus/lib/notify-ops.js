// ── Canal de alerta OUT-OF-BAND — NO toca Supabase ──────────────────────────────
// Post-mortem 2026-07-03 (docs/postmortem-2026-07-03-db-outage.md §5, P0 #2):
// El outage cegó TODO el sistema de alerta porque cada canal (account_alerts, monitor,
// heartbeat-check) vivía en la MISMA DB que se cayó. Cuando el modo de falla es "la DB
// se cuelga", ese diseño garantiza que nadie se entere.
//
// Este helper es la única vía que NO depende de la DB:
//   - fetch DIRECTO a un webhook (Slack/Telegram/ntfy/etc.), nunca Supabase
//   - timeout corto (el webhook también podría estar caído) → fire-and-forget
//   - dedup en ARCHIVO local (no en memoria: la memoria se pierde en cada restart, y un
//     crash-loop reenviaría la misma alerta en cada boot)
//
// Config (prometheus/.env):
//   OPS_WEBHOOK_URL   — webhook a notificar (cae a SLACK_WEBHOOK_URL si no está). Sin
//                       ninguno de los dos, notifyOps es un NO-OP silencioso (seguro).
//   OPS_NOTIFY_DEDUP_MS — ventana de dedup por clave (default 15min)
//   OPS_NOTIFY_STATE  — ruta del archivo de estado de dedup (default /tmp/clawbot-ops-notify.json)

import fs from 'fs'

const WEBHOOK        = process.env.OPS_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL || ''
const DEDUP_WINDOW_MS = parseInt(process.env.OPS_NOTIFY_DEDUP_MS ?? '900000')  // 15 min
const STATE_FILE      = process.env.OPS_NOTIFY_STATE || '/tmp/clawbot-ops-notify.json'
const SEND_TIMEOUT_MS = 4000

function _loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}
function _saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)) } catch { /* best-effort */ }
}

/**
 * Notifica un evento de ops por el canal out-of-band, con dedup persistente.
 * @param {string} key   Clave de dedup (p.ej. 'scheduler_crash_loop', 'db_degraded').
 * @param {string} text  Mensaje legible.
 * @param {{force?: boolean, extra?: object}} [opts]  force=ignora dedup; extra=contexto JSON.
 * @returns {Promise<boolean>} true si se envió (o se intentó); false si no-op/deduped.
 */
export async function notifyOps(key, text, { force = false, extra = null } = {}) {
  if (!WEBHOOK) return false  // sin webhook configurado → no-op seguro
  const now = Date.now()
  const state = _loadState()
  if (!force && state[key] && (now - state[key]) < DEDUP_WINDOW_MS) return false
  state[key] = now
  _saveState(state)

  const detail = extra && Object.keys(extra).length
    ? '\n```' + JSON.stringify(extra, null, 2).slice(0, 500) + '```'
    : ''
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS)
  try {
    await fetch(WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text: `🔴 *ClawBot ops* — ${text}${detail}` }),
      signal:  ctrl.signal,
    })
    return true
  } catch {
    return false  // el webhook también puede fallar; jamás propagar (fire-and-forget)
  } finally {
    clearTimeout(timer)
  }
}
