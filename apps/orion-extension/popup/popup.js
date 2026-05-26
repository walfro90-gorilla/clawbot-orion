// Popup script — UI v0.5.5: status mini-monitor + pause/resume + config collapse
console.log('[Orion popup] v0.5.5 loaded')

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
const $updateCmd     = document.getElementById('update-cmd')
const $updateCopy    = document.getElementById('update-copy')
const $currentInline = document.getElementById('current-version-inline')

// Render current version en el banner cuando aparezca
try {
  const cv = chrome.runtime.getManifest().version
  if ($currentInline) $currentInline.textContent = cv
} catch {}
const $errorBanner   = document.getElementById('error-banner')
const $errorTitle    = document.getElementById('error-title')
const $errorDetail   = document.getElementById('error-detail')
const $monitor       = document.getElementById('monitor')
const $mAccount      = document.getElementById('m-account')
const $mToday        = document.getElementById('m-today')
const $mQueue        = document.getElementById('m-queue')
const $mLast         = document.getElementById('m-last')
const $mConfig       = document.getElementById('m-config')
const $pauseBtn      = document.getElementById('pause-btn')
const $pauseIcon     = document.getElementById('pause-icon')
const $pauseText     = document.getElementById('pause-text')
const $configDetails = document.getElementById('config-details')
const $version       = document.getElementById('version')

let isPausedState = false

// Render version del manifest
try { $version.textContent = 'v' + chrome.runtime.getManifest().version } catch {}

// ── Stored values ─────────────────────────────────────────────────────────

async function loadStored() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.ORION_URL,
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.ACTIVE_ACCOUNT_ID,
  ])
  if (stored.orion_url)         $url.value     = stored.orion_url
  if (stored.orion_api_key)     $apiKey.value  = stored.orion_api_key
  if (stored.active_account_id) $account.value = stored.active_account_id
  // Si ya está configurado, colapsa el config panel
  if (stored.orion_url && stored.orion_api_key && stored.active_account_id) {
    $configDetails.removeAttribute('open')
  } else {
    $configDetails.setAttribute('open', '')
  }
}

// ── Connection status ─────────────────────────────────────────────────────

async function refreshStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'get_status' })
    if (status?.connected) {
      $statusDot.className = isPausedState
        ? 'status-dot status-paused'
        : 'status-dot status-connected'
      $statusText.textContent = isPausedState ? 'Conectado (pausado)' : 'Conectado'
      $disconnect.style.display = ''
      $connect.textContent = 'Reconectar'
      $pauseBtn.style.display = 'flex'
    } else if (status?.reconnectAttempts > 0) {
      $statusDot.className = 'status-dot status-connecting'
      $statusText.textContent = `Reconectando… (intento ${status.reconnectAttempts})`
      $disconnect.style.display = 'none'
      $pauseBtn.style.display = 'none'
      $monitor.style.display = 'none'
    } else {
      $statusDot.className = 'status-dot status-disconnected'
      $statusText.textContent = 'Sin conectar'
      $disconnect.style.display = 'none'
      $pauseBtn.style.display = 'none'
      $monitor.style.display = 'none'
    }
  } catch {
    $statusText.textContent = 'SW no responde — recarga extension'
  }
}

// ── Update check + banner ─────────────────────────────────────────────────

// Trigger un update-check inmediato al SW (no esperar 60min de chrome.alarms)
async function forceUpdateCheck() {
  try {
    await chrome.runtime.sendMessage({ type: 'force_update_check' })
  } catch {
    // SW puede estar dormido — el alarm de keep-alive lo despertará
  }
}

async function checkUpdateBanner() {
  const { update_available } = await chrome.storage.local.get('update_available')
  if (update_available?.version) {
    $updateVersion.textContent = `v${update_available.version}`
    const isWindows = navigator.userAgent.includes('Windows')
    const url = isWindows
      ? (update_available.installers?.windows ?? update_available.tarballUrl)
      : (update_available.installers?.unix ?? update_available.tarballUrl)
    // El installer se ejecuta vía PowerShell/bash, NO directo en browser.
    // Mostramos el comando one-liner para que el usuario lo copie y pegue.
    const cmd = isWindows
      ? `irm ${url} | iex`
      : `curl -fsSL ${url} | bash`
    $updateCmd.textContent = cmd
    $updateBanner.style.display = 'block'
  } else {
    $updateBanner.style.display = 'none'
  }
}

