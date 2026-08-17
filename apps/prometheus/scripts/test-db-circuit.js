// Self-check del circuit breaker de DB (post-mortem 2026-08-17).
// Lo que protege: si el circuito se abre de más, el bridge deja de despachar; si no se
// abre, vuelve a martillar una DB caída e impide que levante (fue el fallo real del 17-ago).
import assert from 'node:assert'
import { noteDbResult, dbCircuitOpen, _resetDbCircuit, _DB_CIRCUIT_CONFIG } from '../lib/db-circuit.js'

const { DB_FAIL_THRESHOLD, COOLDOWN_MS } = _DB_CIRCUIT_CONFIG
const T0 = 1_000_000
const err = (m = 'supabase_query_timeout_20000ms') => ({ message: m })

// Silenciar los logs del breaker durante el test.
const [logOrig, warnOrig] = [console.log, console.warn]
console.log = console.warn = () => {}
try {

// 1. En reposo el circuito está cerrado y una query OK lo deja cerrado.
_resetDbCircuit()
assert.equal(dbCircuitOpen(T0), false, 'arranca cerrado')
assert.equal(noteDbResult(null, 'test', T0), true, 'sin error devuelve true')
assert.equal(dbCircuitOpen(T0), false, 'sigue cerrado tras un OK')

// 2. Fallos POR DEBAJO del umbral NO abren — un timeout aislado no debe parar el bridge.
_resetDbCircuit()
for (let i = 1; i < DB_FAIL_THRESHOLD; i++) {
  assert.equal(noteDbResult(err(), 'test', T0), false, 'con error devuelve false')
  assert.equal(dbCircuitOpen(T0), false, `${i} fallo(s) < umbral no abre`)
}

// 3. Al alcanzar el umbral abre, y sigue abierto durante todo el cooldown.
assert.equal(noteDbResult(err(), 'test', T0), false)
assert.equal(dbCircuitOpen(T0), true, 'abre al alcanzar el umbral')
assert.equal(dbCircuitOpen(T0 + COOLDOWN_MS - 1), true, 'sigue abierto dentro del cooldown')
assert.equal(dbCircuitOpen(T0 + COOLDOWN_MS), false, 'se cierra al expirar el cooldown')

// 4. Un OK cierra el circuito de inmediato (recuperación sin esperar al cooldown).
assert.equal(noteDbResult(null, 'test', T0), true)
assert.equal(dbCircuitOpen(T0), false, 'un OK cierra ya')

// 5. Tras cerrar, el contador se reinicia: hace falta el umbral COMPLETO otra vez.
//    Sin esto, un fallo suelto tras una recuperación reabriría el circuito.
_resetDbCircuit()
for (let i = 0; i < DB_FAIL_THRESHOLD; i++) noteDbResult(err(), 'test', T0)
assert.equal(dbCircuitOpen(T0), true)
noteDbResult(null, 'test', T0)
assert.equal(noteDbResult(err(), 'test', T0), false)
assert.equal(dbCircuitOpen(T0), false, 'un solo fallo tras recuperar NO reabre')

} finally {
  console.log = logOrig
  console.warn = warnOrig
}

console.log('✅ db-circuit OK (umbral, cooldown, cierre por OK, reinicio del contador)')
