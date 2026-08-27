// Self-check del TRIAJE de 3 estados del ingest degradado (26-ago-2026).
// (copia fiel del predicado de extension-bridge.js `ingestSearch`. Si cambias uno,
//  cambia el otro — mismo trato que test-scan-truncated.js.)
//
// El bug que arregla: `headlineNamesCompany` devuelve false por DOS razones distintas y el
// ingest las trataba igual (descartar). Nombrar otra empresa es evidencia en contra; NO
// tener headline no es evidencia de nada. Con el bug abierto del scraper (~33-44% de los
// perfiles de Café 57 salen sin headline) el segundo caso borraba mucha gente sin rastro.
//
// Lo que protege, en los dos sentidos:
//  - Diferir de menos: vuelve el descarte silencioso y nadie puede auditar a quién se perdió.
//  - Diferir de más: los que SÍ nombran otra empresa se colarían al CRM como "por revisar"
//    y ahogarían la bandeja — en Aduanas Infinity eran 46 de 104.
process.env.SUPABASE_URL ||= 'http://localhost:54321'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'dummy-key-for-test'

import assert from 'node:assert/strict'
const { headlineNamesCompany } = await import('../lib/company-match.js')

// Predicado espejo del de ingestSearch.
const triage = (headline, target) => {
  if (headlineNamesCompany(headline, target)) return 'keep'
  if (!(headline ?? '').trim()) return 'defer'
  return 'reject'
}

// ── Los casos reales de Aduanas Infinity (17-ago) ──────────────────────────
assert.equal(triage('Gerente de Compras en ISUZU Motors de México', 'ISUZU Motors'), 'keep')
assert.equal(triage('Supply Chain Manager en General Motors de México', 'ISUZU Motors'), 'reject',
  'nombra OTRA empresa: evidencia en contra, se rechaza')
assert.equal(triage('Gerente en Degas Café', 'ISUZU Motors'), 'reject')

// ── El caso nuevo: sin evidencia se DIFIERE, no se borra ───────────────────
assert.equal(triage('', 'ISUZU Motors'), 'defer', 'headline vacío → revisión, no descarte')
assert.equal(triage(null, 'ISUZU Motors'), 'defer', 'headline null → revisión')
assert.equal(triage(undefined, 'ISUZU Motors'), 'defer')
assert.equal(triage('   ', 'ISUZU Motors'), 'defer', 'solo espacios cuenta como vacío')
assert.equal(triage('\n\t ', 'ISUZU Motors'), 'defer')

// ── El diferido NO puede tragarse a los rechazados ─────────────────────────
// Si el predicado se escribiera al revés (defer antes que el match) todo caería en revisión.
const muestra = [
  ['Director General ISUZU Motors de México', 'keep'],
  ['Director General en Sensata Technologies', 'reject'],
  ['', 'defer'],
  ['Gerente de Planta BWI Group', 'reject'],
  [null, 'defer'],
]
const conteo = muestra.reduce((acc, [h, _]) => { acc[triage(h, 'ISUZU Motors')]++; return acc },
  { keep: 0, reject: 0, defer: 0 })
assert.deepEqual(conteo, { keep: 1, reject: 2, defer: 2 })
for (const [h, esperado] of muestra) assert.equal(triage(h, 'ISUZU Motors'), esperado, `caso: ${JSON.stringify(h)}`)

console.log('✅ ingest-triage OK (sin headline se difiere para revisión; nombrar otra empresa sigue rechazando)')
process.exit(0)  // lib/supabase.js deja handles vivos → sin esto el test no termina
