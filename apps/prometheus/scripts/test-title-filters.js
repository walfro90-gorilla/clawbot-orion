#!/usr/bin/env node
// Self-check de passesTitleFilters — el gate que decide si un lead scrapeado llega
// siquiera al picker de invites.
//
// Avería que lo motivó (03-sep-2026, Aduanas Infinity / cuenta Rosy): la cuenta llevaba
// un día sin invitar con 7 leads en cola y 0/12 del cap usado. Los 7 los rechazaba este
// filtro. Dos de esos rechazos eran nuestros:
//   · "Material Planner at Thyssenkrupp" — el whitelist traía `materiales`/`materials`
//     pero no `material` (config, corregida en DB).
//   · headline "--" — el placeholder que renderiza LinkedIn cuando el perfil no tiene
//     titular. El guard de "sin headline" comparaba `length === 0`, así que un lead SIN
//     dato quedaba peor tratado que uno sin el campo.

// (env dummy: extension-dispatch importa lib/supabase.js, que exige las vars. No se
//  abre ninguna conexión — solo se evalúan strings.)
process.env.SUPABASE_URL ||= 'http://localhost:54321'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'dummy-key-for-test'

import assert from 'node:assert/strict'
const { passesTitleFilters } = await import('../lib/extension-dispatch.js')

const WL = ['impo', 'expo', 'logistic', 'compras', 'material', 'trafico']
const BL = ['estudiante', 'becario']

// 1. Placeholders de LinkedIn = sin headline ⇒ PASS (el search query ya filtró por puesto).
for (const ph of ['', '--', '-', '—', '...', '  ·  ', null, undefined]) {
  assert.equal(passesTitleFilters(ph, WL, BL), true, `placeholder ${JSON.stringify(ph)} debería pasar`)
}

// 2. Un headline REAL fuera del whitelist se sigue rechazando (el guard no es un pase libre).
assert.equal(passesTitleFilters('Lic. Administración Turística y de la Hospitalidad', WL, BL), false)
assert.equal(passesTitleFilters('Recursos Humanos, Nóminas y relaciones laborales', WL, BL), false)

// 3. Substring permisivo: `material` cubre singular, plural y el inglés con una sola entrada.
assert.equal(passesTitleFilters('Material Planner at Thyssenkrupp', WL, BL), true)
assert.equal(passesTitleFilters('Coordinador de Materiales', WL, BL), true)
assert.equal(passesTitleFilters('Materials Manager', WL, BL), true)

// 4. Insensible a acentos (regresión v0.9.x, hallazgo Wal 03-jul-2026).
assert.equal(passesTitleFilters('Jefe de Tráfico', WL, BL), true)

// 5. La blacklist gana al whitelist, y también sobre el placeholder.
assert.equal(passesTitleFilters('Estudiante de Comercio Exterior — practicas en logistica', WL, BL), false)

// 6. Sin whitelist configurado todo pasa salvo blacklist (comportamiento previo intacto).
assert.equal(passesTitleFilters('Cualquier cosa', [], []), true)
assert.equal(passesTitleFilters('Becario de compras', [], BL), false)

console.log('✅ test-title-filters: 16 checks OK')
process.exit(0)  // lib/supabase.js deja handles vivos → sin esto el test no termina
