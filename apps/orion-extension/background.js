// v0.5.4 — autoDiscardable + reviveTabIfDiscarded — sobrevive background mode
// ─────────────────────────────────────────────────────────────────────────────
// Orion Sync — Background Service Worker (Manifest V3)
//
// Responsabilidades:
//   1. Mantener WebSocket persistente con Orion server
//   2. Recibir comandos del server (send_invite, check_inbox, send_fu, search)
//   3. Despachar comandos al content script de la tab LinkedIn activa
//   4. Reportar resultados de vuelta al server
//   5. Reconexión automática con backoff exponencial
//
// Importante MV3: este service worker se duerme cuando no hay actividad.
// La WS se restablece al despertar. Por eso usamos alarms para keep-alive.
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEYS = {
  ORION_URL:  'orion_url',     // ej: 'https://app.tuOrion.com' (tu instancia)
  API_KEY:    'orion_api_key', // generada en /dashboard/accounts
  ACTIVE_ACCOUNT_ID: 'active_account_id',
  CONNECTED:  'connected',
}

console.log('[Orion bg] v0.1.2 loaded')

let ws = null
let reconnectAttempts = 0
let heartbeatInterval = null
let isConnecting = false       // guard contra connect() concurrentes
let reconnectTimer = null      // timer del setTimeout en scheduleReconnect (cancela duplicados)
let lastCommandAt = 0          // timestamp del último comando dispatchado a un tab
let lastCommandAction = null   // acción del último comando (para el indicador visual)
let boundTabId = null          // tab.id de LinkedIn que recibió el último comando
let lastInboundAt = 0          // ts del último frame del bridge (watchdog anti-zombie half-open, ext2)

// ── Lifecycle ────────────────────────────────────────────────────────────────

self.addEventListener('install', () => {
  console.log('[Orion bg] Service worker installed')
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  console.log('[Orion bg] Service worker activated')
  event.waitUntil(self.clients.claim())
  // No conectamos automáticamente — esperamos a que el usuario configure API key
  initIfConfigured()
})

// v0.6.50: PERMITIR que content.js (contexto untrusted) acceda a storage.session.
// Por default storage.session solo es accesible desde SW (trusted). Sin esto,
// v0.6.49 mutex no funcionaba — content.js escribía pero SW no veía nada.
// Sin esta línea el typing a María Eugenia se interrumpía porque pre-nav check
// no detectaba el cmd en flight desde content.js.
try {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .then(() => console.log('[Orion] storage.session: untrusted contexts allowed'))
    .catch(err => console.warn('[Orion] storage.session setAccessLevel fail:', err?.message))
} catch (err) {
  console.warn('[Orion] storage.session setAccessLevel sync error:', err?.message)
}

// Keep-alive via alarm (MV3 sleeps SW después de 30s idle)
chrome.alarms.create('keep-alive', { periodInMinutes: 0.25 })  // 15s
// Update check cada 60 min
chrome.alarms.create('update-check', { periodInMinutes: 60, delayInMinutes: 1 })
// v0.7.12 P0-1: runtime_config refresh broadcast a content scripts cada 5 min.
// content.js ya tiene su propio setInterval, pero esto cubre el edge case de
// tabs viejas que estaban abiertas cuando se hizo bump de config server-side.
chrome.alarms.create('runtime-config-refresh', { periodInMinutes: 5, delayInMinutes: 1 })

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keep-alive') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })) } catch {}
      // ext2: watchdog de socket half-open. Tras un corte de red sin FIN el socket queda
      // readyState=OPEN pero muerto; el bridge nos pinga cada 20s, así que >60s sin NINGÚN
      // inbound = zombie. Cerrar → el handler 'close' dispara scheduleReconnect(). Sin esto la
      // cuenta se apagaba en silencio (popup verde). El guard `lastInboundAt &&` evita cerrar
      // un socket recién abierto que aún no recibió nada.
      if (lastInboundAt && Date.now() - lastInboundAt > 60_000) {
        console.warn('[Orion] socket half-open (>60s sin inbound) → forzando reconexión')
        try { ws.close() } catch {}
      }
    } else {
      initIfConfigured()
    }
  }
  if (alarm.name === 'update-check') {
    checkForUpdate().catch(err => console.warn('[Orion] update check failed:', err.message))
  }
  if (alarm.name === 'runtime-config-refresh') {
    broadcastRuntimeConfigRefresh().catch(err => console.warn('[Orion] runtime-config refresh failed:', err.message))
  }
})

