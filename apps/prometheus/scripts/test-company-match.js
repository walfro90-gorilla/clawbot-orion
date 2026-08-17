// Self-check del filtro de empresa del ingest (17-ago-2026, caso Aduanas Infinity).
// Lo que protege: si el filtro afloja, al cliente le vuelven a llegar invitaciones a
// empresas que no son las suyas; si aprieta de más, se queda sin leads legítimos.
// Los casos son DATOS REALES de la campaña 781d93ae.
import assert from 'node:assert/strict'
import { headlineNamesCompany, companyTokens } from '../lib/company-match.js'

// ── Tokens: los genéricos no cuentan ────────────────────────────────────────
assert.deepEqual(companyTokens('General Motors de México'), ['general', 'motors'])
assert.deepEqual(companyTokens('BYD MÉXICO'), ['byd'])
assert.deepEqual(companyTokens('Grupo Industrial Saltillo'), ['industrial', 'saltillo'])
// Nombre 100% genérico → sin tokens que juzgar.
assert.deepEqual(companyTokens('Grupo Comercial de México'), [])

// ── SE CONSERVAN: el headline nombra la empresa objetivo ────────────────────
for (const [headline, target] of [
  ['Contralor en General Motors',                    'general motors'],
  ['Contralor en General Motors',                    'General Motors de México'],  // 'mexico' es genérico
  ['Supply Chain Manager at BYD Mexico',             'BYD MÉXICO'],
  ['Gerente de Planta - Grupo Industrial Saltillo',  'Grupo Industrial Saltillo'],
  ['GERENTE DE ADUANAS EN METALSA',                  'metalsa'],                   // mayúsculas
  ['Director de Logística en Michelín',              'Michelin'],                  // acentos
]) {
  assert.equal(headlineNamesCompany(headline, target), true, `debía conservar: "${headline}" vs "${target}"`)
}

// ── SE DESCARTAN: casos REALES que se colaron al cliente ────────────────────
for (const [headline, target] of [
  ['gerente operativo en Degas Café',                          'general motors'],
  ['Director de Compras en Dana de México',                    'general motors'],
  ['Director en BWI Group - Chihuahua',                        'general motors'],
  ['Director Of Procurement en Sensata Technologies',          'general motors'],
  ['Operations Director at Industrial Hefesto SA de CV',       'General Motors de México'],
  ['Actual: FFM MX Senior Manager en Samsung Electronics',     'General Motors de México'],
  ['Contralor Pyme',                                           'general motors'],
  ['Supply Chain Management',                                  'general motors'],
]) {
  assert.equal(headlineNamesCompany(headline, target), false, `debía descartar: "${headline}" vs "${target}"`)
}

// ── El caso que obliga a exigir TODOS los tokens, no solo uno ───────────────
// Con `some`, "ISUZU Motors de México" pasaría como "General Motors de México" por
// compartir 'motors'. Es un falso positivo real de la campaña.
assert.equal(
  headlineNamesCompany('Gerente de Desarrollo de Flotillas en ISUZU Motors de México', 'General Motors de México'),
  false,
  'compartir un solo token NO puede bastar',
)

// ── Bordes ──────────────────────────────────────────────────────────────────
// Sin headline no hay evidencia en modo degradado → se descarta (mejor menos y correctos).
assert.equal(headlineNamesCompany(null, 'general motors'), false)
assert.equal(headlineNamesCompany('', 'general motors'), false)
// Nombre de empresa sin tokens juzgables → no se puede decidir, se conserva.
assert.equal(headlineNamesCompany('Gerente de Compras', 'Grupo Comercial de México'), true)

console.log('✅ company-match OK (conserva los de la empresa, descarta los ajenos, exige todos los tokens)')
