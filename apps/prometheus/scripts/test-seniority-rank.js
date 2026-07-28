// Self-check de seniorityRank (lib/extension-dispatch.js) — el orden por responsabilidad
// con el que tryInvitesForCampaign elige a quién invitar dentro de la empresa.
// Correr: node apps/prometheus/scripts/test-seniority-rank.js
// (env dummy: extension-dispatch importa lib/supabase.js, que exige las vars. No se
//  abre ninguna conexión — solo se evalúan strings.)
process.env.SUPABASE_URL ||= 'http://localhost:54321'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'dummy-key-for-test'

import assert from 'node:assert/strict'
const { seniorityRank } = await import('../lib/extension-dispatch.js')

// Escalera básica.
assert.equal(seniorityRank('CEO & Founder en Acme'), 5)
assert.equal(seniorityRank('Director General'), 4)
assert.equal(seniorityRank('VP de Operaciones'), 4)
assert.equal(seniorityRank('Director de Compras'), 3)
assert.equal(seniorityRank('Head of Supply Chain'), 3)
assert.equal(seniorityRank('Gerente de Logística'), 2)
assert.equal(seniorityRank('Coordinador de Embarques'), 1)

// El ejecutivo top gana al mando medio (el caso Josh: el Coordinador se colaba primero).
assert.ok(seniorityRank('Director General de Cafe 57') > seniorityRank('Coordinador de Compras'))
// Director General (4) manda sobre Director a secas (3).
assert.ok(seniorityRank('Directora General') > seniorityRank('Directora de Marketing'))

// Acentos y ñ: "Dueño" y "Líder" deben rankear (la normalización descompone la ñ).
assert.equal(seniorityRank('Dueño'), 5)
assert.equal(seniorityRank('Líder de Proyecto'), 2)
assert.equal(seniorityRank('Presidenta del Consejo'), 5)

// Headline vacío/desconocido → 0 (cae al desempate FIFO, ni premio ni castigo).
assert.equal(seniorityRank(''), 0)
assert.equal(seniorityRank(null), 0)
assert.equal(seniorityRank('Apasionado del comercio exterior'), 0)

// El sort es estable dentro del mismo rank → conserva el orden FIFO del SELECT.
const pool = [
  { n: 'a', h: 'Gerente de Compras' },
  { n: 'b', h: 'Director General' },
  { n: 'c', h: 'Gerente de Tráfico' },
]
const orden = pool.map(x => ({ ...x, rank: seniorityRank(x.h) }))
  .sort((x, y) => y.rank - x.rank).map(x => x.n)
assert.deepEqual(orden, ['b', 'a', 'c'])

console.log('✅ seniorityRank OK')
process.exit(0)  // lib/supabase.js deja handles vivos → sin esto el test no termina
