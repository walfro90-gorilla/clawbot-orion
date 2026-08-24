// Self-check de la detección del límite mensual de búsquedas (ext 0.10.38, 23-ago-2026).
// (copia fiel de `detectSearchLimit` de content.js: son funciones de la extensión, que no
//  se puede importar desde Node. Si cambias una, cambia la otra.)
//
// Contexto: LinkedIn free corta las búsquedas de perfiles al llegar a un tope MENSUAL —
// difumina los resultados y ofrece Premium. El scraper veía 0 links /in/ y devolvía
// `no_results_found`: "busqué bien y no hay nadie", indistinguible de una empresa sin
// gente en ese puesto. La cuenta de Rosy pasó días así sin que nadie lo notara.
//
// Lo que protege, en los dos sentidos:
//  - FALSO NEGATIVO (no detectar): seguimos como hoy — quemando búsquedas contra una
//    pared y contando el resultado como sano. Es el bug que esto arregla.
//  - FALSO POSITIVO (detectar de más): pausa las búsquedas de una cuenta 24h sin motivo.
//    Por eso se exige señal DOBLE: frase de límite Y cero perfiles en la página.
//    LinkedIn ofrece Premium por toda la interfaz; el upsell solo no basta.
import assert from 'node:assert/strict'

const SEARCH_LIMIT_RE = [
  /l[íi]mite\s+(mensual|comercial)[^.]{0,60}(b[úu]squeda|perfil)/i,
  /l[íi]mite\s+de\s+uso\s+comercial/i,
  /commercial\s+use\s+limit/i,
  /(monthly|search)\s+limit[^.]{0,60}(search|profile)/i,
  /reached\s+the\s+monthly\s+limit/i,
]
function detectSearchLimit(bodyText, profileLinkCount) {
  if ((profileLinkCount ?? 0) > 0) return false
  const t = String(bodyText ?? '')
  return SEARCH_LIMIT_RE.some(re => re.test(t))
}

// ── El caso real: captura de la cuenta de Rosy, 22-ago-2026 ─────────────────
const ROSY_REAL = `rossy, podrías beneficiarte de búsquedas ilimitadas
has llegado al límite mensual de búsquedas de perfiles. pásate a premium business
para buscar y explorar sin límites.
probar premium por 0 mxn
prueba gratuita de 1 mes con asistencia las 24 horas. fácil de cancelar.`
assert.equal(detectSearchLimit(ROSY_REAL, 0), true, 'el texto real de la captura debe detectarse')

// ── Variantes de idioma / redacción ─────────────────────────────────────────
assert.equal(detectSearchLimit("you've reached the monthly limit for profile searches", 0), true)
assert.equal(detectSearchLimit('you have hit the commercial use limit for this month', 0), true)
assert.equal(detectSearchLimit('has alcanzado el límite comercial de búsquedas', 0), true)
assert.equal(detectSearchLimit('límite de uso comercial', 0), true)

// ── El guard que evita el falso positivo ────────────────────────────────────
// MISMO texto de límite, pero con perfiles en pantalla ⇒ es un banner, no un bloqueo.
// Sin este guard, un upsell sobre resultados válidos pausaría la cuenta 24h por nada.
assert.equal(detectSearchLimit(ROSY_REAL, 7), false, 'con perfiles visibles NO es bloqueo')
assert.equal(detectSearchLimit(ROSY_REAL, 1), false)

// ── Upsells de Premium que NO son el límite (los más peligrosos) ────────────
// LinkedIn los muestra por toda la interfaz, incluso en una búsqueda vacía legítima.
assert.equal(detectSearchLimit('prueba premium gratis por 1 mes', 0), false)
assert.equal(detectSearchLimit('descubre quién vio tu perfil con premium', 0), false)
assert.equal(detectSearchLimit('retry with premium business', 0), false)
assert.equal(detectSearchLimit('búsquedas ilimitadas con premium', 0), false,
  'el gancho del upsell por sí solo no es prueba de bloqueo')

// ── Empty-state legítimo: la empresa no tiene a nadie con ese puesto ────────
assert.equal(detectSearchLimit('no se encontraron resultados. prueba con otras palabras clave.', 0), false)
assert.equal(detectSearchLimit('no results found', 0), false)

// ── Entradas degeneradas ────────────────────────────────────────────────────
assert.equal(detectSearchLimit('', 0), false)
assert.equal(detectSearchLimit(null, 0), false)
assert.equal(detectSearchLimit(undefined, undefined), false)

console.log('✅ search-limit OK (caza el límite real; el upsell suelto y el vacío legítimo NO)')
