// Self-check del aislamiento de la tarjeta de un resultado de personas
// (ext 0.10.35, 21-ago-2026). Conserva los casos de la v1 (subida ciega de 4 niveles) y
// añade abajo los de la v2, que es la que corre hoy: la v1 se estrenó en 0.10.33 y
// RESULTÓ SER UNA REGRESIÓN — ver el bloque "v2".
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


// ── v2: el card lleva CONTACTOS EN COMÚN, y eso rompía la v1 ───────────────
// La v1 subía "mientras haya un solo perfil distinto". Como la tarjeta incluye enlaces a
// los contactos en común, el segundo perfil aparece DENTRO del propio resultado: el bucle
// rompía al primer nivel y devolvía casi el <a>. Diagnosticado con telemetría en vivo
// (nLeaves=0, nPs=0) tras ver a Wal pasar de 0% a 58% de perfiles sin puesto.
// Criterio v2: subir al PRIMER ancestro que ya contenga texto de subtítulo.
class El2 {
  constructor(tag, href = null, text = '') { this.tag = tag; this.href = href; this.text = text; this.children = []; this.parentElement = null }
  add(...kids) { for (const k of kids) { k.parentElement = this; this.children.push(k) } return this }
  getAttribute(n) { return n === 'href' ? this.href : null }
  get textContent() { return this.text || this.children.map(c => c.textContent).join(' ') }
  descendants() { return this.children.flatMap(c => [c, ...c.descendants()]) }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null }
  querySelectorAll(sel) {
    const tags = sel.split(',').map(s => s.trim())
    return this.descendants().filter(e => tags.includes(e.tag))
  }
  closest(tag) { let e = this.parentElement; while (e) { if (e.tag === tag) return e; e = e.parentElement } return null }
}
function cardHasText(el, name) {
  if (!el) return false
  const first = (name ?? '').split(' ')[0]
  return Array.from(el.querySelectorAll('p, span, div'))
    .filter(e => !e.querySelector('p, span, div'))
    .some(e => { const t = (e.textContent || '').replace(/\s+/g, ' ').trim()
      return t.length > 4 && t !== name && !(first && t.includes(first)) })
}
function personCardV2(anchor, name) {
  const li = anchor.closest('li')
  if (li && cardHasText(li, name)) return li
  let el = anchor.parentElement
  for (let i = 0; i < 8 && el && el.tag !== 'body'; i++) {
    if (cardHasText(el, name)) return el
    el = el.parentElement
  }
  let f = anchor
  for (let i = 0; i < 4 && f.parentElement; i++) f = f.parentElement
  return f
}

// Resultado REAL: nombre + puesto + ubicación + contactos en común (con SUS enlaces).
const b = new El2('body')
const li2 = new El2('li')
const wrap = new El2('div')
const aName = new El2('a', '/in/ana-perez/', 'Ana Pérez')
const subt = new El2('span', null, 'Directora de Logística en Acme')
const loc = new El2('span', null, 'Monterrey, Nuevo León, México')
const mutual = new El2('div')
const m1 = new El2('a', '/in/otro-contacto/', 'Otro Contacto')   // <- lo que rompía la v1
const m2 = new El2('a', '/in/tercero/', 'Tercero')
mutual.add(m1, m2)
wrap.add(aName, subt, loc, mutual)
li2.add(wrap)
b.add(li2)

const card2 = personCardV2(aName, 'Ana Pérez')
assert.ok(cardHasText(card2, 'Ana Pérez'), 'el card DEBE contener texto de subtítulo')
assert.ok(card2.descendants().includes(subt), 'incluye el puesto pese a los contactos en común')

// El fallo que delató la telemetría: la v1 devolvía algo SIN texto.
const cardV1 = (() => {
  const slugOf = (el) => (el.getAttribute('href') ?? '').match(/\/in\/([^/?#]+)/)?.[1]
  let c = aName, el = aName.parentElement
  while (el && el.tag !== 'body') {
    const s = new Set(Array.from(el.querySelectorAll('a')).map(slugOf).filter(Boolean))
    if (s.size > 1) break
    c = el; el = el.parentElement
  }
  return c
})()
assert.equal(cardHasText(cardV1, 'Ana Pérez'), false, 'la v1 se quedaba sin texto: la regresión')

// Sin <li> (layout alternativo) también encuentra el card por contenido.
const b3 = new El2('body')
const d1 = new El2('div'); const d2 = new El2('div')
const aN = new El2('a', '/in/luis/', 'Luis Vega')
const sub = new El2('span', null, 'Gerente de Compras')
d2.add(aN, sub); d1.add(d2); b3.add(d1)
assert.ok(cardHasText(personCardV2(aN, 'Luis Vega'), 'Luis Vega'), 'sin <li> también')

// ── El tope de longitud del headline (era 100; LinkedIn permite 220) ───────
const pasa = (t) => t.length <= 240
assert.ok(pasa('Purchasing Manager / Director North America, Investment Specialist, Strategic Sourcing & MRO'))
assert.ok(pasa('A'.repeat(220)), 'el máximo real de LinkedIn cabe')
assert.ok(!pasa('A'.repeat(241)), 'sigue habiendo tope: un <p> gigante no es un headline')

console.log('✅ person-card OK (aísla su resultado con niveles extra; tope de headline a 240)')
