// ── Envío de email transaccional vía Resend API ─────────────────────────────
// fetch nativo, sin SDK (mismo espíritu que notify-ops.js: timeout corto,
// jamás throw, no-op seguro sin credenciales).
//
// Config (prometheus/.env):
//   RESEND_API_KEY  — API key de Resend. Sin ella, sendEmail es no-op {ok:false}.
//   DIGEST_FROM     — remitente por default, formato 'Nombre <email@dominio-verificado>'.
//                     El dominio DEBE estar verificado en Resend para enviar a terceros.
//   DIGEST_REPLY_TO — (17-ago-2026) buzón REAL al que van las respuestas. El From del digest
//                     es una dirección de envío (digest@…) que puede no existir como buzón;
//                     sin Reply-To, un cliente que contesta "me interesa" se come un rebote.
//                     Opcional: sin la var, el header no se manda y el comportamiento es el
//                     de siempre.

const SEND_TIMEOUT_MS = 10_000

/**
 * Envía un email por Resend. Nunca lanza.
 * @param {{to: string[]|string, subject: string, html: string, from?: string, replyTo?: string}} params
 * @returns {Promise<{ok: true, id: string} | {ok: false, error: string}>}
 */
export async function sendEmail({ to, subject, html, from = process.env.DIGEST_FROM, replyTo = process.env.DIGEST_REPLY_TO }) {
  const apiKey = process.env.RESEND_API_KEY || ''
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY no configurada' }
  if (!from) return { ok: false, error: 'DIGEST_FROM no configurado' }
  if (!to || (Array.isArray(to) && to.length === 0)) return { ok: false, error: 'sin destinatarios' }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS)
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body:    JSON.stringify({ from, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
      signal:  ctrl.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 300)}` }
    }
    const data = await res.json().catch(() => ({}))
    return { ok: true, id: data?.id ?? '' }
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}
