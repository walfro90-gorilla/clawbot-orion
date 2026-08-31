// One-shot: directorio consolidado de contactos para la campaña de Café 57.
// Remediación del bug digest-a-medianoche (31-ago-2026): 39 de 51 leads digesteados
// recibieron su email/teléfono DESPUÉS de que su digest saliera — el cliente nunca
// vio esos datos. Este email reenvía TODOS los contactos con datos, del más
// reciente al más antiguo. NO toca daily_digest_state_campaigns (email fuera de
// serie; el digest diario sigue su curso normal).
//
//   node scripts/diagnostics/remediation-digest-cafe57.js                    → dry-run: conteo + HTML a stdout
//   node scripts/diagnostics/remediation-digest-cafe57.js --send-to=a@b.com  → prueba a UN buzón
//   node scripts/diagnostics/remediation-digest-cafe57.js --send             → a digest_recipients de la campaña
//
// Requiere .env (correr en prod). ponytail: campaña fija — es una remediación
// puntual, no una herramienta; generalizar cuando otra campaña lo necesite.
import { supabase } from '../../lib/supabase.js'
import { sendEmail } from '../../lib/send-email.js'
import { groupRows, buildDigestHtml } from '../../lib/digest-format.js'
import { fetchDigestRows, campaignTotals, reportOpts } from '../../lib/daily-digest.js'

const CAMPAIGN_ID = '5f3b43b7-b72d-4df0-8a03-f75165a26da5' // CAFE 57 — TEST

const all = await fetchDigestRows('1970-01-01T00:00:00Z', CAMPAIGN_ID)
const conDatos = all.filter(r => {
  const ci = r.contact_info
  return ci && typeof ci === 'object' && (ci.email || (Array.isArray(ci.phones) && ci.phones.length))
})
console.log(`${all.length} conexiones en la campaña; ${conDatos.length} con email/teléfono`)

const { data: camp } = await supabase.from('campaigns')
  .select('name, digest_recipients').eq('id', CAMPAIGN_ID).single()
const { data: cfgRow } = await supabase.from('runtime_config')
  .select('value').eq('key', 'daily_digest').maybeSingle()

const tz = cfgRow?.value?.tz ?? 'America/Mexico_City'
const dateLabel = new Intl.DateTimeFormat('es-MX', {
  timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
}).format(new Date())

const opts = reportOpts(cfgRow?.value, CAMPAIGN_ID, await campaignTotals(CAMPAIGN_ID))
const html = buildDigestHtml(groupRows(conDatos), {
  dateLabel,
  total: conDatos.length,
  ...opts,
  intro: 'Reporte consolidado: directorio completo de contactos identificados a la fecha, '
    + 'con su información de contacto actualizada. Detectamos que algunos reportes diarios '
    + 'salieron antes de que el sistema terminara de recolectar email y teléfono de las '
    + 'conexiones más recientes; este envío corrige y consolida esa información.',
})

const arg = process.argv.find(a => a === '--send' || a.startsWith('--send-to='))
const subject = `📇 Orion Lead Connections · ${camp.name} — directorio actualizado de contactos`

if (!arg) {
  console.log(html)
  console.log(`\n[dry-run] destinatarios reales serían: ${(camp.digest_recipients ?? []).length}`)
} else {
  const to = arg === '--send' ? (camp.digest_recipients ?? []).filter(Boolean) : [arg.split('=')[1]]
  if (!to.length) { console.error('sin destinatarios'); process.exit(1) }
  const res = await sendEmail({ to, subject, html })
  console.log(res.ok ? `✅ enviado a ${to.length} destinatario(s) (id ${res.id})` : `❌ falló: ${res.error}`)
  if (!res.ok) process.exit(1)
}
