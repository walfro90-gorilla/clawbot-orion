#!/usr/bin/env node
// Calibración del SENSOR DE SALIDA (detectExitIntent) contra un corpus etiquetado.
// El clasificador es un LLM: su calidad no se prueba con un unit test, se MIDE contra
// frases reales. Corre esto tras tocar el prompt del sensor o cambiar de proveedor/modelo.
//
//   cd apps/prometheus && node scripts/test-exit-sensor.mjs
//
// Salida: precisión/recall + cada fallo. Los FALSOS POSITIVOS (marcar exit a un lead vivo)
// son el error caro e irreversible → el corpus carga deliberadamente casos-trampa de "no"
// que NO son rechazo (declinar un horario, posponer, derivar).
import 'dotenv/config'
import { detectExitIntent } from '../lib/ai-message.js'

const OUR_MSG = '¡Hola! ¿Te late si agendamos 15 min el martes para platicarte cómo automatizamos la prospección con IA?'

// [ mensaje del contacto, exit esperado, nuestro último mensaje (contexto) ]
const CORPUS = [
  // ── exit=true: rechazo definitivo ──
  ['No gracias', true],
  ['no me interesa', true],
  ['No estoy interesado, gracias.', true],
  ['Gracias pero no es para mí.', true],
  ['No gracias, ya trabajamos con otro proveedor y estamos contentos.', true],
  ['Lo vemos internamente, no necesitamos ayuda externa.', true],
  ['Por favor no me contactes más.', true],
  ['Quítame de tu lista.', true],
  ['Not interested, thanks.', true],
  ['Please stop messaging me.', true],
  ['Deja de escribirme, esto es spam.', true],
  ['Te agradezco el mensaje pero paso.', true],
  // Rechazo cortés SIN puerta abierta. Decisión de negocio (Walfre, 16-jul-2026): en español
  // de negocios el "no" viene envuelto en cortesía y este es el shape modal real del inbox.
  // El discriminador NO es la amabilidad, es si invita a volver — estos no invitan a nada.
  ['Gracias, no por el momento. Saludos.', true],
  ['Por ahora no, gracias.', true],

  // ── exit=false: casos-trampa (un "no" que NO cierra la puerta) ──
  ['No puedo el martes, ¿el jueves?', false],
  ['No, mejor por correo: juan@acme.com', false],
  // …los mismos "no por ahora" PERO con puerta abierta explícita → aplazamiento, no rechazo.
  ['Ahora no, escríbeme en 3 meses.', false],
  ['Por el momento estoy saturado, más adelante lo vemos.', false],
  ['Por ahora no, pero búscame en enero.', false],
  // Falsos positivos REALES cazados en el dry-run del 16-jul-2026 sobre el inbox de prod.
  // El contacto se compromete a re-contactar → puerta abierta, aunque suene a cortesía.
  ['Te comento en algunos meses si funcionó. Saludos', false],
  ['Hola, gracias. Tomo nota y en caso de requerir te busco. Gracias', false],
  // El contacto OFRECE algo y se retira de SU oferta: no nos rechaza a nosotros.
  ["Hey Walfre, if you'd rather I don't refer you over any investors let me know and I won't bother you again.", false],
  ['No soy yo quien lo ve, habla con Ana de sistemas.', false],
  ['No entiendo bien qué ofrecen, ¿me explicas?', false],
  ['¿Cuánto cuesta?', false],
  ['Me interesa, mándame info.', false],
  ['ok', false],
  ['Gracias!', false],
  ['jaja', false],
  ['No tengo presupuesto este trimestre, pero el que viene sí.', false],
  ['Suena bien, ¿tienes un caso de éxito?', false],
]

const t0 = Date.now()
const results = []
const errors = []
for (const [msg, expected, ourMsg] of CORPUS) {
  const r = await detectExitIntent(msg, ourMsg ?? OUR_MSG)
  if (r.error) {
    errors.push({ msg, error: r.error })
    continue
  }
  results.push({ msg, expected, got: r.exit, reason: r.reason, ok: r.exit === expected })
}

// Un corpus que no corrió NO es un aprobado. Sin esto, una API key inválida imprimía
// "0 falsos positivos → PASS" (verde vacío): el peor resultado posible de un test.
if (errors.length) {
  console.error(`\n❌ FAIL: ${errors.length}/${CORPUS.length} llamadas al LLM fallaron — corpus incompleto, sin veredicto.`)
  console.error(`   Primer error: ${errors[0].error.slice(0, 200)}`)
  console.error(`   (¿GROQ_API_KEY/GEMINI_API_KEY presentes y válidos? LLM_PROVIDERS=${process.env.LLM_PROVIDERS ?? 'groq,gemini'})`)
  process.exit(1)
}

const fp = results.filter(r => !r.ok && r.got === true)   // marcamos exit a un lead vivo ← CARO
const fn = results.filter(r => !r.ok && r.got === false)  // no detectamos un rechazo   ← barato
const hits = results.filter(r => r.ok).length

console.log(`\n🚪 SENSOR DE SALIDA — ${hits}/${results.length} correctos (${Date.now() - t0}ms)\n`)

if (fp.length) {
  console.log(`🔴 FALSOS POSITIVOS (${fp.length}) — matarían un lead vivo:`)
  for (const r of fp) console.log(`   "${r.msg}"\n      → exit=true por: ${r.reason}`)
  console.log('')
}
if (fn.length) {
  console.log(`🟡 FALSOS NEGATIVOS (${fn.length}) — seguiríamos escribiendo (recuperable):`)
  for (const r of fn) console.log(`   "${r.msg}"\n      → exit=false por: ${r.reason}`)
  console.log('')
}

const trueSet = results.filter(r => r.expected)
console.log(`recall  (rechazos detectados): ${trueSet.filter(r => r.ok).length}/${trueSet.length}`)
console.log(`falsos positivos: ${fp.length} (objetivo: 0)`)

// El gate duro es el falso positivo: es irreversible. Un FN solo cuesta un mensaje.
if (fp.length > 0) {
  console.error('\n❌ FAIL: hay falsos positivos — el sensor mataría leads vivos. Ajusta el prompt.')
  process.exitCode = 1
} else {
  console.log('\n✅ PASS: 0 falsos positivos.')
}
