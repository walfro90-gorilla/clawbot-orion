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
    } else if (action === 'send_followup' && payload?.profileUrl) {
      // Sub-Fase 3.8: lead conectado sin thread (invite sin nota).
      // Navegamos al perfil; content.js click "Mensaje" + compose-new-thread.
      console.log(`[Orion] send_followup compose-new via profile: ${payload.profileUrl}`)
      tab = await navigateTabAndWait(payload.profileUrl)
    } else if (action === 'search') {
      const searchUrl = buildSearchUrl(payload ?? {})
      console.log(`[Orion] search → ${searchUrl}`)
      tab = await navigateTabAndWait(searchUrl, 20000)
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
    } else {
      tab = await findOrCreateLinkedInTab(action)
    }

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
          result._debugRedirect = { btnHref: redirectUrl, postNavUrl: postNavTab.url }
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
      return await reviveTabIfDiscarded(msgTabs[0])
    }
  }
  const tabs = await chrome.tabs.query({ url: '*://*.linkedin.com/*' })
  console.log(`[Orion] Tabs linkedin disponibles: ${tabs.length}`)
  if (tabs.length > 0) return await reviveTabIfDiscarded(tabs[0])
  console.log(`[Orion] Sin tabs LinkedIn — creando nueva`)
  const newTab = await chrome.tabs.create({ url: 'https://www.linkedin.com/feed/', active: false })
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
    tab = await chrome.tabs.create({ url: targetUrl, active: false })
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

    // 2. Screenshot (best-effort; si falla, igual mandamos el DOM snippet)
    let screenshotBase64 = null
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' })
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
        screenshotBase64 = dataUrl.split(',')[1] // strip "data:image/png;base64,"
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
  if (msg.type === 'reconnect') {
    initIfConfigured().catch(err => console.error('[Orion bg] initIfConfigured failed:', err))
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