// Copy install command al clipboard
$updateCopy?.addEventListener('click', async () => {
  const cmd = $updateCmd.textContent
  if (!cmd) return
  try {
    await navigator.clipboard.writeText(cmd)
    const orig = $updateCopy.textContent
    $updateCopy.textContent = '✓ Copiado'
    setTimeout(() => { $updateCopy.textContent = orig }, 1500)
  } catch (err) {
    alert('No se pudo copiar. Selecciona el comando manual y Ctrl+C.')
  }
})

// ── Error banner ──────────────────────────────────────────────────────────

const ERROR_MESSAGES = {
  invalid_api_key: {
    title: 'API key inválida',
    detail: 'La key no coincide. Cópiala desde /dashboard/accounts, sin espacios, con prefix orion_sk_.',
  },
  auth_timeout: { title: 'Timeout de autenticación', detail: 'El server no respondió.' },
  auth_required: { title: 'Falta autenticación', detail: 'Reabre el popup.' },
  config_invalid_ambos_campos_cruzados: {
    title: 'Cruzaste API Key y Account ID',
    detail: 'Abre Configuración abajo: API Key debe empezar con orion_sk_; Account ID debe ser un UUID con guiones. Re-pega ambos desde /dashboard/accounts.',
  },
  config_invalid_apikey_no_empieza_con_orion_sk_: {
    title: 'API Key mal pegada',
    detail: 'No empieza con orion_sk_. Re-cópiala desde /dashboard/accounts (botón 📋 al lado de la key).',
  },
  config_invalid_account_id_no_es_uuid: {
    title: 'Account ID mal pegado',
    detail: 'Debe ser un UUID (8-4-4-4-12 con guiones). Cópialo desde /dashboard/accounts.',
  },
}

async function refreshErrorBanner() {
  const { last_auth_error } = await chrome.storage.local.get('last_auth_error')
  if (!last_auth_error?.error) {
    $errorBanner.style.display = 'none'
    return
  }
  if (Date.now() - (last_auth_error.ts ?? 0) > 5 * 60_000) {
    $errorBanner.style.display = 'none'
    return
  }
  const info = ERROR_MESSAGES[last_auth_error.error] ?? {
    title: 'Error de autenticación', detail: last_auth_error.error,
  }
  $errorTitle.textContent = info.title
  $errorDetail.textContent = info.detail
  $errorBanner.style.display = 'block'
}

// ── Account status from server (stats + pause flag) ──────────────────────

function timeAgo(iso) {
  if (!iso) return '—'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'hace ' + s + 's'
  if (s < 3600) return 'hace ' + Math.floor(s / 60) + ' min'
  if (s < 86400) return 'hace ' + Math.floor(s / 3600) + ' h'
  return 'hace ' + Math.floor(s / 86400) + ' d'
}

function actionLabel(action) {
  return ({
    send_invite: '📨 Invite',
    send_followup: '💬 Follow-up',
    check_inbox: '📥 Inbox',
    check_sent_invites: '🔄 Sent check',
    search: '🔍 Search',
  })[action] ?? action
}

async function refreshMonitor() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.ORION_URL, STORAGE_KEYS.API_KEY, STORAGE_KEYS.ACTIVE_ACCOUNT_ID,
  ])
  if (!stored.orion_url || !stored.orion_api_key || !stored.active_account_id) {
    $monitor.style.display = 'none'
    return
  }

  try {
    const r = await fetch(`${stored.orion_url}/api/extension/account-status?accountId=${stored.active_account_id}`, {
      headers: { 'x-orion-api-key': stored.orion_api_key },
      cache: 'no-store',
    })
    if (!r.ok) throw new Error('status_' + r.status)
    const data = await r.json()

    $mAccount.textContent = data.account?.label ?? '—'
    $mToday.textContent = `${data.today?.invites ?? 0} invites · ${data.today?.messages ?? 0} msgs`
    $mQueue.textContent = data.pendingCommands ?? 0

    const last = data.lastCommand
    if (last) {
      const resultIcon = last.result === 'sent' || last.result === 'ok' || last.result === 'dry_run_ok'
        ? '✓' : (last.result ? '✗' : '·')
      $mLast.textContent = `${resultIcon} ${actionLabel(last.action)} ${timeAgo(last.completedAt)}`
    } else {
      $mLast.textContent = 'sin actividad aún'
    }

    const warmupEmoji = { cold: '❄️', warming: '🌡️', warm: '☀️', hot: '🔥' }[data.account?.warmupStatus] ?? '·'
    const statusEmoji = data.bridgeOnline ? '🟢' : '🔴'
    $mConfig.innerHTML = `${warmupEmoji} ${data.account?.warmupStatus ?? '?'} · ${statusEmoji} bridge · cap ${data.account?.dailyCap ?? '—'}/día`

    // Update pause state
    isPausedState = !!data.account?.paused
    $pauseBtn.className = `pause-btn ${isPausedState ? 'active' : 'inactive'}`
    $pauseIcon.textContent = isPausedState ? '▶️' : '⏸️'
    $pauseText.textContent = isPausedState ? 'Reanudar actividad' : 'Pausar actividad'

    $monitor.style.display = 'block'
    // Re-render status dot color
    if (data.bridgeOnline) {
      $statusDot.className = isPausedState ? 'status-dot status-paused' : 'status-dot status-connected'
      $statusText.textContent = isPausedState ? 'Conectado (pausado)' : 'Conectado'
    }
  } catch (err) {
    // No mostrar errores en mini-monitor — solo lo ocultamos si falla
    $monitor.style.display = 'none'
  }
}