// v0.7.17 P0-1 fix: SW-side fetch + POST heartbeat DIRECTLY, no depende de tabs.
// El bug pre-v0.7.17: content.js POST heartbeat solo cuando tab LinkedIn viva.
// Bridge cierra tabs efímeras tras cada cmd → setInterval muere antes del primer fire.
// Fix: SW hace fetch GET /api/runtime-config + POST /api/runtime-config/heartbeat
// con su propio fetch (no requiere tabs). Después broadcast a tabs como bonus.
async function loadAndPostHeartbeatFromSW() {
  try {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.ORION_URL,
      STORAGE_KEYS.ACTIVE_ACCOUNT_ID,
      'account_id',  // fallback legacy key usado por content.js
    ])
    if (!stored?.orion_url) return { skipped: 'no_orion_url' }
    const account_id = stored?.active_account_id ?? stored?.account_id
    if (!account_id) return { skipped: 'no_account_id' }

    // 1. GET /api/runtime-config (latest server-side config)
    let runtimeConfig = {}
    try {
      // v0.7.47: account_id → el API mergea overrides per-cuenta sobre el global. Shape idéntico.
      const r = await fetch(`${stored.orion_url}/api/runtime-config?account_id=${encodeURIComponent(account_id)}`, { cache: 'no-store' })
      if (r.ok) {
        const j = await r.json().catch(() => null)
        if (j?.config) {
          runtimeConfig = j.config
          // Persist to storage for content.js to pick up on next inject
          await chrome.storage.local.set({ _runtime_config: j })
        }
      }
    } catch (err) {
      console.warn('[Orion bg] runtime-config fetch failed:', err?.message)
    }

    // 2. POST /api/runtime-config/heartbeat (always, even if fetch failed — proves SW alive)
    const ext_version = chrome.runtime.getManifest().version
    const body = {
      account_id,
      ext_version,
      phase_timeouts: runtimeConfig.phase_timeouts ?? null,
      send_method_order: runtimeConfig.send_method_order ?? null,
      page_errors_extra: runtimeConfig.page_errors_extra ?? null,
    }
    const hbRes = await fetch(`${stored.orion_url}/api/runtime-config/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(err => ({ ok: false, err: err?.message }))
    if (hbRes?.ok) {
      console.log(`[Orion bg] P0-1 heartbeat POST ok (v${ext_version})`)
    } else {
      console.warn('[Orion bg] P0-1 heartbeat POST failed:', hbRes?.err ?? hbRes?.status)
    }
    return { posted: !!hbRes?.ok }
  } catch (err) {
    console.warn('[Orion bg] loadAndPostHeartbeatFromSW error:', err?.message)
    return { error: err?.message }
  }
}

// v0.7.12 P0-1 + v0.7.17 fix: SW posts heartbeat itself, then broadcasts to tabs as bonus.
async function broadcastRuntimeConfigRefresh() {
  // Primary path: SW does the work (independent of tabs)
  await loadAndPostHeartbeatFromSW()
  // Secondary path: broadcast to live tabs so content.js refreshes its in-memory cache
  try {
    const tabs = await chrome.tabs.query({ url: ['*://*.linkedin.com/*'] })
    let ok = 0, fail = 0
    for (const t of tabs) {
      try {
        await chrome.tabs.sendMessage(t.id, { type: 'orion_runtime_config_refresh', ts: Date.now() })
        ok++
      } catch { fail++ }
    }
    if (ok > 0 || fail > 0) console.log(`[Orion bg] runtime-config refresh broadcast: ${ok} ok, ${fail} fail`)
  } catch (err) {
    console.warn('[Orion bg] broadcastRuntimeConfigRefresh error:', err?.message)
  }
}

// ── v0.10.2 — refrescar las pestañas de LinkedIn cuando cambia la versión ────
// El service worker se recarga con el código nuevo al instante, pero el content.js
// que ya está inyectado en una pestaña abierta sigue siendo el VIEJO. Resultado: la
// cuenta reporta ext_version nueva (la lee el SW del manifest) mientras ejecuta lógica
// vieja en la página. Pasó el 2-ago: las 3 cuentas decían 0.10.1 y el resolver seguía
// devolviendo la página duplicada de la empresa porque content.js era 0.10.0.
// El paso manual "refresca la pestaña de LinkedIn" se olvida — así que lo hacemos solos,
// UNA vez por versión (la marca vive en storage; sin ella el SW, que Chrome recicla cada
// pocos segundos, recargaría las pestañas sin parar).
async function reloadLinkedInTabsOnVersionChange() {
  try {
    const version = chrome.runtime.getManifest().version
    const { content_version_seen } = await chrome.storage.local.get('content_version_seen')
    if (content_version_seen === version) return
    await chrome.storage.local.set({ content_version_seen: version })
    const tabs = await chrome.tabs.query({ url: ['*://*.linkedin.com/*'] })
    for (const t of tabs) {
      try { await chrome.tabs.reload(t.id) } catch { /* pestaña muerta */ }
    }
    console.log(`[Orion] v${version}: ${tabs.length} pestañas de LinkedIn recargadas (content.js nuevo)`)
  } catch (err) {
    console.warn('[Orion] reloadLinkedInTabsOnVersionChange:', err?.message)
  }
}
reloadLinkedInTabsOnVersionChange()

// ── Update check ────────────────────────────────────────────────────────────
// Consulta /api/extension/version y guarda info de update disponible en storage.
// El popup lo muestra como banner.

async function checkForUpdate() {
  const { orion_url } = await chrome.storage.local.get([STORAGE_KEYS.ORION_URL])
  if (!orion_url) return

  try {
    const r = await fetch(`${orion_url}/api/extension/version`, { cache: 'no-store' })
    if (!r.ok) return
    const data = await r.json()
    const currentVersion = chrome.runtime.getManifest().version
    if (compareVersions(data.version, currentVersion) > 0) {
      console.log(`[Orion] Update available: ${currentVersion} → ${data.version}`)
      await chrome.storage.local.set({
        update_available: {
          version:    data.version,
          tarballUrl: data.tarballUrl,
          installers: data.installers,
          checkedAt:  Date.now(),
        },
      })
      // Badge visual sobre el icono — visible aunque popup esté cerrado
      try {
        chrome.action.setBadgeText({ text: '↑' })
        chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' })  // ámbar
        chrome.action.setTitle({ title: `Orion Sync — Update v${data.version} disponible` })
      } catch (err) {
        console.warn('[Orion] badge update set failed:', err?.message)
      }
    } else {
      await chrome.storage.local.remove('update_available')
      // Limpia badge solo si era nuestro (no pisar badges de error/connect status)
      try {
        const txt = await chrome.action.getBadgeText({})
        if (txt === '↑') {
          chrome.action.setBadgeText({ text: '' })
          chrome.action.setTitle({ title: 'Orion Sync' })
        }
      } catch {}
    }
  } catch (err) {
    console.warn('[Orion] update fetch error:', err.message)
  }
}

// Compara versiones semver simples (x.y.z). Retorna -1, 0, 1.
function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1
  }
  return 0
}

// ── Connection management ────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function initIfConfigured() {
  const { orion_url, orion_api_key, active_account_id } = await chrome.storage.local.get([
    STORAGE_KEYS.ORION_URL,
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.ACTIVE_ACCOUNT_ID,
  ])
  if (!orion_url || !orion_api_key || !active_account_id) {
    console.log('[Orion] Not configured — open popup to set API key + account')
    return
  }

  // Validation: detecta config cruzada (API key en campo Account ID y viceversa).
  // Si el usuario configuró mal en una versión anterior sin validación, el storage
  // queda con valores inválidos y el SW reintenta infinitamente. Mejor detectar
  // aquí y NO reintentar — popup verá last_auth_error y mostrará banner.
  const apiKeyValid = orion_api_key.startsWith('orion_sk_') && orion_api_key.length >= 30
  const accountIdValid = UUID_RE.test(active_account_id)

  if (!apiKeyValid || !accountIdValid) {
    const reason = !apiKeyValid && !accountIdValid ? 'ambos_campos_cruzados'
                 : !apiKeyValid ? 'apikey_no_empieza_con_orion_sk_'
                 : 'account_id_no_es_uuid'
    console.error(`[Orion] ⛔ Config inválida en storage — NO se conecta. Razón: ${reason}`)
    console.error(`[Orion]   apiKey valid: ${apiKeyValid}, accountId valid: ${accountIdValid}`)
    console.error(`[Orion]   Abre el popup y reconfigura — probablemente cruzaste API Key y Account ID.`)
    await chrome.storage.local.set({
      last_auth_error: { error: 'config_invalid_' + reason, ts: Date.now() },
    })
    return
  }

  connect(orion_url, orion_api_key, active_account_id)

  // v0.7.17 P0-1 fix: trigger heartbeat ASAP, no esperar 5min de alarm.
  // Esto garantiza que cualquier SW restart manda heartbeat al server.
  loadAndPostHeartbeatFromSW().catch(err => console.warn('[Orion bg] initial heartbeat failed:', err?.message))
}

async function connect(orionUrl, apiKey, accountId) {
  // Guard: si ya estamos conectando, no creamos otra conexión paralela
  if (isConnecting) {
    console.log('[Orion] connect() saltado — isConnecting=true')
    return
  }
  // C2 fix (2026-05-29): guard cubre CLOSING también — antes solo CONNECTING/OPEN
  // dejaba que un WS en CLOSING permitiera abrir otra paralela = 2 sockets zombie.
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    console.log('[Orion] connect() saltado — ws state =', ws.readyState)
    return
  }
  // Si había una vieja en estado raro, la cerramos
  if (ws) { try { ws.close() } catch {} ws = null }

  // C1 fix (2026-05-29): auth lockout client-side SOLO para errores PERMANENTES (invalid_api_key
  // / too_many_auth_failures_locked). Si sigue vigente, NO reconectes — evita el loop de 50+ Auth
  // FAILED que satura el bridge y mata el SW. Se libera al expirar, al reconectar con auth_ok, o
  // con el botón Reconectar del popup (que limpia auth_lockout_until). Transitorios NO ponen lockout.
  try {
    const { auth_lockout_until } = await chrome.storage.local.get('auth_lockout_until')
    if (auth_lockout_until && Date.now() < auth_lockout_until) {
      const remainSec = Math.round((auth_lockout_until - Date.now()) / 1000)
      console.warn(`[Orion] Auth lockout activo — ${remainSec}s restantes. NO reconectar.`)
      updateBadge('🔒', '#ef4444')
      return
    }
  } catch {}

  isConnecting = true

  const wsUrl = orionUrl.replace(/^http/, 'ws') + `/api/extension/ws?account=${accountId}`
  console.log(`[Orion] Connecting to ${wsUrl}...`)

  try {
    ws = new WebSocket(wsUrl)
  } catch (err) {
    console.error('[Orion] WS construction failed:', err)
    isConnecting = false
    scheduleReconnect()
    return
  }

  ws.addEventListener('open', () => {
    console.log('[Orion] WS connected')
    isConnecting = false
    reconnectAttempts = 0
    lastInboundAt = Date.now()   // ext2: baseline para el watchdog (socket fresco = vivo)
    // Clear last auth error (estamos conectando otra vez)
    chrome.storage.local.remove('last_auth_error')
    // Auth handshake: enviar API key inmediatamente
    ws.send(JSON.stringify({
      type:       'auth',
      apiKey,
      accountId,
      version:    chrome.runtime.getManifest().version,
      userAgent:  navigator.userAgent,
    }))
    chrome.storage.local.set({ [STORAGE_KEYS.CONNECTED]: true })
    updateBadge('●', '#22c55e') // green dot
    // Opción B: re-enviar resultados que quedaron pendientes por WS caído
    flushPendingResults().catch(err => console.warn('[Orion] flush on open falló:', err.message))
  })

  ws.addEventListener('message', async (event) => {
    lastInboundAt = Date.now()   // ext2: cualquier frame del bridge = socket vivo
    let msg
    try { msg = JSON.parse(event.data) } catch { return }
    await handleServerMessage(msg)
  })

  ws.addEventListener('close', () => {
    console.log('[Orion] WS closed')
    isConnecting = false
    chrome.storage.local.set({ [STORAGE_KEYS.CONNECTED]: false })
    updateBadge('×', '#ef4444') // red x
    scheduleReconnect()
  })

  ws.addEventListener('error', (err) => {
    console.warn('[Orion] WS error event')
    isConnecting = false
    // close handler también dispara — pero por seguridad reseteamos aquí
  })
}

function scheduleReconnect() {
  // Cancelar timer previo (evita duplicados)
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts++
  // Backoff exponencial con jitter: 2s → 4s → 8s → 16s → max 60s
  const baseDelay = Math.min(60_000, 2_000 * Math.pow(2, reconnectAttempts - 1))
  const jitter = Math.random() * 1_000
  const delay = baseDelay + jitter
  console.log(`[Orion] Reconnecting in ${(delay/1000).toFixed(1)}s (attempt ${reconnectAttempts})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    initIfConfigured()
  }, delay)
}

