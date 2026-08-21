// Self-check del aislamiento de la tarjeta de un resultado de personas
// (ext 0.10.33, 21-ago-2026).
// (copia fiel de `_personResultCard` de content.js: es una función de la extensión, que no
//  se puede importar desde Node. Si cambias una, cambia la otra.)
//
// El bug que cierra: se subían 4 niveles A CIEGAS desde el <a> del perfil. Si LinkedIn mete
// un nivel de más o de menos —y varía con el ancho de ventana, el tipo de resultado y sus
// A/B tests— se aterrizaba FUERA del card: querySelectorAll('p') devolvía nada (lead sin
// puesto NI ubicación) o los <p> del resultado de al lado (datos de OTRA persona).
// Medido: 137 de 232 perfiles sin headline tampoco traían location, y con la MISMA build
// Wal fallaba 0%, Café 57 el 33% y Josh-free el 58% — patrón ambiental clásico.
//
// Los dos sentidos:
//  - Quedarse CORTO: el card no contiene los <p> ⇒ lead sin puesto ni ubicación (el bug).
//  - Pasarse LARGO: el card abarca varios resultados ⇒ se copian los datos del vecino, que
//    es peor: el lead sale con el puesto de otra persona y nadie lo nota.
import assert from 'node:assert/strict'

// ── DOM mínimo simulado ─────────────────────────────────────────────────────
class El {
  constructor(tag, href = null) { this.tag = tag; this.href = href; this.children = []; this.parentElement = null }
  add(...kids) { for (const k of kids) { k.parentElement = this; this.children.push(k) } return this }
  getAttribute(n) { return n === 'href' ? this.href : null }
  descendants() { return this.children.flatMap(c => [c, ...c.descendants()]) }
  querySelectorAll(sel) {
    assert.equal(sel, 'a[href*="/in/"]', 'el selector real es este')
    return this.descendants().filter(e => e.tag === 'a' && (e.href ?? '').includes('/in/'))
  }
}
const body = new El('body')

// Copia fiel de la función de content.js.
function _personResultCard(anchor) {
  const slugOf = (el) => (el.getAttribute('href') ?? '').match(/\/in\/([^/?#]+)/)?.[1]
  let card = anchor
  let el = anchor.parentElement
  while (el && el !== body) {
    const slugs = new Set(
      Array.from(el.querySelectorAll('a[href*="/in/"]')).map(slugOf).filter(Boolean)
    )
    if (slugs.size > 1) break
    card = el
    el = el.parentElement
  }
  return card
}

// Un resultado real: foto y nombre apuntan AL MISMO perfil, así que cuentan como uno solo.
const mkResult = (slug) => {
  const li = new El('li')
  const inner = new El('div')
  const foto = new El('a', `/in/${slug}/`)
  const nombre = new El('a', `/in/${slug}?miniProfileUrn=x`)
  const p = new El('p')
  inner.add(foto, nombre, p)
  li.add(inner)
  return { li, nombre, p }
}

// ── Caso normal: 2 resultados hermanos ─────────────────────────────────────
const lista = new El('ul')
const r1 = mkResult('ana-perez')
const r2 = mkResult('luis-vega')
lista.add(r1.li, r2.li)
body.add(lista)

let card = _personResultCard(r1.nombre)
assert.equal(card, r1.li, 'sube hasta el <li> de SU resultado')
assert.ok(card.descendants().includes(r1.p), 'el card contiene su propio <p>')
assert.ok(!card.descendants().includes(r2.p), 'NO abarca el <p> del vecino')

// ── EL CASO DEL BUG: un nivel EXTRA de wrapper ─────────────────────────────
// Con la subida ciega de 4, aquí se aterrizaba fuera del card. La adaptativa no se inmuta.
const body2 = new El('body')
const lista2 = new El('ul')
const r3 = mkResult('mario-hinojosa')
const wrapper = new El('div')   // <- el nivel de más que rompía todo
wrapper.add(r3.li)
lista2.add(wrapper)
body2.add(lista2)
const _card2 = (() => {
  const slugOf = (el) => (el.getAttribute('href') ?? '').match(/\/in\/([^/?#]+)/)?.[1]
  let c = r3.nombre, el = r3.nombre.parentElement
  while (el && el !== body2) {
    const s = new Set(Array.from(el.querySelectorAll('a[href*="/in/"]')).map(slugOf).filter(Boolean))
    if (s.size > 1) break
    c = el; el = el.parentElement
  }
  return c
})()
assert.ok(_card2.descendants().includes(r3.p), 'con un wrapper extra sigue encontrando su <p>')

// ── Un solo resultado en la página: no debe tragarse el body ───────────────
const body3 = new El('body')
const solo = mkResult('unico')
body3.add(solo.li)
const _card3 = (() => {
  const slugOf = (el) => (el.getAttribute('href') ?? '').match(/\/in\/([^/?#]+)/)?.[1]
  let c = solo.nombre, el = solo.nombre.parentElement
  while (el && el !== body3) {
    const s = new Set(Array.from(el.querySelectorAll('a[href*="/in/"]')).map(slugOf).filter(Boolean))
    if (s.size > 1) break
    c = el; el = el.parentElement
  }
  return c
})()
assert.notEqual(_card3, body3, 'para en el body, no lo devuelve')
assert.ok(_card3.descendants().includes(solo.p))

// ── El tope de longitud del headline (era 100; LinkedIn permite 220) ───────
const pasa = (t) => t.length <= 240
assert.ok(pasa('Purchasing Manager / Director North America, Investment Specialist, Strategic Sourcing & MRO'))
assert.ok(pasa('A'.repeat(220)), 'el máximo real de LinkedIn cabe')
assert.ok(!pasa('A'.repeat(241)), 'sigue habiendo tope: un <p> gigante no es un headline')

console.log('✅ person-card OK (aísla su resultado con niveles extra; tope de headline a 240)')
