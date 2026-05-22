// Popup script — UI para configurar API key + cuenta + reconectar
console.log('[Orion popup] Script loaded v0.4.0 — con update banner')

const STORAGE_KEYS = {
  ORION_URL: 'orion_url',
  API_KEY:   'orion_api_key',
  ACTIVE_ACCOUNT_ID: 'active_account_id',
  CONNECTED: 'connected',
}

const $url      = document.getElementById('orion-url')
const $apiKey   = document.getElementById('api-key')
const $account  = document.getElementById('account-id')
const $connect  = document.getElementById('connect-btn')
const $disconnect = document.getElementById('disconnect-btn')
const $statusDot  = document.getElementById('status-dot')
const $statusText = document.getElementById('status-text')
const $updateBanner  = document.getElementById('update-banner')
const $updateVersion = document.getElementById('update-version')
const $updateLink    = document.getElementById('update-link')
const $errorBanner   = document.getElementById('error-banner')
const $errorTitle    = document.getElementById('error-title')
const $errorDetail   = document.getElementById('error-detail')

// ── Error banner ───────────────────────────────────────────────────────────

const ERROR_MESSAGES = {
  invalid_api_key: {
    title: 'API key inválida',
    detail: 'La key no coincide con la cuenta. Ve a /dashboard/accounts, click 📋 Copiar API key y pégala aquí (sin espacios, completa con el prefix orion_sk_).',
  },
  auth_timeout: {
    title: 'Timeout en autenticación',
    detail: 'El server no respondió a tiempo. Verifica la Orion URL y tu conexión.',
  },
  auth_required: {
    title: 'Falta autenticación',
    detail: 'La extension no completó el handshake. Reabre el popup.',
  },
}

async function refreshErrorBanner() {
  const { last_auth_error } = await chrome.storage.local.get('last_auth_error')
  if (!last_auth_error?.error) {
    $errorBanner.style.display = 'none'
    return
  }
  // Si pasaron más de 5 min, ocultar (probablemente ya fixed)
  if (Date.now() - (last_auth_error.ts ?? 0) > 5 * 60_000) {
    $errorBanner.style.display = 'none'
    return
  }
  const info = ERROR_MESSAGES[last_auth_error.error] ?? {
    title: 'Error de autenticación',
    detail: last_auth_error.error,
  }
  $errorTitle.textContent = info.title
  $errorDetail.textContent = info.detail
  $errorBanner.style.display = 'block'
}

// ── Update banner ──────────────────────────────────────────────────────────

async function checkUpdateBanner() {
  const { update_available } = await chrome.storage.local.get('update_available')
  if (update_available?.version) {
    $updateVersion.textContent = `v${update_available.version}`
    // Linkear al installer del OS detectado (si está disponible)
    const isWindows = navigator.userAgent.includes('Windows')
    const installerUrl = isWindows
      ? update_available.installers?.windows
      : update_available.installers?.unix
    $updateLink.href = installerUrl || update_available.tarballUrl
    $updateBanner.style.display = 'block'
  } else {
    $updateBanner.style.display = 'none'
  }
}

// ── Cargar valores guardados ───────────────────────────────────────────────

async function loadStored() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.ORION_URL,
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.ACTIVE_ACCOUNT_ID,
  ])
  if (stored.orion_url)         $url.value     = stored.orion_url
  if (stored.orion_api_key)     $apiKey.value  = stored.orion_api_key
  if (stored.active_account_id) $account.value = stored.active_account_id
}

// ── Status indicator ───────────────────────────────────────────────────────

async function refreshStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'get_status' })
    if (status?.connected) {
      $statusDot.className = 'status-dot status-connected'
      $statusText.textContent = 'Conectado'
      $disconnect.style.display = ''
      $connect.textContent = 'Reconectar'
    } else if (status?.reconnectAttempts > 0) {
      $statusDot.className = 'status-dot status-connecting'
      $statusText.textContent = `Reconectando… (intento ${status.reconnectAttempts})`
      $disconnect.style.display = 'none'
    } else {
      $statusDot.className = 'status-dot status-disconnected'
      $statusText.textContent = 'Sin conectar'
      $disconnect.style.display = 'none'
    }
  } catch (err) {
    $statusText.textContent = 'SW no responde — recarga extension'
  }
}

// ── Acciones ──────────────────────────────────────────────────────────────

$connect.addEventListener('click', async () => {
  console.log('[Orion popup] Connect button clicked')
  const orionUrl = $url.value.trim().replace(/\/+$/, '')  // strip trailing slash
  const apiKey   = $apiKey.value.trim()
  const account  = $account.value.trim()
  console.log('[Orion popup] Form values:', { orionUrl, hasApiKey: !!apiKey, account, apiKeyLen: apiKey.length })

  if (!orionUrl || !apiKey || !account) {
    alert('Llena los 3 campos: URL, API Key, Cuenta')
    return
  }

  // Validar formato API key antes de mandar al server
  if (!apiKey.startsWith('orion_sk_')) {
    alert('API key inválida — debe empezar con orion_sk_. Copia la key completa desde /dashboard/accounts.')
    return
  }
  if (apiKey.length < 30) {
    alert(`API key incompleta (${apiKey.length} chars). La key completa tiene 41 caracteres. Re-copia desde /dashboard/accounts.`)
    return
  }
  if (!/^[a-fA-F0-9_]+$/.test(apiKey.replace(/^orion_sk_/, ''))) {
    alert('API key tiene caracteres inválidos. Re-copia desde /dashboard/accounts sin agregar nada.')
    return
  }
  // UUID format check para account ID
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account)) {
    alert('Account ID inválido — debe ser un UUID. Copia desde /dashboard/accounts.')
    return
  }

  // Clear last error (estamos reintentando con nuevos datos)
  await chrome.storage.local.remove('last_auth_error')
  refreshErrorBanner()

  console.log('[Orion popup] Saving to storage...')
  await chrome.storage.local.set({
    [STORAGE_KEYS.ORION_URL]:  orionUrl,
    [STORAGE_KEYS.API_KEY]:    apiKey,
    [STORAGE_KEYS.ACTIVE_ACCOUNT_ID]: account,
  })
  console.log('[Orion popup] Storage saved, triggering reconnect...')

  // Trigger reconnect en background
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'reconnect' })
    console.log('[Orion popup] Reconnect response:', resp)
  } catch (err) {
    console.error('[Orion popup] sendMessage failed:', err)
  }
  setTimeout(refreshStatus, 500)
})

$disconnect.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' })
  setTimeout(refreshStatus, 300)
})

// ── Init ────────────────────────────────────────────────────────────────

loadStored().then(refreshStatus).then(checkUpdateBanner).then(refreshErrorBanner)
setInterval(refreshStatus, 2_000)
setInterval(checkUpdateBanner, 30_000)
setInterval(refreshErrorBanner, 3_000)
