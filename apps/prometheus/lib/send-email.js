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
//   DIGEST_BCC      — (20-ago-2026) copia oculta de TODO email que salga por aquí, para que
//                     el operador sepa qué se envía y qué deja de enviarse. Va en BCC y no
//                     en To a propósito: en To, el cliente vería el correo personal del
//                     operador en la cabecera. Coma-separado. Se omite si el destinatario ya
//                     está en To (Resend rechaza duplicados entre To y Bcc).

const SEND_TIMEOUT_MS = 10_000

/**
 * Destinatarios de BCC, quitando los que ya van en To (Resend rechaza el duplicado
 * con 422 y perdería el email entero, no solo la copia). Pura → self-check.
 */
export function resolveBcc(bcc, to) {
  const inTo = new Set((Array.isArray(to) ? to : [to])
    .filter(Boolean).map(a => String(a).trim().toLowerCase()))
  return String(bcc ?? '').split(',').map(s => s.trim()).filter(Boolean)
    .filter(a => !inTo.has(a.toLowerCase()))
}

/**
 * Envía un email por Resend. Nunca lanza.
 * @param {{to: string[]|string, subject: string, html: string, from?: string, replyTo?: string}} params
 * @returns {Promise<{ok: true, id: string} | {ok: false, error: string}>}
 */
export async function sendEmail({ to, subject, html, from = process.env.DIGEST_FROM, replyTo = process.env.DIGEST_REPLY_TO, bcc = process.env.DIGEST_BCC }) {
  const apiKey = process.env.RESEND_API_KEY || ''
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY no configurada' }
  if (!from) return { ok: false, error: 'DIGEST_FROM no configurado' }
  if (!to || (Array.isArray(to) && to.length === 0)) return { ok: false, error: 'sin destinatarios' }

  const toList = (Array.isArray(to) ? to : [to]).filter(Boolean)
  const bccList = resolveBcc(bcc, toList)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS)
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body:    JSON.stringify({
        from, to: toList, subject, html,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(bccList.length ? { bcc: bccList } : {}),
      }),
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