// ── Pause/Resume toggle ──────────────────────────────────────────────────

$pauseBtn.addEventListener('click', async () => {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.ORION_URL, STORAGE_KEYS.API_KEY, STORAGE_KEYS.ACTIVE_ACCOUNT_ID])
  if (!stored.orion_url || !stored.orion_api_key || !stored.active_account_id) return

  $pauseBtn.disabled = true
  try {
    const r = await fetch(`${stored.orion_url}/api/extension/pause-toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-orion-api-key': stored.orion_api_key },
      body: JSON.stringify({ accountId: stored.active_account_id, paused: !isPausedState }),
    })
    const data = await r.json()
    if (typeof data.paused === 'boolean') {
      isPausedState = data.paused
      await refreshMonitor()
    }
  } catch (err) {
    console.error('[Orion popup] pause toggle failed:', err)
  } finally {
    $pauseBtn.disabled = false
  }
})

// ── Connect action ───────────────────────────────────────────────────────

$connect.addEventListener('click', async () => {
  const orionUrl = $url.value.trim().replace(/\/+$/, '')
  const apiKey   = $apiKey.value.trim()
  const account  = $account.value.trim()

  if (!orionUrl || !apiKey || !account) {
    alert('Llena los 3 campos: URL, API Key, Cuenta')
    return
  }
  if (!apiKey.startsWith('orion_sk_')) {
    alert('API key inválida — debe empezar con orion_sk_. Cópiala desde /dashboard/accounts.')
    return
  }
  if (apiKey.length < 30) {
    alert(`API key incompleta (${apiKey.length} chars). Debería tener 41. Re-copia desde /dashboard/accounts.`)
    return
  }
  if (!/^[a-fA-F0-9_]+$/.test(apiKey.replace(/^orion_sk_/, ''))) {
    alert('API key tiene caracteres inválidos. Re-copia desde /dashboard/accounts.')
    return
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account)) {
    alert('Account ID inválido — debe ser un UUID. Copia desde /dashboard/accounts.')
    return
  }

  await chrome.storage.local.remove('last_auth_error')
  refreshErrorBanner()

  await chrome.storage.local.set({
    [STORAGE_KEYS.ORION_URL]:  orionUrl,
    [STORAGE_KEYS.API_KEY]:    apiKey,
    [STORAGE_KEYS.ACTIVE_ACCOUNT_ID]: account,
  })

  try {
    await chrome.runtime.sendMessage({ type: 'reconnect' })
  } catch (err) {
    console.error('[Orion popup] sendMessage failed:', err)
  }
  setTimeout(refreshStatus, 500)
  setTimeout(refreshMonitor, 1500)
})

$disconnect.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' })
  setTimeout(refreshStatus, 300)
})

// ── Init + polling ───────────────────────────────────────────────────────

loadStored()
  .then(refreshStatus)
  .then(forceUpdateCheck)      // ★ check de update INMEDIATO al abrir popup
  .then(checkUpdateBanner)
  .then(refreshErrorBanner)
  .then(refreshMonitor)

// Re-check update banner a los 3s para captar el resultado del forceUpdateCheck
setTimeout(checkUpdateBanner, 3000)

setInterval(refreshStatus, 2_000)
setInterval(refreshMonitor, 5_000)
setInterval(checkUpdateBanner, 30_000)
setInterval(refreshErrorBanner, 3_000)
