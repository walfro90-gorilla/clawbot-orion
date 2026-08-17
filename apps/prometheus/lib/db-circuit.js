// Circuit breaker de DB — post-mortem 2026-08-17.
//
// Durante el outage de PostgREST el bridge martilló ~2h una API muerta: cada query colgaba
// 20s (timeout de lib/supabase.js) y esa presión IMPEDÍA que la instancia levantara — hubo
// que parar el proceso A MANO, dos veces, para que se recuperara sola. Con el circuito, tras
// N fallos seguidos el poll y el cleanup se pausan y solo se sondea cada COOLDOWN_MS.
//
// Principio que ordena sus usos: **un fallo de infraestructura NO es un fallo de datos.**
// Confundirlos fue lo que rompió el 17-ago (un timeout se leyó como "key inválida" y mandó
// las 4 cuentas a lockout de 5min en cascada).
//
// ponytail: estado de módulo, no una clase — hay UN bridge por proceso. Si algún día hace
// falta un circuito por-recurso (REST vs Realtime), esto pasa a fábrica.

const DB_FAIL_THRESHOLD = 3
const COOLDOWN_MS = 60 * 1000

let consecutiveFails = 0
let openUntil = 0

/**
 * Registra el resultado de una query centinela.
 * @param {{message?: string}|null} error  el `error` de supabase-js (null = ok)
 * @param {string} where  etiqueta para el log
 * @param {number} now  inyectable para test
 * @returns {boolean} true si la DB respondió
 */
export function noteDbResult(error, where, now = Date.now()) {
  if (!error) {
    if (consecutiveFails > 0) console.log(`[bridge] ✅ DB responde de nuevo (${where}) — circuito cerrado`)
    consecutiveFails = 0
    openUntil = 0
    return true
  }
  consecutiveFails++
  if (consecutiveFails >= DB_FAIL_THRESHOLD && openUntil < now) {
    openUntil = now + COOLDOWN_MS
    console.warn(`[bridge] 🔌 CIRCUITO DB ABIERTO tras ${consecutiveFails} fallos seguidos (${where}: ${error.message}) — pausa ${COOLDOWN_MS / 1000}s`)
  }
  return false
}

/** true = saltarse este ciclo (poll/cleanup) para no añadir presión. */
export function dbCircuitOpen(now = Date.now()) {
  return openUntil > now
}

/** Solo para tests. */
export function _resetDbCircuit() {
  consecutiveFails = 0
  openUntil = 0
}

export const _DB_CIRCUIT_CONFIG = { DB_FAIL_THRESHOLD, COOLDOWN_MS }
