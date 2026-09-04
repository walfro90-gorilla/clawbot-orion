// Self-check del filtro de empresa del ingest (17-ago-2026, caso Aduanas Infinity).
// Lo que protege: si el filtro afloja, al cliente le vuelven a llegar invitaciones a
// empresas que no son las suyas; si aprieta de más, se queda sin leads legítimos.
// Los casos son DATOS REALES de la campaña 781d93ae.
import assert from 'node:assert/strict'
import { headlineNamesCompany, companyTokens, isCardChrome } from '../lib/company-match.js'

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

// ── Chrome de la tarjeta (04-sep-2026, cuenta Josh / SalesNav) ──────────────
// Lo que protege: los scrapers ADIVINAN el headline entre el texto de toda la tarjeta.
// Si el guard afloja, un puesto PASADO ("Experiencia: … ABB Director de marketing")
// vuelve a puntuar seniority alta y a llevarse un turno de invitación — pasó con 19 leads
// que recibieron contacto real, uno de ellos con conversación abierta.
// Los casos son DATOS REALES: 70 headlines + 53 locations contaminados en prod.
for (const t of [
  '6 contactos en común',
  '1 contacto en común',
  '16 contactos en común Grupos en común',
  'Fernando Ruiz-Galindo, Héctor Muñoz Sepulveda y 3 contactos más en común',
  'Marisol Monroy es contacto en común',   // path free, guardado en el campo location
  'Experiencia: 2017 - 2022 ( 5 años ) ABB Director de marketing',
  'Experiencia: 2009 - 2015 ( 6 años 8 meses ) Siemens CEO Executive Assistant',
  'Acerca de: … Mostrar más Experiencia: 2013 - 2014 ( 10 meses ) Vista FBS Business Development Director',
  'La última conexión de James Abad fue Hace 2 horas',
  'Guarda este posible cliente en tu lista y recibe alertas cuando cambie de empleo',
  '1 mil seguidores', '11 mil seguidores', '967 seguidores',
]) assert.equal(isCardChrome(t), true, `debía detectarse como chrome: "${t}"`)

// NO son chrome. El PRIMERO es el que obliga a ANCLAR "Experiencia:" al inicio: es un
// headline humano real (cuenta Rosy) que un patrón sin anclar destruía. El último exige
// que "seguidores" vaya anclado y solo: un titular que los menciona es legítimo.
for (const t of [
  'FVL Gerente Sr. | Experiencia: Mazda + Glovis + Isuzu + BMW Group',
  'Customer Experience Director',
  'Especialista en Experiencia del Cliente',
  'Global Pricing & Procurement Specialist - Mexico/ China x LATAM Nowports',
  'National Sales Manger Rexon México',
  'Monterrey, Nuevo León, México',
  'Growth Marketing | 30 mil seguidores en LinkedIn',
  null, '',
]) assert.equal(isCardChrome(t), false, `NO debía detectarse como chrome: "${t}"`)

console.log('✅ company-match OK (conserva los de la empresa, descarta los ajenos, exige todos los tokens; chrome de tarjeta anulado sin tumbar headlines reales)')
