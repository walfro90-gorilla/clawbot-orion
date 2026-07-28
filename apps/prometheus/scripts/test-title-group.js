// Self-check de buildTitleGroup (scheduler-extension.js) — el query booleano que
// agrupa varios puestos objetivo en UNA visita a la empresa.
// Correr: node apps/prometheus/scripts/test-title-group.js
// (copia fiel de la función; si cambias una, cambia la otra — el scheduler no exporta
//  nada para no arrastrar dotenv/supabase a un test de string).
import assert from 'node:assert/strict'

const TITLE_GROUP_MAX_CHARS = 200

function buildTitleGroup(kws, startIdx) {
  const parts = []
  let used = 0
  for (let i = 0; i < kws.length; i++) {
    const kw = kws[(startIdx + i) % kws.length]
    const term = /\s/.test(kw) ? `"${kw}"` : kw
    const next = parts.concat(term).join(' OR ')
    if (parts.length && next.length > TITLE_GROUP_MAX_CHARS) break
    parts.push(term)
    used++
  }
  return { query: parts.join(' OR '), used: Math.max(1, used) }
}

// Multi-palabra va entre comillas; una sola palabra no.
assert.equal(buildTitleGroup(['Procurement', 'Director de Compras'], 0).query,
  'Procurement OR "Director de Compras"')

// Arranca en startIdx y da la vuelta (no se queda en el primer keyword).
assert.equal(buildTitleGroup(['a', 'b', 'c'], 2).query, 'c OR a OR b')

// Nunca pasa el cap de LinkedIn, y siempre mete al menos un término.
const largos = Array.from({ length: 20 }, (_, i) => `Director de Operaciones Region ${i}`)
const g = buildTitleGroup(largos, 0)
assert.ok(g.query.length <= TITLE_GROUP_MAX_CHARS, `query ${g.query.length} > cap`)
assert.ok(g.used >= 1 && g.used < largos.length, 'debe truncar, no tragarse los 20')

// used avanza el cursor de keywords sin salirse del array.
const kws = ['a', 'b', 'c', 'd']
const g2 = buildTitleGroup(kws, 1)
assert.equal(g2.used, 4)
assert.equal((1 + g2.used) % kws.length, 1)  // vuelta completa → mismo punto de arranque

// Un solo keyword: no rompe, used=1.
assert.deepEqual(buildTitleGroup(['CEO'], 0), { query: 'CEO', used: 1 })

console.log('✅ buildTitleGroup OK')