// ── Message handlers ─────────────────────────────────────────────────────────

async function handleServerMessage(msg) {
  console.log('[Orion] Server msg:', msg.type)
  switch (msg.type) {
    case 'auth_ok':
      console.log('[Orion] Authenticated as', msg.accountLabel ?? msg.accountId)
      chrome.storage.local.remove('auth_lockout_until')  // auth OK real → no queda lockout pendiente
      // Re-afirma verde: 'open' setea CONNECTED=true optimista ANTES de autenticar; si un race
      // dejó CONNECTED=false en un socket que sí autenticó, este es el momento de corregirlo.
      chrome.storage.local.set({ [STORAGE_KEYS.CONNECTED]: true })
      return
    case 'auth_error': {
      console.error('[Orion] Auth failed:', msg.error)
      // Clasificar PERMANENTE vs TRANSITORIO (incidente Josh 16-jul): antes CUALQUIER auth_error
      // metía 5 min de lockout, así que un race transitorio de ~600ms mataba la cuenta 5 min.
      // Solo los permanentes merecen lockout (evitan el retry-storm de 50+ Auth FAILED que motivó
      // el fix C1); los transitorios reconectan con el backoff normal (~2s) y se auto-limpian al
      // reconectar con auth_ok.
      const PERMANENT = ['invalid_api_key']
      if (msg.error === 'too_many_auth_failures_locked' && msg.retryAfter) {
        chrome.storage.local.set({ auth_lockout_until: msg.retryAfter })  // honrar la ventana del server
      } else if (PERMANENT.includes(msg.error)) {
        chrome.storage.local.set({ auth_lockout_until: Date.now() + 5 * 60_000 })
      }
      // else: transitorio (auth_required, duplicate_connection_race, o código desconocido) → SIN lockout.
      chrome.storage.local.set({
        [STORAGE_KEYS.CONNECTED]: false,
        last_auth_error: { error: msg.error, ts: Date.now() },
      })
      return
    }
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }))
      return
    case 'pong':
      // ack del keep-alive
      return
    case 'command':
      // v0.6.44: SERIALIZACIÓN — si el bridge despacha 2 cmds en paralelo
      // (porque el primero ya pasó su expires_at de 3min pero content.js sigue
      // tipeando), el SW ANTES navegaba la tab para cmd2 mientras cmd1 estaba
      // typeando → "Leave site?" modal de Chrome y mensaje a medias.
      // Esta cola fuerza que cmd2 espere a que executeCommand(cmd1) resuelva.
      // NO usar await: si bloqueamos aquí, no procesamos pings/pongs del WS
      // y el bridge nos marca stale a los 90s. Fire-and-forget; el resultado
      // se manda via WS dentro de executeCommand.
      enqueueCommand(msg.commandId, msg.action, msg.payload)
      return
    default:
      console.warn('[Orion] Unknown msg type:', msg.type)
  }
}

// ── FSM Phase Guard (v0.7.0) ────────────────────────────────────────────────
// Lee el phase actual de storage.session y espera hasta que sea seguro navegar.
// "Safe" phases: idle, send_confirmed, done, error.
// "Active" phases (bloquean nav): dispatched, navigating, hydrating, thread_opened,
//   typed, send_clicked.
// v0.7.21 P2-6: removidos 'navigating' y 'hydrating' (referencias muertas).
const FSM_ACTIVE = new Set(['dispatched','thread_opened','typing','typed','send_clicked'])
const FSM_STORAGE_KEY = '_phase_fsm'
const FSM_PHASE_MAX_AGE_MS = 130_000  // si una phase lleva >130s sin transitar, asumimos stale

async function readPhase() {
  try {
    const stored = await chrome.storage.session.get(FSM_STORAGE_KEY)
    return stored?.[FSM_STORAGE_KEY] ?? null
  } catch { return null }
}

async function waitForSafePhase(currentCommandId, maxWaitMs = 130_000) {
  const startWait = Date.now()
  while (Date.now() - startWait < maxWaitMs) {
    const phase = await readPhase()
    if (!phase) return  // no FSM active = idle
    const { state, commandId, transitionedAt } = phase
    const elapsed = Date.now() - (transitionedAt ?? 0)
    // Mismo cmd ya en vuelo: NO renavegar, retornar al caller que termine flujo.
    if (commandId === currentCommandId && FSM_ACTIVE.has(state)) {
      console.log(`[Orion FSM] ⏸️  cmd ${currentCommandId?.slice(0,8)} ya en phase '${state}' (${elapsed}ms) — abort dispatch`)
      throw new Error('phase_guard_same_command_active')
    }
    // Phase no activa O stale: safe to navigate
    if (!FSM_ACTIVE.has(state) || elapsed > FSM_PHASE_MAX_AGE_MS) {
      if (elapsed > FSM_PHASE_MAX_AGE_MS) {
        console.warn(`[Orion FSM] phase '${state}' stale (${elapsed}ms) — force release`)
        try { await chrome.storage.session.remove(FSM_STORAGE_KEY) } catch {}
      }
      return
    }
    // Phase activa de OTRO cmd → esperar
    console.log(`[Orion FSM] ⏳  esperando phase '${state}' (cmd ${commandId?.slice(0,8)}, ${elapsed}ms)`)
    await sleep(1500)
  }
  // Timeout esperando: force-release y proceder (defensive)
  console.warn(`[Orion FSM] timeout esperando safe phase (${maxWaitMs}ms) — force-release y proceder`)
  try { await chrome.storage.session.remove(FSM_STORAGE_KEY) } catch {}
}

// ── Command queue (v0.6.44) ────────────────────────────────────────────────
// Serializa todos los comandos para evitar que un nuevo navigateTabAndWait
// interrumpa el typing/send del comando anterior. Si bridge expira cmd1 a 3min
// y despacha cmd2, cmd2 espera aquí hasta que cmd1 termine COMPLETAMENTE.
let commandChain = Promise.resolve()

function enqueueCommand(commandId, action, payload) {
  const queued = commandChain.then(
    () => executeCommand(commandId, action, payload),
    () => executeCommand(commandId, action, payload),  // recover from prev errors
  )
  // Mantener la cadena pero swallow errors para no atorar comandos futuros
  commandChain = queued.catch(() => {})
  return queued
}

// ── Command dispatcher ──────────────────────────────────────────────────────

// v0.7.9: BACKUP guard al FSM. Pingea al content.js de cualquier tab LinkedIn
// activa y, si responde con `isExecuting` + currentPhase en estado typing-like,
// espera y reintenta hasta 30s antes de proceder. Esto cubre el caso edge en
// que el SW fue evicted mid-typing y `commandChain` se resetea (FSM session
// storage cubre la mayoría, pero ping es defensa-en-profundidad).
async function pingContentForTypingPhase(currentCommandId, maxWaitMs = 30000) {
  // v0.7.21 P2-6: removidos 'navigating' y 'hydrating' (referencias muertas).
  const TYPING_PHASES = new Set(['dispatched','thread_opened','typing','typed','send_clicked'])
  const startWait = Date.now()
  while (Date.now() - startWait < maxWaitMs) {
    const tabs = await chrome.tabs.query({ url: '*://*.linkedin.com/*' })
    if (!tabs || tabs.length === 0) return  // sin tab, no hay nada que esperar
    let busy = false
    for (const t of tabs) {
      try {
        const resp = await Promise.race([
          chrome.tabs.sendMessage(t.id, { type: 'orion_status_ping' }),
          new Promise(r => setTimeout(() => r(null), 500)),
        ])
        if (resp && resp.isExecuting && resp.currentCommandId !== currentCommandId) {
          // Si lleva >130s sin transitar, lo damos por stale (alineado con FSM).
          if ((resp.elapsedMs ?? 0) > 130_000) {
            console.warn(`[Orion v0.7.9] content.js stale (${resp.elapsedMs}ms) — proceder pese a isExecuting`)
            continue
          }
          console.log(`[Orion v0.7.9] content.js busy (cmd ${resp.currentCommandId?.slice(0,8)}, ${resp.elapsedMs}ms) — esperar 2s`)
          busy = true
          break
        }
      } catch { /* tab sin content.js o muerta; ignorar */ }
    }
    if (!busy) return
    await sleep(2000)
  }
  console.warn(`[Orion v0.7.9] pingContentForTypingPhase timeout ${maxWaitMs}ms — proceder defensive`)
}

