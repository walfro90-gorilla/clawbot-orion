// Self-check del formateo de alertas out-of-band (17-ago-2026).
// Lo que protege: si el payload sale con el formato equivocado, la alerta llega ilegible
// (JSON crudo en el móvil) o directamente no llega — y un canal de alertas que se ignora
// es lo mismo que no tener canal.
import assert from 'node:assert'
import { buildOpsRequest } from '../lib/notify-ops.js'

// 1. ntfy → texto plano legible, sin JSON ni markdown, con metadatos en headers.
const ntfy = buildOpsRequest('https://ntfy.sh/clawbot-alertas-orion', 'Scheduler lento: 5 ticks.')
assert.equal(ntfy.body, 'Scheduler lento: 5 ticks.', 'ntfy manda el texto tal cual')
assert.ok(!ntfy.body.includes('{'), 'ntfy no lleva JSON')
assert.ok(!ntfy.body.includes('*'), 'ntfy no lleva markdown de Slack')
assert.match(ntfy.headers['Content-Type'], /text\/plain/)
assert.equal(ntfy.headers.Title, 'ClawBot ops')
// ntfy rechaza headers no-ASCII: el emoji va en Tags, nunca en Title.
for (const [k, v] of Object.entries(ntfy.headers)) {
  assert.ok(/^[\x20-\x7E]*$/.test(v), `header ${k} debe ser ASCII, es "${v}"`)
}

// 2. Slack (y cualquier otro destino) conserva el JSON de siempre.
const slack = buildOpsRequest('https://hooks.slack.com/services/T/B/X', 'DB caida.')
const parsed = JSON.parse(slack.body)
assert.match(parsed.text, /ClawBot ops/, 'Slack mantiene el prefijo')
assert.match(parsed.text, /DB caida\./)
assert.equal(slack.headers['Content-Type'], 'application/json')

// 3. El `detail` se adjunta en ambos formatos.
const withDetail = buildOpsRequest('https://ntfy.sh/x', 'algo', '\ncontexto')
assert.ok(withDetail.body.endsWith('\ncontexto'), 'ntfy adjunta el detail')
assert.ok(JSON.parse(buildOpsRequest('https://slack.test/x', 'algo', '\nctx').body).text.endsWith('\nctx'))

// 4. Una URL invalida NO revienta: cae al formato JSON por defecto.
//    notifyOps es fire-and-forget; que aqui lance mataria la alerta entera.
assert.doesNotThrow(() => buildOpsRequest('no-es-una-url', 'x'))
assert.equal(buildOpsRequest('', 'x').headers['Content-Type'], 'application/json')

// 5. Un host que solo CONTIENE "ntfy.sh" no debe colar como ntfy.
assert.equal(
  buildOpsRequest('https://ntfy.sh.evil.test/x', 'x').headers['Content-Type'],
  'application/json',
  'el match de host debe anclarse al final',
)

console.log('✅ notify-ops OK (ntfy texto plano, Slack JSON, headers ASCII, URL invalida)')
