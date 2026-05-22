// v0.3.0 — Sub-Fase 2.5: search command (buildSearchUrl + companySize buckets)
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

// Keep-alive via alarm (MV3 sleeps SW después de 30s idle)
chrome.alarms.create('keep-alive', { periodInMinutes: 0.25 })  // 15s
// Update check cada 60 min
chrome.alarms.create('update-check', { periodInMinutes: 60, delayInMinutes: 1 })

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keep-alive') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })) } catch {}
    } else {
      initIfConfigured()
    }
  }
  if (alarm.name === 'update-check') {
    checkForUpdate().catch(err => console.warn('[Orion] update check failed:', err.message))
  }
})

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
    } else {
      await chrome.storage.local.remove('update_available')
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
  connect(orion_url, orion_api_key, active_account_id)
}

function connect(orionUrl, apiKey, accountId) {
  // Guard: si ya estamos conectando, no creamos otra conexión paralela
  if (isConnecting) {
    console.log('[Orion] connect() saltado — isConnecting=true')
    return
  }
  // Guard: si ya hay una WS abierta o conectándose, no creamos otra
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    console.log('[Orion] connect() saltado — ws state =', ws.readyState)
    return
  }
  // Si había una vieja en estado raro, la cerramos
  if (ws) { try { ws.close() } catch {} ws = null }

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
  })

  ws.addEventListener('message', async (event) => {
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
      return
    case 'auth_error':
      console.error('[Orion] Auth failed:', msg.error)
      chrome.storage.local.set({
        [STORAGE_KEYS.CONNECTED]: false,
        last_auth_error: { error: msg.error, ts: Date.now() },
      })
      return
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }))
      return
    case 'pong':
      // ack del keep-alive
      return
    case 'command':
      await executeCommand(msg.commandId, msg.action, msg.payload)
      return
    default:
      console.warn('[Orion] Unknown msg type:', msg.type)
  }
}

// ── Command dispatcher ──────────────────────────────────────────────────────

async function executeCommand(commandId, action, payload) {
  console.log(`[Orion] Executing ${action} (cmd ${commandId})`, payload)

  try {
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
      tab = await navigateTabAndWait(payload.threadUrl)
    } else if (action === 'search') {
      const searchUrl = buildSearchUrl(payload ?? {})
      console.log(`[Orion] search → ${searchUrl}`)
      tab = await navigateTabAndWait(searchUrl, 20000)
    } else if (action === 'check_inbox') {
      // Auto-navegar a /messaging/ si no estamos ya ahí (consistencia con
      // send_invite/send_followup). content.js requiere estar en /messaging/.
      const msgTabs = await chrome.tabs.query({ url: '*://*.linkedin.com/messaging/*' })
      if (msgTabs.length > 0) {
        tab = msgTabs[0]
      } else {
        tab = await navigateTabAndWait('https://www.linkedin.com/messaging/', 15000)
      }
    } else {
      tab = await findOrCreateLinkedInTab(action)
    }

    console.log(`[Orion] Sending to tab id=${tab.id} url=${tab.url} status=${tab.status}`)
    const result = await sendMessageWithRetry(tab.id, {
      type:    'orion_command',
      commandId,
      action,
      payload,
    }, 6)  // hasta 6 reintentos con backoff (content.js puede tardar en inyectar)
    console.log(`[Orion] Tab response:`, result)
    reportResult(commandId, action, result)
  } catch (err) {
    console.error(`[Orion] Command failed:`, err.message ?? err)
    reportResult(commandId, action, { ok: false, error: err.message ?? String(err) })
  }
}

// Construye el URL de LinkedIn search results desde payload search.
// Payload: { keywords, location, secondDegreeOnly, minEmployees }
function buildSearchUrl(payload) {
  const base = 'https://www.linkedin.com/search/results/people/'
  const params = new URLSearchParams()
  const kw = [payload.keywords, payload.location].filter(Boolean).join(' ')
  if (kw) params.set('keywords', kw)
  params.set('origin', 'GLOBAL_SEARCH_HEADER')
  if (payload.secondDegreeOnly !== false) params.set('network', '["S"]')
  const minE = payload.minEmployees
  if (minE && minE > 1) {
    const buckets = mapMinEmployeesToBuckets(minE)
    if (buckets?.length) params.set('companySize', JSON.stringify(buckets))
  }
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
      return msgTabs[0]
    }
  }
  const tabs = await chrome.tabs.query({ url: '*://*.linkedin.com/*' })
  console.log(`[Orion] Tabs linkedin disponibles: ${tabs.length}`)
  if (tabs.length > 0) return tabs[0]
  console.log(`[Orion] Sin tabs LinkedIn — creando nueva`)
  return await chrome.tabs.create({ url: 'https://www.linkedin.com/feed/', active: false })
}

// Navega una tab LinkedIn a la URL dada y espera a que termine de cargar.
// Maneja varios edge cases: URL ya cargada, navegación SPA (sin status change),
// y timeout robusto.
async function navigateTabAndWait(targetUrl, timeoutMs = 15000) {
  const tabs = await chrome.tabs.query({ url: '*://*.linkedin.com/*' })
  let tab = tabs[0]
  if (!tab) {
    tab = await chrome.tabs.create({ url: targetUrl, active: false })
    await sleep(3000)  // espera básica para nueva tab
    return await chrome.tabs.get(tab.id)
  }

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

// Envía mensaje al content.js con retries — útil cuando recién navegamos y
// content.js todavía no se inyectó. Backoff: 1s → 2s → 3s.
async function sendMessageWithRetry(tabId, message, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, message)
      return result
    } catch (err) {
      const isReceiverErr = /receiving end does not exist|message port closed/i.test(err.message ?? '')
      if (!isReceiverErr || attempt === maxAttempts) {
        throw err
      }
      const delay = attempt * 1000
      console.log(`[Orion] sendMessage attempt ${attempt} falló (receiving end no existe) — reintentando en ${delay}ms`)
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

function reportResult(commandId, action, result) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({
    type:      'command_result',
    commandId,
    action,
    result,
    ts:        Date.now(),
  }))
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
  if (msg.type === 'reconnect') {
    initIfConfigured().catch(err => console.error('[Orion bg] initIfConfigured failed:', err))
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
  if (msg.type === 'disconnect') {
    if (ws) { try { ws.close() } catch {} ws = null }
    chrome.storage.local.set({ [STORAGE_KEYS.CONNECTED]: false })
    sendResponse({ ok: true })
    return true
  }
  return false
})
