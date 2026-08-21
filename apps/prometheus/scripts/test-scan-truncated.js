// Self-check del detector de check_connections TRUNCADO (21-ago-2026).
// (copia fiel del predicado de extension-bridge.js. Si cambias uno, cambia el otro.)
//
// Hallazgo del hard testing: el flag `degraded` de la extensión solo cubre el caso
// "pestaña oculta desde el principio" (rounds===0 && hiddenWaits>0). Un barrido que
// ARRANCA bien y se corta a mitad llega con degraded:false y pasa por sano.
// Medido en Wal: 70 conexiones con rounds=15 cuando sus 6 scans anteriores daban
// 379-409 con rounds=80.
//
// Lo que protege, en los dos sentidos:
//  - NO detectarlo: la accept-detection busca entre 70 de 409 y da por NO aceptados a los
//    que sí lo hicieron ⇒ accepts reales sin follow-up, que es el fallo caro (caso 8-jun).
//  - Detectarlo de más: se descarta un scan bueno y la detección se queda sin sello ⇒ cae
//    a la inferencia por ausencia, que fabrica conexiones falsas. Por eso el umbral es
//    generoso (50%) y exige un techo mínimo.
import assert from 'node:assert/strict'

const esTruncado = (scraped, techo) => techo >= 50 && scraped < techo * 0.5

// ── El caso real que lo motivó ──────────────────────────────────────────────
assert.equal(esTruncado(70, 409), true, 'Wal: 70 de 409 es truncado')

// ── Scans sanos: NO deben marcarse ─────────────────────────────────────────
assert.equal(esTruncado(396, 409), false, 'Josh full')
assert.equal(esTruncado(379, 409), false, 'variación normal entre scans')
assert.equal(esTruncado(152, 152), false, 'Café estable')
assert.equal(esTruncado(299, 409), false, 'baja del 27%: variación, no truncado')
assert.equal(esTruncado(205, 409), false, 'justo en el 50% NO se marca (borde permisivo)')
assert.equal(esTruncado(204, 409), true, 'por debajo del 50% sí')

// ── Cuentas pequeñas: el techo mínimo evita falsos positivos ───────────────
// Rosy tiene 12 conexiones; pasar de 12 a 5 es ruido normal de una lista diminuta y NO
// debe bloquear su sello (si no, se quedaría sin accept-detection para siempre).
assert.equal(esTruncado(5, 12), false, 'cuenta pequeña: no aplica')
assert.equal(esTruncado(1, 49), false, 'techo por debajo del mínimo: no aplica')
assert.equal(esTruncado(10, 50), true, 'a partir del techo mínimo sí aplica')

// ── Cuenta nueva sin histórico ─────────────────────────────────────────────
assert.equal(esTruncado(12, 0), false, 'sin scans previos no hay con qué comparar')
assert.equal(esTruncado(0, 0), false)

// ── Crecimiento: nunca es truncado ─────────────────────────────────────────
assert.equal(esTruncado(500, 409), false, 'la lista creció')

console.log('✅ scan-truncated OK (caza el barrido cortado, respeta la variación normal y las cuentas pequeñas)')
