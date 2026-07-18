// Regresión del incidente "logJob muerto-al-nacer" (hard testing 17-jul-2026).
//
// El catch de runTickSafely aborta la señal del tick (kill-switch anti-zombie del post-mortem
// 03-jul) y DESPUÉS quiere loguear el error en scheduler_log. Como la señal abortada sigue
// instalada, fetchWithTimeout (lib/supabase.js) la ve .aborted y cancela la query ANTES de que
// salga del proceso; postgrest devuelve { error } en vez de LANZAR, así que un `.catch()` no
// salva nada y la fila nunca se escribe. El bug pasó node --check, los unit tests y el build:
// era código muerto-al-nacer, no un error de sintaxis. Este test fija el invariante del fix.
//
// Usa el cliente REAL de lib/supabase.js apuntado a un PostgREST falso local (no una copia de
// fetchWithTimeout: una copia no detectaría un cambio futuro en supabase.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// PostgREST falso: registra los POST que REALMENTE llegan por la red.
const received = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    received.push({ url: req.url, body })
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end('[]')
  })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const { port } = server.address()

// El cliente lee las env AL IMPORTAR → apuntarlo al server falso antes del import dinámico.
process.env.SUPABASE_URL = `http://127.0.0.1:${port}`
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy_key_for_test'
const { supabase, setTickSignal } = await import('../lib/supabase.js')

const insert = () => supabase.from('scheduler_log').insert({ job_type: 'tick', status: 'error' })

test('tick signal abortada: la query muere ANTES de la red, y desinstalarla la revive', async (t) => {
  t.after(() => { setTickSignal(null); server.close() })

  // 1. Sin señal → la query llega (control).
  setTickSignal(null)
  received.length = 0
  const ok = await insert()
  assert.equal(ok.error, null, 'sin señal de tick el insert no debe fallar')
  assert.equal(received.length, 1, 'sin señal de tick el insert SÍ llega al server')

  // 2. Señal abortada instalada (el estado exacto del catch de runTickSafely tras ctrl.abort()).
  const ctrl = new AbortController()
  setTickSignal(ctrl.signal)
  ctrl.abort(new Error('tick_soft_timeout'))
  received.length = 0
  const killed = await insert()
  assert.ok(killed.error, 'con la señal abortada, postgrest devuelve {error}…')
  assert.equal(received.length, 0, '…y el insert NUNCA sale a la red (este era el bug)')

  // 3. El fix: desinstalar la señal solo para esta query → la fila SÍ se escribe.
  setTickSignal(null)
  received.length = 0
  const revived = await insert()
  assert.equal(revived.error, null, 'tras setTickSignal(null) el insert funciona')
  assert.equal(received.length, 1, 'la fila del tile "Errores hoy" SÍ llega')

  // 4. Re-instalar la señal ABORTADA deja el kill-switch anti-zombie intacto.
  setTickSignal(ctrl.signal)
  received.length = 0
  const blockedAgain = await insert()
  assert.ok(blockedAgain.error, 'la señal re-instalada vuelve a cancelar (kill-switch vivo)')
  assert.equal(received.length, 0, 'el tick huérfano sigue sin poder martillar la DB')
})
