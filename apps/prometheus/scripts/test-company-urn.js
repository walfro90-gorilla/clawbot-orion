// Self-check del segundo salto que recupera el company URN desde /company/<slug>/
// (ext 0.10.31, 21-ago-2026).
// (copia fiel de `pickCompanyUrn` de content.js: son funciones de la extensión, que no se
//  puede importar desde Node. Si cambias una, cambia la otra.)
//
// Contexto: el 12-ago LinkedIn dejó de exponer el URN en /search/results/companies/, así
// que toda empresa NUEVA entraba degradada a búsqueda por texto libre — y ahí el scoping
// de empresa es decorativo (46 de 104 leads de Aduanas Infinity eran de otra empresa).
//
// Lo que protege, en los dos sentidos:
//  - URN EQUIVOCADO: ata la empresa incorrecta ⇒ invita a otra compañía. El riesgo caro,
//    y por eso el fallback exige dominio claro; ante duda, null (queda 'unresolved' →
//    nombre exacto, que es el comportamiento honesto y reversible de hoy).
//  - SIN URN: seguimos degradados, que es exactamente lo de ahora. Malo, no peligroso.
import assert from 'node:assert/strict'

const CURRENT_COMPANY_RE = /currentCompany=(?:%5B|\[)(?:%22|"|&quot;|'|)(\d+)/i
function pickCompanyUrn({ hrefs = [], html = '' }) {
  for (const h of hrefs) {
    const m = String(h ?? '').match(CURRENT_COMPANY_RE)
    if (m) return { urn: m[1], source: 'employees_link' }
  }
  const counts = new Map()
  for (const m of String(html ?? '').matchAll(/urn:li:(?:fsd_company|organization|company):(\d+)/g)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  if (!ranked.length) return { urn: null, source: 'none' }
  const [topId, topN] = ranked[0]
  const secondN = ranked[1]?.[1] ?? 0
  if (topN >= 3 && topN >= secondN * 3) return { urn: topId, source: 'html_dominant' }
  return { urn: null, source: 'ambiguous' }
}

// ── Fuente preferida: el link "ver todos los empleados" ──────────────────────
// Forma real (URL-encoded) del href que pinta LinkedIn.
assert.deepEqual(
  pickCompanyUrn({ hrefs: ['/search/results/people/?currentCompany=%5B%222563257%22%5D&origin=COMPANY_PAGE_CANNED_SEARCH'] }),
  { urn: '2563257', source: 'employees_link' })
// Y sin encodear, por si el DOM lo entrega decodificado.
assert.deepEqual(
  pickCompanyUrn({ hrefs: ['/search/results/people/?currentCompany=["5949"]'] }),
  { urn: '5949', source: 'employees_link' })
// Con &quot; (href leído de HTML crudo).
assert.equal(pickCompanyUrn({ hrefs: ['?currentCompany=[&quot;3534&quot;]'] }).urn, '3534')
// Gana el link aunque el HTML esté lleno de otros ids.
assert.deepEqual(
  pickCompanyUrn({
    hrefs: ['?currentCompany=%5B%2211273203%22%5D'],
    html: 'urn:li:fsd_company:999 '.repeat(50),
  }),
  { urn: '11273203', source: 'employees_link' })
// Un href sin el facet no cuenta.
assert.equal(pickCompanyUrn({ hrefs: ['/company/bosch/about/'] }).urn, null)

// ── Fallback por dominio claro en el HTML ────────────────────────────────────
// La empresa de la página se repite muchas veces; una "página similar" aparece 1-2.
assert.deepEqual(
  pickCompanyUrn({ html: 'urn:li:fsd_company:1234 '.repeat(12) + 'urn:li:fsd_company:777 urn:li:organization:888' }),
  { urn: '1234', source: 'html_dominant' })

// ── EL CASO CRÍTICO: ambigüedad ⇒ NO resolver ───────────────────────────────
// Dos ids con frecuencias parecidas: elegir el más alto ataría la empresa equivocada.
assert.deepEqual(
  pickCompanyUrn({ html: 'urn:li:fsd_company:111 '.repeat(5) + 'urn:li:fsd_company:222 '.repeat(4) }),
  { urn: null, source: 'ambiguous' })
// Dominio relativo pero muestra pequeña (2 vs 0): insuficiente, exige al menos 3.
assert.deepEqual(
  pickCompanyUrn({ html: 'urn:li:fsd_company:111 urn:li:fsd_company:111' }),
  { urn: null, source: 'ambiguous' })
// Justo en el umbral: 3 apariciones y nada más → sí resuelve.
assert.equal(pickCompanyUrn({ html: 'urn:li:fsd_company:111 '.repeat(3) }).urn, '111')
// 3 contra 1 es exactamente 3× → resuelve; 3 contra 2 NO.
assert.equal(pickCompanyUrn({ html: 'urn:li:fsd_company:111 '.repeat(3) + 'urn:li:fsd_company:222' }).urn, '111')
assert.equal(pickCompanyUrn({ html: 'urn:li:fsd_company:111 '.repeat(3) + 'urn:li:fsd_company:222 '.repeat(2) }).urn, null)

// ── Página sin ningún URN (markup cambiado otra vez) ────────────────────────
assert.deepEqual(pickCompanyUrn({ hrefs: [], html: '<main>nada</main>' }), { urn: null, source: 'none' })
assert.deepEqual(pickCompanyUrn({}), { urn: null, source: 'none' })

// Las tres variantes del prefijo que usa LinkedIn cuentan como el mismo id.
assert.equal(
  pickCompanyUrn({ html: 'urn:li:fsd_company:42 urn:li:organization:42 urn:li:company:42' }).urn, '42')

console.log('✅ company-urn OK (link de empleados gana; ambiguo NO resuelve)')