async function executeCommand(commandId, action, payload) {
  console.log(`[Orion] Executing ${action} (cmd ${commandId})`, payload)

  try {
    // v0.7.0 FSM PHASE GUARD: el SW NO debe navegar la tab si content.js está
    // en una fase activa (dispatched/navigating/hydrating/thread_opened/typed/send_clicked).
    // Reemplaza el storage._executing mutex de v0.6.49 con una FSM completa.
    // El guard espera hasta que la fase pase a 'send_confirmed', 'done', 'error',
    // o el fase se vuelva stale (>130s).
    await waitForSafePhase(commandId)

    // v0.7.9 BACKUP GUARD: aún si el FSM dice safe, pingeamos al content.js
    // como defensa-en-profundidad para el caso SW respawn / commandChain perdida.
    await pingContentForTypingPhase(commandId, 30_000)

    // v0.10.0 resolve_companies: MULTI-navegación en un solo comando (N empresas por
    // comando, no N comandos). Cada empresa = 1 nav a /search/results/companies/ +
    // 1 extract. Sale del flujo normal (que es 1 nav + 1 sendMessage) por eso el
    // return temprano.
    if (action === 'resolve_companies') {
      const result = await resolveCompanies(commandId, payload ?? {})
      reportResult(commandId, action, result)
      return
    }

    // v0.10.4 — recarga remota. Copiar archivos nuevos NO actualiza nada: Chrome no
    // recarga una extensión descomprimida al cambiar el disco, hay que darle ↻ a mano en
    // cada máquina. Eso convirtió cada fix en una gestión con tres operadores y dejó
    // cuentas corriendo código viejo durante días. chrome.runtime.reload() hace justo lo
    // que el botón: reinicia el service worker con los archivos de disco y, ya en el
    // arranque nuevo, reloadLinkedInTabsOnVersionChange refresca las pestañas.
    // Reportamos ANTES de recargar, porque la recarga mata este contexto.
    if (action === 'reload_extension') {
      const version = chrome.runtime.getManifest().version
      reportResult(commandId, action, { action, status: 'ok', versionAntes: version })
      console.log(`[Orion] reload_extension recibido (v${version}) — recargando en 2s`)
      setTimeout(() => { try { chrome.runtime.reload() } catch (e) { console.error(e) } }, 2000)
      return
    }

    let tab
    // send_invite: navegar DIRECTO al SPA route /preload/custom-invite/?vanityName=
    // — LinkedIn abre el modal automáticamente. Evitamos el click problemático
    // del Conectar anchor (event.isTrusted filter de anti-bot).
    if (action === 'send_invite' && payload?.profileUrl) {
      const vanity = extractVanityFromUrl(payload.profileUrl)
      if (vanity) {
        const customInviteUrl = `https://www.linkedin.com/preload/custom-invite/?vanityName=${vanity}`
        console.log(`[Orion] send_invite via SPA route: ${customInviteUrl}`)
        tab = await navigateTabAndWait(customInviteUrl)
      } else {
        // Fallback: navegar al profile normal
        tab = await navigateTabAndWait(payload.profileUrl)
      }
    } else if (action === 'send_followup' && payload?.threadUrl) {
      // P1: NO navegar directo al thread URL — esa navegación deja la página de
      // thread a medias (solo nav bar, sin composer). En su lugar navegamos al
      // INBOX (/messaging/ carga confiablemente) y content.js CLICKEA la
      // conversación desde la lista (SPA in-app) → el composer monta bien.
      // El threadId va en payload para que content.js encuentre el item.
      tab = await navigateTabAndWait('https://www.linkedin.com/messaging/', 15000)
    } else if (action === 'send_followup' && payload?.profileUrl) {
      // Sub-Fase 3.8: lead conectado sin thread (invite sin nota).
      // Navegamos al perfil; content.js click "Mensaje" + compose-new-thread.
      console.log(`[Orion] send_followup compose-new via profile: ${payload.profileUrl}`)
      tab = await navigateTabAndWait(payload.profileUrl)
    } else if (action === 'search') {
      // Fase 2: cuentas marcadas Pro (search_mode='sales_navigator') buscan por la
      // interfaz de Sales Navigator; el resto sigue el buscador free. El branch es total:
      // si no es salesnav, comportamiento IDÉNTICO al de siempre (Wal intacto).
      const searchUrl = payload?.searchMode === 'sales_navigator'
        ? buildSalesNavSearchUrl(payload ?? {})
        : buildSearchUrl(payload ?? {})
      console.log(`[Orion] search (${payload?.searchMode ?? 'free'}) → ${searchUrl}`)
      tab = await navigateTabAndWait(searchUrl, 20000)
    } else if (action === 'search_posts') {
      const postSearchUrl = buildPostSearchUrl(payload ?? {})
      console.log(`[Orion] search_posts → ${postSearchUrl}`)
      tab = await navigateTabAndWait(postSearchUrl, 20000)
    } else if (action === 'comment_on_post' && payload?.postPermalink) {
      console.log(`[Orion] comment_on_post → ${payload.postPermalink}`)
      tab = await navigateTabAndWait(payload.postPermalink, 15000)
    } else if (action === 'check_inbox') {
      // Auto-navegar a /messaging/ si no estamos ya ahí (consistencia con
      // send_invite/send_followup). content.js requiere estar en /messaging/.
      const msgTabs = await chrome.tabs.query({ url: '*://*.linkedin.com/messaging/*' })
      if (msgTabs.length > 0) {
        tab = await reviveTabIfDiscarded(msgTabs[0])
      } else {
        tab = await navigateTabAndWait('https://www.linkedin.com/messaging/', 15000)
      }
    } else if (action === 'check_sent_invites') {
      tab = await navigateTabAndWait('https://www.linkedin.com/mynetwork/invitation-manager/sent/', 15000)
    } else if (action === 'check_connections') {
      tab = await navigateTabAndWait('https://www.linkedin.com/mynetwork/invite-connect/connections/', 15000)
    } else if (action === 'publish_post') {
      tab = await navigateTabAndWait('https://www.linkedin.com/feed/', 12000)
    } else {
      tab = await findOrCreateLinkedInTab(action)
    }

    // v0.7.42 ANTI-THROTTLE (la cura de raíz del background-throttle): enfocar la
    // tab durante la ejecución. Chrome throttlea setTimeout a ~1s (y a 1/min tras
    // 5min oculta = "intensive throttling") en tabs background → typing y wait-loops
    // se alargaban catastróficamente (FU typing 23s→125s, hangs, timeouts). En el
    // Chrome dedicado del VPS no hay usuario que molestar, y una tab enfocada
    // mientras "escribimos" es MÁS humana. Best-effort: si falla, el chunking sigue
    // como defensa secundaria.
    // ponytail: MONITOREO 06-ago-2026 — desactivado en las 3 cuentas para confirmar
    // en producción que Chrome ya no throttlea sin este hack (2/2 hard-tests limpios
    // en Wal: inmediato + 6min minimizado, sin typing_complete_timeout). Vigilar
    // /dashboard/quarantine y phase_insights por typing_complete_timeout nuevo.
    // Si aparece: revertir con `git revert` de este commit + recargar extensión.
    // try {
    //   await chrome.tabs.update(tab.id, { active: true })
    //   if (tab.windowId != null) {
    //     await chrome.windows.update(tab.windowId, { focused: true })
    //   }
    // } catch (e) {
    //   console.warn(`[Orion] anti-throttle focus falló (sigo igual): ${e?.message}`)
    // }

    console.log(`[Orion] Sending to tab id=${tab.id} url=${tab.url} status=${tab.status}`)
    // Tracking para el indicador visual "tab casada"
    lastCommandAt = Date.now()
    lastCommandAction = action
    boundTabId = tab.id
    // Avisar a la tab que está casada con Orion (para el marco/pill)
    try {
      chrome.tabs.sendMessage(tab.id, { type: 'orion_bound', action, ts: lastCommandAt }).catch(() => {})
    } catch {}
    let result = await sendMessageWithRetry(tab.id, {
      type:    'orion_command',
      commandId,
      action,
      payload,
    }, 6)  // hasta 6 reintentos con backoff (content.js puede tardar en inyectar)
    console.log(`[Orion] Tab response:`, result)

    // Sub-Fase 3.8 v0.6.5: si content.js devolvió needs_redirect (anchor SPA),
    // navegar al URL devuelto + re-dispatch (1 sola vez para evitar loops)
    if (result?.status === 'needs_redirect' && result?.redirectUrl) {
      const redirectUrl = result.redirectUrl
      const resolvedIn = result.resolvedInUrl  // v7-C: /in/ resuelto de un lead SalesNav (persistir)
      console.log(`[Orion] needs_redirect detected. Original btnHref: ${result.btnHref}`)
      console.log(`[Orion] Navegando a redirect: ${redirectUrl}`)
      try {
        tab = await navigateTabAndWait(redirectUrl, 18000)
        await sleep(3000)  // hidratación post-nav extra
        const postNavTab = await chrome.tabs.get(tab.id)
        console.log(`[Orion] Post-redirect tab url: ${postNavTab.url} (status=${postNavTab.status})`)
        result = await sendMessageWithRetry(tab.id, {
          type:    'orion_command',
          commandId,
          action,
          payload,
        }, 6)
        console.log(`[Orion] Tab response post-redirect:`, result)
        // Pasar el btnHref + post-nav URL al result para debug
        if (result && typeof result === 'object') {
          result._debugRedirect = { btnHref: redirectUrl, postNavUrl: postNavTab.url, resolvedInUrl: resolvedIn }
        }
      } catch (err) {
        console.error(`[Orion] Redirect retry failed: ${err.message}`)
        result = { ok: false, error: 'redirect_retry_failed: ' + err.message, redirectAttempted: redirectUrl }
      }
    }

    // Fire-and-forget capture si error es de selector DOM (no bloquea report)
    maybeCaptureFailure(commandId, action, result, tab?.id)
    reportResult(commandId, action, result)
  } catch (err) {
    console.error(`[Orion] Command failed:`, err.message ?? err)
    reportResult(commandId, action, { ok: false, error: err.message ?? String(err) })
  }
}

