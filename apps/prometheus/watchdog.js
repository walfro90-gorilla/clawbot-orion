#!/usr/bin/env node
/**
 * watchdog.js — Vigilante de infra DB-independiente (post-mortem 2026-07-03).
 * Reemplaza a heartbeat-check.js (que corría 30-min, solo L-V horario laboral, y leía/
 * escribía en la MISMA DB que podía estar caída → se auto-derrotaba).
 *
 * Corre por cron cada ~2 min, 24/7. Detecta los 3 modos de falla que tuvimos SIN alerta:
 *   1) DB Supabase caída/lenta   → chequeo REST directo con timeout corto (no vía la DB rota).
 *   2) Box caído                 → DEAD-MAN'S-SWITCH: pinga OPS_HEARTBEAT_URL cada run; si el
 *      box muere, el ping para y el servicio EXTERNO (Healthchecks.io/BetterStack) te alerta.
 *      Es la ÚNICA forma de cazar "el box entero está muerto" (un watchdog on-box no puede).
 *   3) scheduler/bridge muertos o en crash-loop → pm2 jlist (status + spike de restarts).
 *
 * Alertas SIEMPRE out-of-band (notify-ops.js → webhook), NUNCA vía account_alerts (la DB
 * puede ser justo lo que está caído).
 *
 * Cron (reemplaza la línea de heartbeat-check.js) — cada 2 min:
 *   0-59/2 * * * * node /root/clawbot/apps/prometheus/watchdog.js >> /root/.pm2/logs/watchdog.log 2>&1
 * Env: OPS_WEBHOOK_URL|SLACK_WEBHOOK_URL (alertas), OPS_HEARTBEAT_URL (dead-man's-switch),
 *      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (ya presentes).
 */
import dotenv from 'dotenv'
dotenv.config({ path: '/root/clawbot/apps/prometheus/.env' })
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import { notifyOps } from './lib/notify-ops.js'

const execFileP = promisify(execFile)
const HEARTBEAT_URL = process.env.OPS_HEARTBEAT_URL || ''
const STATE_FILE = process.env.WATCHDOG_STATE || '/root/.pm2/clawbot-watchdog-state.json'
const CRASH_LOOP_DELTA = parseInt(process.env.WATCHDOG_CRASHLOOP_DELTA ?? '3') // +N restarts entre corridas = crash-loop
const WATCHED = ['prometheus-scheduler', 'extension-bridge']

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return {} } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)) } catch { /* best-effort */ } }

async function checkDb() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return { ok: false, detail: 'env SUPABASE faltante' }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 8000)
  try {
    const r = await fetch(`${url}/rest/v1/linkedin_accounts?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: ctrl.signal,
    })
    return r.status === 200 ? { ok: true } : { ok: false, detail: `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, detail: e.name === 'AbortError' ? 'timeout 8s' : e.message }
  } finally { clearTimeout(t) }
}

async function checkPm2() {
  try {
    const { stdout } = await execFileP('pm2', ['jlist'], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 })
    const procs = JSON.parse(stdout)
    const out = {}
    for (const name of WATCHED) {
      const p = procs.find(x => x.name === name)
      out[name] = p
        ? { status: p.pm2_env.status, restarts: p.pm2_env.restart_time ?? 0 }
        : { status: 'MISSING', restarts: 0 }
    }
    return { procs: out }
  } catch (e) { return { error: e.message } }
}

async function pingHeartbeat(fail) {
  if (!HEARTBEAT_URL) return
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000)
  try { await fetch(HEARTBEAT_URL + (fail ? '/fail' : ''), { signal: ctrl.signal }) } catch { /* DMS best-effort */ } finally { clearTimeout(t) }
}

async function main() {
  const state = loadState()
  const wasUnhealthy = state.unhealthy === true
  const problems = []

  // 1) DB Supabase
  const db = await checkDb()
  if (!db.ok) problems.push(`DB Supabase no responde (${db.detail})`)

  // 2) procesos pm2 (scheduler + bridge) + crash-loop
  const pm2 = await checkPm2()
  if (pm2.error) {
    problems.push(`pm2 no responde (${pm2.error}) — box posiblemente degradado`)
  } else {
    for (const [name, s] of Object.entries(pm2.procs)) {
      if (s.status !== 'online') problems.push(`${name} está '${s.status}' (no online)`)
      const prev = state[`restarts_${name}`]
      if (typeof prev === 'number' && s.restarts - prev >= CRASH_LOOP_DELTA) {
        problems.push(`${name} CRASH-LOOP: +${s.restarts - prev} restarts desde el último chequeo`)
      }
      state[`restarts_${name}`] = s.restarts
    }
  }

  const stamp = new Date().toISOString()
  if (problems.length) {
    state.unhealthy = true
    const text = `🔴 Infra ClawBot con ${problems.length} problema(s):\n• ${problems.join('\n• ')}`
    console.error(`[${stamp}] ${text}`)
    await notifyOps('infra_watchdog', text, { extra: { db, pm2: pm2.procs ?? pm2 } }) // dedup 15min
    await pingHeartbeat(true)
  } else {
    console.log(`[${stamp}] ✅ infra OK (DB up · scheduler/bridge online)`)
    if (wasUnhealthy) await notifyOps('infra_recovered', '✅ Infra ClawBot RECUPERADA (DB + scheduler + bridge OK).', { force: true })
    state.unhealthy = false
    await pingHeartbeat(false) // dead-man's-switch: box + watchdog vivos
  }
  saveState(state)
}

main().catch(async (e) => {
  console.error(`[${new Date().toISOString()}] watchdog fatal:`, e.message)
  try { await notifyOps('watchdog_fatal', `El watchdog mismo falló: ${e.message}`) } catch { /* noop */ }
  process.exit(1)
})
