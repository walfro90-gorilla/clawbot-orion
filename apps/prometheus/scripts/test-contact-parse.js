#!/usr/bin/env node
// Self-check del parseo de contact-info (ext 0.10.39, 26-ago-2026).
//
// El scraper vive en apps/orion-extension/content.js y necesita un DOM, así que no se
// puede importar aquí. Lo que este check protege es lo que de verdad se rompió: las
// REGEX de etiqueta/teléfono y la forma del markup. El fixture es el DOM REAL capturado
// con debug:true sobre un lead de Josh (Esteban I. Espinosa, 26-ago-2026) — el mismo que
// demostró que teníamos teléfono y cumpleaños delante y no los sacábamos.
//
// Si alguien edita esas regex en content.js sin actualizarlas aquí, el check falla.
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CONTENT_JS = join(here, '../../orion-extension/content.js')

// ── Fixture: los items del overlay tal cual los sirve LinkedIn (SDUI) ────────
// <div><svg/><div><p>ETIQUETA</p><p>VALOR</p></div></div> — sin <section>, sin <h3>.
const FIXTURE = `
<div data-testid="dialog-content" data-sdui-screen="com.linkedin.sdui.flagshipnav.profile.ProfileContactDetailsOverlay">
  <div><svg id="linkedin-bug-medium"></svg><div><p>Perfil de Esteban Ignacio</p><p><a href="https://www.linkedin.com/in/esteban-ignacio-espinosa-oneto-03417237/">linkedin.com/in/esteban-ignacio-espinosa-oneto-03417237</a></p></div></div>
  <div><svg id="phone-handset-small"></svg><div><p>Teléfono</p><p><span>+56 9 68371316</span><span> </span>(móvil)</p></div></div>
  <div><svg id="envelope-medium"></svg><div><p>Email</p><p><a href="mailto:esteban.espinosa@hotmail.com" target="_blank">esteban.espinosa@hotmail.com</a></p></div></div>
  <div><svg id="calendar-medium"></svg><div><p>Cumpleaños</p><p>24 de abril</p></div></div>
  <div><svg id="people-medium"></svg><div><p>Contacto desde</p><p>19 jun. 2026</p></div></div>
</div>`

// ── Las mismas regex que usa scrapeContactInfo ───────────────────────────────
const LABEL_PHONE = /^(tel[eé]fono|phone|m[oó]vil|mobile|celular)s?$/i
const LABEL_BDAY  = /^(cumplea[nñ]os|birthday)$/i
const LABEL_EMAIL = /^(email|e-mail|correo( electr[oó]nico)?)$/i
const PHONE_RE    = /[+(]?\d[\d\s().-]{6,}\d/

// innerText de cada <p> del fixture, en orden de documento
const ps = [...FIXTURE.matchAll(/<p>([\s\S]*?)<\/p>/g)]
  .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
const valuesFor = re => ps.map((p, i) => (re.test(p) ? (ps[i + 1] ?? '') : '')).filter(Boolean)

let n = 0
const ok = (label, cond) => { assert.ok(cond, `FALLO: ${label}`); n++; console.log(`  ✓ ${label}`) }

console.log('contact-info parse:')

// 1) Lo que estaba roto: teléfono y cumpleaños (1 teléfono en 650 scrapes)
const phone = (valuesFor(LABEL_PHONE)[0] ?? '').match(PHONE_RE)?.[0]
ok('saca el teléfono del par etiqueta→valor', phone === '+56 9 68371316')
ok('descarta el sufijo "(móvil)"', !String(phone).includes('móvil'))
ok('saca el cumpleaños', valuesFor(LABEL_BDAY)[0] === '24 de abril')

// 2) Lo que ya funcionaba, que no se rompa
ok('saca el email por etiqueta', valuesFor(LABEL_EMAIL)[0] === 'esteban.espinosa@hotmail.com')

// 3) Falsos positivos: una fecha NO es un teléfono
ok('"19 jun. 2026" no matchea como teléfono', !PHONE_RE.test('19 jun. 2026'))
ok('"24 de abril" no matchea como teléfono', !PHONE_RE.test('24 de abril'))

// 4) Las etiquetas van ancladas: el VALOR nunca debe leerse como etiqueta
ok('el valor del teléfono no matchea la etiqueta', !LABEL_PHONE.test('+56 9 68371316 (móvil)'))

// 5) Drift: las regex deben seguir siendo las mismas en content.js
const content = readFileSync(CONTENT_JS, 'utf-8')
for (const [name, re] of [['teléfono', LABEL_PHONE], ['cumpleaños', LABEL_BDAY], ['email', LABEL_EMAIL], ['PHONE_RE', PHONE_RE]]) {
  ok(`content.js sigue usando la regex de ${name}`, content.includes(re.source))
}

// 6) El acotado de la raíz: sin él, root era <div id="root"> = la página entera
ok('content.js acota la raíz al overlay (isScoped)', content.includes('isScoped') && content.includes('data-sdui-screen'))
ok('content.js verifica que la página sea la del lead', content.includes("fail('wrong_page')"))

console.log(`contact-info parse: ${n}/${n} OK`)