// Construye el URL de LinkedIn search results desde payload search.
// Payload: { keywords, location, secondDegreeOnly, minEmployees }
// Mapeo de strings de ubicación → geoUrn IDs de LinkedIn (fix 29-may-2026).
// LinkedIn no acepta texto libre de location; requiere IDs numéricos. Hardcodeamos
// las ciudades/países más comunes en campañas latam-hispano. Si la string no matchea,
// se descarta del URL (content.js hace post-filter por substring del location del perfil).
const GEO_URN_MAP = {
  // Países
  'mexico':    '103323778', 'méxico': '103323778',
  'colombia':  '100876405',
  'chile':     '104621616',
  'peru':      '102927786', 'perú': '102927786',
  'espana':    '105646813', 'españa': '105646813', 'spain': '105646813',
  'usa':       '103644278', 'united states': '103644278', 'estados unidos': '103644278',
  'argentina': '100446943',
  'brasil':    '106057199', 'brazil': '106057199',
  // Ciudades MX
  'mexico city':      '101463827', 'cdmx': '101463827', 'ciudad de mexico': '101463827', 'ciudad de méxico': '101463827',
  'monterrey':        '103642308',
  'guadalajara':      '102013974',
  'queretaro':        '105748037', 'querétaro': '105748037',
  'puebla':           '105394236',
  // Ciudades CO
  'bogota':           '101920260', 'bogotá': '101920260',
  'medellin':         '101732879', 'medellín': '101732879',
  // Ciudades CL
  'santiago':         '102408799',
  // Ciudades PE
  'lima':             '102495956',
  // Ciudades ES
  'madrid':           '105776773',
  'barcelona':        '100469829',
}

function locationsToGeoUrns(locs) {
  if (!Array.isArray(locs)) return []
  const ids = new Set()
  for (const raw of locs) {
    const key = (raw ?? '').toLowerCase().trim().replace(/\s+/g, ' ')
    const id = GEO_URN_MAP[key]
    if (id) ids.add(id)
  }
  return [...ids]
}

// v0.10.0 — resuelve N empresas (nombre → company URN + slug) en UN comando.
// Una empresa = 1 navegación a /search/results/companies/ + 1 extract en content.js.
// Batchear evita gastar un comando (y un gap de search) por empresa: una lista de 180
// empresas se resuelve en ~9 ticks en vez de ~76 días.
// v0.10.6 — "nombre núcleo": el nombre sin relleno corporativo. La lista del cliente
// trae los nombres como los dice la gente ("mondelez internacional") y LinkedIn indexa
// la página real con otro ("Mondelez International"), así que la búsqueda literal solo
// encuentra duplicadas regionales de 77 seguidores. Buscar "mondelez" a secas sí trae la
// corporativa. Solo se reintenta si el nombre núcleo DIFIERE del original.
const GENERIC_NAME_TOKENS = new Set([
  'internacional', 'international', 'mexico', 'mexicana', 'mexicano', 'latam',
  'grupo', 'group', 'holding', 'holdings', 'company', 'corporativo', 'corporation',
  'servicios', 'services', 'solutions', 'soluciones', 'industrias', 'industries',
  'comercial', 'global', 'sapi', 'srl', 'inc', 'ltd', 'llc', 'sade', 'de', 'cv',
])
const SMALL_PAGE_FOLLOWERS = 1000  // por debajo de esto, sospechamos página duplicada

