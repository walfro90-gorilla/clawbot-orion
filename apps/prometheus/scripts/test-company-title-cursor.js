// Self-check del cursor de puestos por empresa (scheduler-extension.js).
// Correr: node apps/prometheus/scripts/test-company-title-cursor.js
// (copia fiel de la función: scheduler-extension.js es el ENTRYPOINT del proceso —
//  importarlo arrancaría el scheduler. Si cambias una, cambia la otra.)
import assert from 'node:assert/strict'

const COMPANY_TITLES_PER_PASS = 6

function nextTitleForCompany(kws, target) {
  const idx = (target.title_idx ?? 0) % kws.length
  const nextIdx = (idx + 1) % kws.length
  const passDone = nextIdx === 0 || nextIdx % COMPANY_TITLES_PER_PASS === 0
  return { keyword: kws[idx], idx, nextIdx, passDone }
}

const K20 = Array.from({ length: 20 }, (_, i) => `t${i}`)

// Un puesto por visita, avanzando de uno en uno.
assert.deepEqual(nextTitleForCompany(K20, { title_idx: 0 }),
  { keyword: 't0', idx: 0, nextIdx: 1, passDone: false })
assert.deepEqual(nextTitleForCompany(K20, { title_idx: 3 }),
  { keyword: 't3', idx: 3, nextIdx: 4, passDone: false })

// El pase cierra al 6º puesto → ahí se sella last_searched_at y pasa la otra empresa.
assert.equal(nextTitleForCompany(K20, { title_idx: 5 }).passDone, true)
assert.equal(nextTitleForCompany(K20, { title_idx: 11 }).passDone, true)
// …y NO antes: los 5 primeros siguen en la misma empresa.
for (const i of [0, 1, 2, 3, 4]) {
  assert.equal(nextTitleForCompany(K20, { title_idx: i }).passDone, false, `idx ${i}`)
}

// Segunda vuelta: retoma donde se quedó (no reinicia en t0).
assert.equal(nextTitleForCompany(K20, { title_idx: 6 }).keyword, 't6')

// Dar la vuelta completa a la lista también cierra el pase.
assert.deepEqual(nextTitleForCompany(K20, { title_idx: 19 }),
  { keyword: 't19', idx: 19, nextIdx: 0, passDone: true })

// Lista más corta que el pase: cierra al dar la vuelta, sin quedarse pegada.
const K3 = ['a', 'b', 'c']
assert.equal(nextTitleForCompany(K3, { title_idx: 2 }).passDone, true)
assert.equal(nextTitleForCompany(K3, { title_idx: 0 }).passDone, false)

// El usuario recortó la lista de keywords y el cursor quedó fuera de rango → módulo.
assert.equal(nextTitleForCompany(K3, { title_idx: 47 }).keyword, 'c')
// Empresa recién resuelta (sin cursor) arranca en el primer puesto.
assert.equal(nextTitleForCompany(K3, {}).keyword, 'a')

console.log('✅ nextTitleForCompany OK')