function coreCompanyName(name) {
  const norm = String(name ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const kept = norm.split(/[^a-z0-9]+/).filter(t => t.length > 2 && !GENERIC_NAME_TOKENS.has(t))
  return kept.join(' ')
}

async function resolveCompanies(commandId, payload) {
  const companies = Array.isArray(payload.companies) ? payload.companies : []
  const resolved = []
  const searchUrlFor = (q) =>
    `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(q)}&origin=GLOBAL_SEARCH_HEADER`
  // El scoring del content script SIEMPRE usa el nombre original: solo cambia la query.
  const askContent = async (query, originalName) => {
    const tab = await navigateTabAndWait(searchUrlFor(query), 20000)
    return await sendMessageWithRetry(tab.id, {
      type: 'orion_command', commandId, action: 'resolve_company', payload: { name: originalName },
    }, 4)
  }
  // Igual que dentro de la página: el nombre decide SI la página cuenta, y entre las que
  // cuentan gana la más grande. Comparar por parecido de nombre haría que "mondelez
  // internacional" (la duplicada de 77 seguidores, 2 tokens) le ganara siempre a
  // "mondelez international" (la real de 3.4M, 1 token) — justo lo que se quiere evitar.
  const DISTINCTIVE_HIT = 10
  // v0.10.9: un resultado sin token distintivo NO es candidato, por más seguidores que
  // tenga. El reintento con nombre núcleo solo puede MEJORAR, nunca meter otra empresa.
  const better = (a, b) => {
    if (!a?.urn || (a?.nameScore ?? 0) < DISTINCTIVE_HIT) return false
    if (!b?.urn || (b?.nameScore ?? 0) < DISTINCTIVE_HIT) return true
    return (a?.followers ?? 0) > (b?.followers ?? 0)
  }

  for (const c of companies) {
    if (!c?.name) continue
    try {
      let r = await askContent(c.name, c.name)
      const core = coreCompanyName(c.name)
      if (core && core !== c.name.trim().toLowerCase() && (r?.followers ?? 0) < SMALL_PAGE_FOLLOWERS) {
        await sleep(1500)
        const r2 = await askContent(core, c.name)
        if (better(r2, r)) {
          console.log(`[Orion] "${c.name}": nombre núcleo "${core}" encontró mejor página (${r2?.followers} seguidores vs ${r?.followers})`)
          r = r2
        }
      }
      resolved.push({
        id: c.id, name: c.name,
        urn: r?.urn ?? null, slug: r?.slug ?? null,
        matched: !!r?.matched, error: r?.error ?? null,
        // v0.10.3 — pasar los campos de diagnóstico del content script. Sin esto el
        // agregador los tiraba y era imposible saber, desde la DB, si la pestaña corría
        // el resolver nuevo o por qué eligió una página: el probe del 2-ago salió
        // "sin followers" y parecía código viejo cuando el problema era este descarte.
        followers: r?.followers ?? null,
        nameScore: r?.nameScore ?? null,
        resultTitle: r?.resultTitle ?? null,
        contentVersion: r?.contentVersion ?? null,
        candidates: r?.candidates ?? null,
      })
      console.log(`[Orion] resolve_company "${c.name}" → urn=${r?.urn ?? '—'} slug=${r?.slug ?? '—'}`)
    } catch (err) {
      resolved.push({ id: c.id, name: c.name, urn: null, slug: null, matched: false, error: err.message ?? String(err) })
    }
    await sleep(2000 + Math.floor(Math.random() * 2500))  // ritmo humano entre navegaciones
  }
  return { action: 'resolve_companies', status: 'ok', resolved }
}

function buildSearchUrl(payload) {
  const base = 'https://www.linkedin.com/search/results/people/'
  const params = new URLSearchParams()
  if (payload.keywords) params.set('keywords', payload.keywords)
  params.set('origin', 'GLOBAL_SEARCH_HEADER')
  // 2do grado
  if (payload.secondDegreeOnly !== false) params.set('network', '["S"]')
  // Company size buckets
  const minE = payload.minEmployees
  if (minE && minE > 1) {
    const buckets = mapMinEmployeesToBuckets(minE)
    if (buckets?.length) params.set('companySize', JSON.stringify(buckets))
  }
  // v0.10.0 COMPANY-SCOPED: facet nativo currentCompany (id numérico de la organización).
  // Sustituye al hack de meter el nombre de la empresa dentro del keyword (match difuso,
  // ~10% de acierto medido). Con facet, el 100% de los resultados trabaja AHÍ.
  if (payload.companyUrn) {
    params.set('currentCompany', JSON.stringify([String(payload.companyUrn)]))
    params.set('origin', 'FACETED_SEARCH')  // el que usa la UI al aplicar filtros
  }
  // geoUrn array (fix 29-may-2026): mapea locations conocidas → IDs LinkedIn.
  // Si user pone "Mexico City, Monterrey, Chile" → params.geoUrn=["101463827","103642308","104621616"]
  // → LinkedIn filtra resultados a esas 3 ubicaciones server-side (eficiente).
  // Si ninguna location matchea (ej. "Mi pueblo"), no se pasa geoUrn → búsqueda global +
  // content.js post-filter por substring (menos eficiente pero universal).
  // Con empresa NO filtramos geografía: el diagrama pide la empresa "en todas las
  // regiones donde opera", y el geo rotado peleaba contra la empresa (caso real:
  // Nexteer Automotive Mexico + geoUrn=Estados Unidos → 0 resultados).
  const geoUrns = payload.companyUrn ? [] : locationsToGeoUrns(payload.locations)
  if (geoUrns.length) params.set('geoUrn', JSON.stringify(geoUrns))
  return `${base}?${params.toString()}`
}

// Fase 2 — Sales Navigator people search. La query de SalesNav es una estructura RQL
// codificada: /sales/search/people?query=(spellCorrectionEnabled:true,keywords:...).
// encodeURIComponent deja los ( ) literales y codifica : , y espacios → justo el formato
// que SalesNav espera. v1 = KEYWORDS-ONLY (robusto: siempre carga una búsqueda válida);
// el filtro de ubicación lo aplica content.js por post-filter (payload.locations), igual
// que el fallback del free. Los filtros nativos de SalesNav (REGION/seniority/etc.) se
// pueden añadir después, una vez confirmado que la base scrapea bien.
function buildSalesNavSearchUrl(payload) {
  const base = 'https://www.linkedin.com/sales/search/people'
  const kw = (payload.keywords || '').trim()
  const parts = ['spellCorrectionEnabled:true']
  if (kw) parts.push(`keywords:${kw}`)
  // v0.10.1 — filtro nativo de empresa en SalesNav. El buscador FREE solo muestra
  // gente dentro de tu red: en la cuenta Café 57, Mondelēz devolvía 4 personas en
  // total. SalesNav ve toda la empresa, que es justo lo que necesita el flujo de
  // "todos los puestos de esta empresa". Los ':' se codifican con encodeURIComponent
  // (SalesNav los espera así); los paréntesis quedan literales.
  if (payload.companyUrn) {
    parts.push(`filters:List((type:CURRENT_COMPANY,values:List((id:urn:li:organization:${payload.companyUrn},selectionType:INCLUDED))))`)
  }
  return `${base}?query=${encodeURIComponent(`(${parts.join(',')})`)}`
}

// Post-Prospecting (v0.9): URL de búsqueda de CONTENIDO (posts), no de personas.
// Surface: /search/results/content/?keywords=...&datePosted="past-week". Scroll
// infinito (content.js searchPosts no pagina). recency ∈ past-24h|past-week|past-month.
function buildPostSearchUrl(payload) {
  const base = 'https://www.linkedin.com/search/results/content/'
  const params = new URLSearchParams()
  if (payload.keywords) params.set('keywords', payload.keywords)
  params.set('origin', 'GLOBAL_SEARCH_HEADER')
  const recency = payload.recency ?? 'past-week'
  if (['past-24h', 'past-week', 'past-month'].includes(recency)) {
    params.set('datePosted', `"${recency}"`)
  }
  // Ordenar por más recientes (los pedidos de servicio decaen rápido).
  params.set('sortBy', '"date_posted"')
  return `${base}?${params.toString()}`
}

// LinkedIn companySize buckets: A=1-10, B=11-50, C=51-200, D=201-500, E=501-1000,
//                               F=1001-5000, G=5001-10000, H=10001+
function mapMinEmployeesToBuckets(n) {
  if (!n || n <= 1) return null
  const buckets = [
    { code: 'A', hi: 10 }, { code: 'B', hi: 50 }, { code: 'C', hi: 200 },
    { code: 'D', hi: 500 }, { code: 'E', hi: 1000 }, { code: 'F', hi: 5000 },
    { code: 'G', hi: 10000 }, { code: 'H', hi: Infinity },
  ]
  return buckets.filter(b => b.hi >= n).map(b => b.code)
}

// Extrae el vanity name de una URL de perfil LinkedIn
// https://www.linkedin.com/in/<vanity>/ → "<vanity>"
function extractVanityFromUrl(url) {
  try {
    const m = url.match(/\/in\/([^/?#]+)/)
    if (m) return m[1]  // ya viene URL-encoded, no decodificamos para preservar acentos
  } catch {}
  return null
}

async function findOrCreateLinkedInTab(action) {
  if (action === 'check_inbox') {
    const msgTabs = await chrome.tabs.query({ url: '*://*.linkedin.com/messaging/*' })
    if (msgTabs.length > 0) {
      console.log(`[Orion] Encontradas ${msgTabs.length} tab(s) en /messaging/`)
      return await reviveTabIfDiscarded(msgTabs[0])
    }
  }
  const tabs = await chrome.tabs.query({ url: '*://*.linkedin.com/*' })
  console.log(`[Orion] Tabs linkedin disponibles: ${tabs.length}`)
  if (tabs.length > 0) return await reviveTabIfDiscarded(tabs[0])
  console.log(`[Orion] Sin tabs LinkedIn — creando nueva`)
  // v0.7.22 BUG-B: chrome.tabs.create lanza "No current window" cuando NO hay
  // ninguna ventana Chrome abierta (todas cerradas en el VPS Xvfb). Era el 60%
  // failure rate de check_sent_invites. Fix: si tabs.create falla, crear ventana
  // primero con chrome.windows.create y reusar su primera tab.
  let newTab
  try {
    newTab = await chrome.tabs.create({ url: 'https://www.linkedin.com/feed/', active: false })
  } catch (err) {
    const msg = String(err?.message ?? err).toLowerCase()
    if (msg.includes('no current window') || msg.includes('no window')) {
      console.warn('[Orion] BUG-B: sin ventana Chrome — creando window nueva')
      const win = await chrome.windows.create({ url: 'https://www.linkedin.com/feed/', focused: false })
      newTab = win?.tabs?.[0]
      if (!newTab) throw new Error('chrome_windows_create_no_tab')
    } else {
      throw err
    }
  }
  await waitForTabComplete(newTab.id, 15000)
  await sleep(2000)
  await markNonDiscardable(newTab.id)
  return await chrome.tabs.get(newTab.id)
}

// Si la tab está descartada por Chrome (background mode aggressive memory mgmt),
// dispararla un reload y esperar a que recargue. Sin esto, content.js no responde
// porque la página no está cargada en memoria.
async function reviveTabIfDiscarded(tab) {
  if (!tab) return tab
  // Refresh tab info (puede ser stale)
  let t = await chrome.tabs.get(tab.id)
  if (t.discarded) {
    console.log(`[Orion] Tab ${t.id} descartada por Chrome — reloading antes de dispatch`)
    await chrome.tabs.reload(t.id)
    await waitForTabComplete(t.id, 20000)
    await sleep(2500)  // hidratación React
    t = await chrome.tabs.get(t.id)
  }
  await markNonDiscardable(t.id)
  return t
}

// Le dice a Chrome "esta tab NO la descartes" — Chrome la mantiene en memoria
// incluso en background mode. Honra la flag en >95% de los casos. No-op si ya
// está set.
async function markNonDiscardable(tabId) {
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false })
  } catch (err) {
    // Algunas versiones viejas de Chrome no soportan autoDiscardable
    console.warn(`[Orion] autoDiscardable=false falló (puede ser viejo Chrome): ${err.message}`)
  }
}

// Navega una tab LinkedIn a la URL dada y espera a que termine de cargar.
// Maneja varios edge cases: URL ya cargada, navegación SPA (sin status change),
// y timeout robusto.
async function navigateTabAndWait(targetUrl, timeoutMs = 15000) {
  const tabs = await chrome.tabs.query({ url: '*://*.linkedin.com/*' })
  let tab = tabs[0]
  if (!tab) {
    console.log(`[Orion] Sin tab LinkedIn — creando con ${targetUrl}`)
    // v0.7.26 BUG-B completar: chrome.tabs.create lanza "No current window" si NO
    // hay ninguna ventana Chrome abierta. Antes el fallback window-create solo
    // estaba en findOrCreateLinkedInTab → search/send_invite/check_sent_invites
    // (que usan navigateTabAndWait) seguían fallando con "No current window".
    try {
      tab = await chrome.tabs.create({ url: targetUrl, active: false })
    } catch (err) {
      const m = String(err?.message ?? err).toLowerCase()
      if (m.includes('no current window') || m.includes('no window')) {
        console.warn('[Orion] BUG-B navigateTabAndWait: sin ventana Chrome — creando window')
        const win = await chrome.windows.create({ url: targetUrl, focused: false })
        tab = win?.tabs?.[0]
        if (!tab) throw new Error('chrome_windows_create_no_tab')
      } else { throw err }
    }
    await waitForTabComplete(tab.id, timeoutMs)
    await sleep(2500)
    await markNonDiscardable(tab.id)
    return await chrome.tabs.get(tab.id)
  }

  // Revive si está descartada antes de cualquier cosa
  tab = await reviveTabIfDiscarded(tab)
  const tabId = tab.id

  // Si ya está en la URL exacta — solo refrescar para activar modal/handlers
  if (tab.url === targetUrl) {
    console.log(`[Orion] Tab ${tabId} ya en target URL — refrescando`)
    await chrome.tabs.reload(tabId)
    await waitForTabComplete(tabId, timeoutMs)
    await sleep(2000)
    return await chrome.tabs.get(tabId)
  }

  console.log(`[Orion] Navegando tab ${tabId}: ${tab.url} → ${targetUrl}`)

  // Update + esperar
  chrome.tabs.update(tabId, { url: targetUrl }).catch(err => console.warn('tabs.update err:', err.message))
  await waitForTabComplete(tabId, timeoutMs)
  await sleep(2500)  // hidratación React
  return await chrome.tabs.get(tabId)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── v0.7.4 VISUAL LEARNING — Screenshot capture + upload ────────────────────
async function handleVisualCapture(msg, sender) {
  const tabId = sender?.tab?.id
  if (!tabId) {
    console.warn('[Orion VL] no tab.id en sender')
    return
  }
  // 1. captureVisibleTab del active window de la tab del sender
  let dataUrl
  try {
    const tab = await chrome.tabs.get(tabId)
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png', quality: 80 })
  } catch (err) {
    console.warn('[Orion VL] captureVisibleTab fail:', err.message)
    return
  }
  if (!dataUrl) return
  console.log(`[Orion VL] screenshot capturada (${Math.round(dataUrl.length/1024)}KB), uploading...`)

  // 2. Recuperar config
  const stored = await chrome.storage.local.get(['orion_url', 'orion_api_key', 'active_account_id'])
  if (!stored.orion_url || !stored.orion_api_key || !stored.active_account_id) {
    console.warn('[Orion VL] sin config para upload')
    return
  }

  // 3. POST al bridge endpoint
  try {
    const r = await fetch(`${stored.orion_url}/api/visual-learning/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-orion-api-key': stored.orion_api_key,
      },
      body: JSON.stringify({
        accountId: stored.active_account_id,
        phaseName: msg.phaseName,
        source: msg.source,
        commandId: msg.commandId,
        urlAtCapture: msg.url,
        viewport: msg.viewport,
        domSnapshot: msg.domSnapshot,
        capturedAt: msg.capturedAt,
        screenshotDataUrl: dataUrl,
      }),
    })
    const j = await r.json().catch(() => ({}))
    if (r.ok) {
      console.log(`[Orion VL] ✅ ticket #${j.ticketId} creado para phase "${msg.phaseName}"`)
    } else {
      console.warn(`[Orion VL] upload error:`, j?.error ?? r.status)
    }
  } catch (err) {
    console.warn('[Orion VL] POST fail:', err.message)
  }
}

// Envía mensaje al content.js con retries — útil cuando recién navegamos y
// content.js todavía no se inyectó. Backoff: 1s → 2s → 3s.
async function sendMessageWithRetry(tabId, message, maxAttempts = 6) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, message)
      return result
    } catch (err) {
      // Errores transitorios MV3: content.js no inyectado, SW dormido, navegación
      // interrumpió async response. Todos retryables con backoff.
      const msg = String(err?.message ?? '').toLowerCase()
      const isTransient =
        msg.includes('receiving end does not exist') ||
        msg.includes('message port closed') ||
        msg.includes('message channel closed') ||
        msg.includes('extension context invalidated') ||
        msg.includes('could not establish connection')
      if (!isTransient || attempt === maxAttempts) {
        throw err
      }
      const delay = attempt * 1500  // 1.5s, 3s, 4.5s, 6s, 7.5s — total ~22s antes de fallar
      console.log(`[Orion] sendMessage attempt ${attempt}/${maxAttempts} transient err (${err.message?.slice(0, 60)}) — retry en ${delay}ms`)
      await sleep(delay)
    }
  }
}

// Espera a que la tab llegue a status=complete. Si ya está en complete y la URL
// no cambia más, resuelve rápido. Polling cada 500ms con timeout.
async function waitForTabComplete(tabId, timeoutMs) {
  const start = Date.now()
  let lastUrl = ''
  let stableCount = 0
  while (Date.now() - start < timeoutMs) {
    try {
      const t = await chrome.tabs.get(tabId)
      if (t.status === 'complete') {
        if (t.url === lastUrl) {
          stableCount++
          if (stableCount >= 2) return  // URL estable 1 sec → cargado
        } else {
          lastUrl = t.url ?? ''
          stableCount = 0
        }
      } else {
        stableCount = 0
      }
    } catch {}
    await sleep(500)
  }
  console.warn('[Orion] waitForTabComplete timeout — continuing anyway')
}

// Opción B — REPORTE DURABLE: antes, si el WS estaba caído al terminar el comando,
// el resultado se DESCARTABA en silencio (return temprano) → el bridge nunca se
// enteraba → cleanupExpired lo marcaba extension_did_not_respond aunque el comando
// SÍ se ejecutó (a veces enviando el mensaje al lead = fantasma). Ahora persistimos
// el resultado en chrome.storage.local y lo re-enviamos al reconectar (flushPendingResults).
const PENDING_RESULTS_KEY = 'orion_pending_results'

async function reportResult(commandId, action, result) {
  const payload = { type: 'command_result', commandId, action, result, ts: Date.now() }
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload))
      return
    } catch (err) {
      console.warn(`[Orion] reportResult send falló, persistiendo: ${err.message}`)
    }
  }
  await enqueuePendingResult(payload)
}

async function enqueuePendingResult(payload) {
  try {
    const store = await chrome.storage.local.get(PENDING_RESULTS_KEY)
    const arr = Array.isArray(store[PENDING_RESULTS_KEY]) ? store[PENDING_RESULTS_KEY] : []
    arr.push(payload)
    const capped = arr.slice(-50)  // cap defensivo si el WS muere largo rato
    await chrome.storage.local.set({ [PENDING_RESULTS_KEY]: capped })
    console.log(`[Orion] reportResult persistido (WS down) — ${capped.length} en cola`)
  } catch (err) {
    console.warn(`[Orion] enqueuePendingResult falló: ${err.message}`)
  }
}

async function flushPendingResults() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  try {
    const store = await chrome.storage.local.get(PENDING_RESULTS_KEY)
    const arr = Array.isArray(store[PENDING_RESULTS_KEY]) ? store[PENDING_RESULTS_KEY] : []
    if (!arr.length) return
    console.log(`[Orion] Flushing ${arr.length} resultado(s) pendiente(s) tras reconnect`)
    const remaining = []
    for (const payload of arr) {
      if (!ws || ws.readyState !== WebSocket.OPEN) { remaining.push(payload); continue }
      try {
        ws.send(JSON.stringify({ ...payload, flushed: true }))
      } catch {
        remaining.push(payload)  // reintento en el próximo reconnect (bridge es idempotente)
      }
    }
    await chrome.storage.local.set({ [PENDING_RESULTS_KEY]: remaining })
  } catch (err) {
    console.warn(`[Orion] flushPendingResults falló: ${err.message}`)
  }
}

// ── Failure capture: screenshot + DOM dump → /api/extension/capture-failure ─
//
// Cuando content.js retorna un error de selector DOM no encontrado, capturamos
// screenshot + metadata para que admin pueda etiquetar el selector correcto.
// Construye el dataset de auto-healing futuro (sin LLM aún, solo humano-etiquetado).
const CAPTURE_ERRORS = new Set([
  'send_button_not_found',
  'send_button_not_found_in_overlay',
  'profile_message_button_not_found',
  'thread_editor_not_found',
  'compose_editor_not_found_in_overlay',
  'thread_header_mismatch',
])

async function maybeCaptureFailure(commandId, action, result, tabId) {
  try {
    const err = result?.error
    if (!err || !CAPTURE_ERRORS.has(err)) return

    // 1. Storage: apiKey + accountId + orionUrl
    const { orion_url, orion_api_key, active_account_id } = await chrome.storage.local.get([
      STORAGE_KEYS.ORION_URL,
      STORAGE_KEYS.API_KEY,
      STORAGE_KEYS.ACTIVE_ACCOUNT_ID,
    ])
    if (!orion_url || !orion_api_key || !active_account_id) return

    // 2. Screenshot (best-effort). FIX: captureVisibleTab necesita el windowId
    // del tab de trabajo — sin él captura el tab activo de la ventana equivocada
    // y falla. JPEG q60 reduce el payload (~70% vs PNG) para Gemini Vision.
    let screenshotBase64 = null
    try {
      let windowId
      if (tabId != null) {
        const t = await chrome.tabs.get(tabId).catch(() => null)
        windowId = t?.windowId
        // Asegurar que nuestro tab sea el activo en su ventana (captureVisibleTab
        // siempre captura el ACTIVO). Activar es momentáneo y necesario para el shot.
        if (windowId != null && t && !t.active) {
          try { await chrome.tabs.update(tabId, { active: true }) } catch {}
          await sleep(300)
        }
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 60 })
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
        screenshotBase64 = dataUrl.split(',')[1]
      }
    } catch (err) {
      console.warn('[Orion] captureVisibleTab failed:', err?.message ?? err)
    }

    // 3. Build payload — incluye lo que result ya tiene para debug
    const payload = {
      accountId: active_account_id,
      apiKey:    orion_api_key,
      commandId,
      action,
      error:     err,
      reason:    result?.reason ?? null,
      url:       result?.url ?? result?.currentUrl ?? null,
      extVersion: chrome.runtime.getManifest().version,
      domSnippet: {
        debugButtons:   result?.debugButtons ?? null,
        debugEditables: result?.debugEditables ?? null,
        topCardBtns:    result?.topCardBtns ?? null,
        visibleBtns:    result?.visibleBtns ?? null,
        path:           result?.path ?? null,
      },
      screenshotBase64,
    }

    // 4. POST fire-and-forget — no bloqueamos reportResult
    fetch(`${orion_url}/api/extension/capture-failure`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'x-orion-api-key': orion_api_key,
      },
      body: JSON.stringify(payload),
    }).then(r => {
      if (!r.ok) console.warn('[Orion] capture-failure response:', r.status)
    }).catch(e => {
      console.warn('[Orion] capture-failure POST failed:', e?.message ?? e)
    })
  } catch (err) {
    console.warn('[Orion] maybeCaptureFailure outer error:', err?.message ?? err)
  }
}

// ── UI ──────────────────────────────────────────────────────────────────────

function updateBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text })
    chrome.action.setBadgeBackgroundColor({ color })
  } catch {}
}

// ── Keep-alive port desde content scripts (mantiene SW vivo) ────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keep-alive') {
    console.log('[Orion bg] keep-alive port conectado desde content')
    port.onMessage.addListener(() => {
      // Solo recibir mantiene el SW activo. No requiere lógica.
    })
    port.onDisconnect.addListener(() => {
      console.log('[Orion bg] keep-alive port desconectado')
    })
  }
})

// ── Listener para popup ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[Orion bg] onMessage received:', msg.type, 'from', sender.id ?? 'popup')
  // Opción B: content.js confirma RECEPCIÓN del comando (pre-ejecución).
  // Forward al bridge como command_ack → sella acked_at. Best-effort: si el WS
  // está caído el ack se pierde y el comando (si expira) quedará como
  // content_unreachable, que es la clasificación correcta en ese caso.
  if (msg.type === 'orion_cmd_ack') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'command_ack', commandId: msg.commandId, ts: msg.ts ?? Date.now() }))
      } catch {}
    }
    return false
  }
  // v0.7.0 FSM: forward phase updates al bridge para audit + resume
  if (msg.type === 'orion_phase_update') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: 'phase_update',
          commandId: msg.commandId,
          phase: msg.phase,
          ts: msg.ts,
          extra: msg.extra,
        }))
      } catch {}
    }
    return false  // no sendResponse necesario
  }
  // v0.7.4 VISUAL LEARNING: content.js pide screenshot del viewport + upload
  if (msg.type === 'orion_visual_capture') {
    handleVisualCapture(msg, sender).catch(err =>
      console.warn('[Orion] visual_capture error:', err?.message))
    return false  // async, no sendResponse
  }
  // v0.7.2 µ-PHASE: forward micro-phase updates al bridge (más granular que phase_update)
  if (msg.type === 'orion_micro_phase') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: 'micro_phase',
          commandId: msg.commandId,
          action: msg.action,
          entry: msg.entry,
        }))
      } catch {}
    }
    return false
  }
  if (msg.type === 'reconnect') {
    // Reconexión MANUAL = override explícito del usuario. Limpiar el lockout ANTES de reconectar:
    // antes el botón llamaba initIfConfigured() a secas, que respeta el lockout → era inútil
    // justo cuando más se necesita (durante un lockout). Ahora sí desbloquea.
    chrome.storage.local.remove('auth_lockout_until').then(() =>
      initIfConfigured().catch(err => console.error('[Orion bg] initIfConfigured failed:', err)))
    sendResponse({ ok: true })
    return true
  }
  if (msg.type === 'force_update_check') {
    // Popup pidió update check inmediato (en lugar de esperar 60min del alarm)
    checkForUpdate().catch(err => console.warn('[Orion bg] force update check failed:', err.message))
    sendResponse({ ok: true })
    return true
  }
  if (msg.type === 'get_status') {
    sendResponse({
      connected: ws && ws.readyState === WebSocket.OPEN,
      reconnectAttempts,
    })
    return true
  }
  // content.js consulta su estado de "casamiento" con Orion para el indicador visual
  if (msg.type === 'get_orion_status') {
    const wsConnected = !!(ws && ws.readyState === WebSocket.OPEN)
    const senderTabId = sender?.tab?.id ?? null
    sendResponse({
      wsConnected,
      isBoundTab: senderTabId != null && senderTabId === boundTabId,
      lastCommandAt,
      lastCommandAction,
      secsSinceCommand: lastCommandAt ? Math.round((Date.now() - lastCommandAt) / 1000) : null,
    })
    return true
  }
  if (msg.type === 'disconnect') {
    if (ws) { try { ws.close() } catch {} ws = null }
    chrome.storage.local.set({ [STORAGE_KEYS.CONNECTED]: false })
    sendResponse({ ok: true })
    return true
  }
  return false
})
