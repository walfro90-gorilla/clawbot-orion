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

// v0.6.46 — Active process glowing badge config por action + kind
// Devuelve { icon, label, cssClass } para renderizar el badge en tiempo real.
function activeProcessConfig(action, kind) {
  switch (action) {
    case 'search':
      return { icon: '🔍', label: 'Buscando contactos nuevos', cssClass: 'act-search' }
    case 'send_invite':
      return { icon: '📨', label: 'Enviando invitación', cssClass: 'act-invite' }
    case 'check_inbox':
      return { icon: '📥', label: 'Revisando inbox', cssClass: 'act-inbox' }
    case 'check_sent_invites':
      return { icon: '🔄', label: 'Verificando invites aceptadas', cssClass: 'act-sent-check' }
    case 'send_followup':
      if (kind === 'reply') {
        return { icon: '💬', label: 'Respondiendo mensaje', cssClass: 'act-reply' }
      }
      return { icon: '📤', label: 'Enviando seguimiento', cssClass: 'act-followup' }
    default:
      return { icon: '⚡', label: action, cssClass: 'act-other' }
  }
}

const $activeProcess = document.getElementById('active-process')
const $apIcon   = document.getElementById('ap-icon')
const $apLabel  = document.getElementById('ap-label')
const $apTarget = document.getElementById('ap-target')
const $apStatus = document.getElementById('ap-status')

function renderActiveProcess(activeCommand) {
  if (!activeCommand) {
    $activeProcess.className = 'active-process'  // hides via .visible removal
    $activeProcess.classList.remove('visible')
    return
  }
  const { action, status, leadName, kind, dispatchedAt, createdAt } = activeCommand
  const cfg = activeProcessConfig(action, kind)
  $apIcon.textContent = cfg.icon
  $apLabel.textContent = cfg.label
  $apTarget.textContent = leadName ? `→ ${leadName}` : ''
  // Status pill: 'dispatched' (corriendo) o 'pending' (en cola)
  const sinceIso = dispatchedAt ?? createdAt
  $apStatus.textContent = status === 'dispatched'
    ? `en vuelo · ${timeAgo(sinceIso).replace('hace ','')}`
    : 'en cola'
  // Apply per-action color class + status modifier
  $activeProcess.className = `active-process visible ${cfg.cssClass} status-${status}`
}

// ── v0.7.7 — Next Actions panel ────────────────────────────────────────────
const $nextActions = document.getElementById('next-actions')
const $naPrimaryIcon = document.getElementById('na-primary-icon')
const $naPrimaryLabel = document.getElementById('na-primary-label')
const $naPrimaryCountdown = document.getElementById('na-primary-countdown')
const $naList = document.getElementById('na-list')
const $forceTickBtn = document.getElementById('force-tick-btn')

function fmtCountdown(ms) {
  if (ms <= 0) return 'ahora'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `en ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `en ${m}min`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `en ${h}h ${mm}min`
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false })
}

async function refreshNextActions() {
  if (!$nextActions) return
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.ORION_URL, STORAGE_KEYS.API_KEY, STORAGE_KEYS.ACTIVE_ACCOUNT_ID,
  ])
  if (!stored.orion_url || !stored.orion_api_key || !stored.active_account_id) {
    $nextActions.style.display = 'none'
    return
  }
  try {
    const r = await fetch(
      `${stored.orion_url}/api/extension/next-actions?accountId=${stored.active_account_id}`,
      { headers: { 'x-orion-api-key': stored.orion_api_key }, cache: 'no-store' }
    )
    if (!r.ok) throw new Error('status ' + r.status)
    const d = await r.json()
    $nextActions.style.display = 'block'

    if (d.next_any) {
      const icon = d.next_any.label?.split(' ')[0] ?? '⏳'
      const labelText = d.next_any.label?.split(' ').slice(1).join(' ') ?? d.next_any.type
      $naPrimaryIcon.textContent = icon
      $naPrimaryLabel.textContent = labelText
      $naPrimaryCountdown.textContent = `${fmtCountdown(d.next_any.at - d.now)} (${fmtTime(d.next_any.at)})`
    } else {
      $naPrimaryIcon.textContent = '✅'
      $naPrimaryLabel.textContent = 'Sin acciones programadas'
      $naPrimaryCountdown.textContent = '—'
    }
    // Lista secundaria
    $naList.innerHTML = ''
    for (const upcoming of (d.sorted_upcoming ?? []).slice(1, 4)) {
      const li = document.createElement('li')
      li.innerHTML = `<span>${upcoming.label}</span><span class="when">${fmtCountdown(upcoming.at - d.now)}</span>`
      $naList.appendChild(li)
    }
    if (d.pending_replies > 0) {
      const li = document.createElement('li')
      li.innerHTML = `<span style="color:#fbbf24">💬 ${d.pending_replies} replies aguardando delay</span><span class="when">~</span>`
      $naList.appendChild(li)
    }
  } catch (err) {
    // silently hide on error
  }
}

if ($forceTickBtn) {
  $forceTickBtn.addEventListener('click', async () => {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.ORION_URL, STORAGE_KEYS.API_KEY, STORAGE_KEYS.ACTIVE_ACCOUNT_ID,
    ])
    if (!stored.orion_url || !stored.orion_api_key || !stored.active_account_id) return
    $forceTickBtn.disabled = true
    $forceTickBtn.textContent = '⚡ Disparando…'
    try {
      const r = await fetch(`${stored.orion_url}/api/extension/force-tick`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-orion-api-key': stored.orion_api_key,
        },
        body: JSON.stringify({ accountId: stored.active_account_id, action: 'check_inbox' }),
      })
      const d = await r.json()
      $forceTickBtn.textContent = r.ok ? `✓ Dispatched #${(d.cmd_id || '').slice(0,8)}` : `✗ ${d.error}`
    } catch (e) {
      $forceTickBtn.textContent = '✗ Error'
    }
    setTimeout(() => {
      $forceTickBtn.disabled = false
      $forceTickBtn.textContent = '⚡ Forzar inbox check ahora'
    }, 3000)
  })
}

// Initial fetch
refreshNextActions()

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

    // v0.6.46 — render glowing badge del proceso activo (en vuelo o en cola)
    renderActiveProcess(data.activeCommand)

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
    renderActiveProcess(null)
  }
}

// ── Connectivity panel (24h) ───────────────────────────────────────────────

const $connPanel = document.getElementById('connectivity-panel')
const $connBar   = document.getElementById('conn-bar')
const $connPct   = document.getElementById('conn-uptime-pct')
const $connLast  = document.getElementById('conn-last-up')
const $connWarn  = document.getElementById('conn-unstable-warning')
const $connDisc  = document.getElementById('conn-disc-count')
const $connBgCopy = document.getElementById('conn-bg-copy')

// Copiar chrome://settings/system al clipboard (no se puede abrir por link, Chrome lo bloquea)
if ($connBgCopy) {
  $connBgCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText('chrome://settings/system')
      $connBgCopy.textContent = '✓ Copiado'
      setTimeout(() => { $connBgCopy.textContent = 'Copiar' }, 2000)
    } catch {}
  })
}

async function refreshConnectivity() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.ORION_URL, STORAGE_KEYS.API_KEY, STORAGE_KEYS.ACTIVE_ACCOUNT_ID,
  ])
  if (!stored.orion_url || !stored.orion_api_key || !stored.active_account_id) {
    if ($connPanel) $connPanel.style.display = 'none'
    return
  }
  try {
    const r = await fetch(`${stored.orion_url}/api/extension/connectivity?accountId=${stored.active_account_id}`, {
      headers: { 'x-orion-api-key': stored.orion_api_key },
      cache: 'no-store',
    })
    if (!r.ok) throw new Error('conn_' + r.status)
    const data = await r.json()
    if (!$connPanel) return

    // Render 24 mini-bars
    const colors = { up: '#22c55e', down: '#ef4444', unknown: '#374151' }
    $connBar.innerHTML = (data.buckets ?? []).map(b =>
      `<div title="${b}" style="flex:1; background:${colors[b] ?? '#374151'};"></div>`
    ).join('')

    $connPct.textContent = data.uptimePct != null ? `${data.uptimePct}% uptime` : 'sin datos'
    if (data.lastConnect) {
      $connLast.textContent = timeAgo(data.lastConnect)
    } else {
      $connLast.textContent = 'sin registro'
    }
    // Warning de inestabilidad (background mode off probable)
    if ($connWarn) {
      if (data.unstable) {
        if ($connDisc) $connDisc.textContent = data.disconnects24h ?? '?'
        $connWarn.style.display = 'block'
      } else {
        $connWarn.style.display = 'none'
      }
    }
    $connPanel.style.display = 'block'
  } catch (err) {
    if ($connPanel) $connPanel.style.display = 'none'
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
setInterval(refreshMonitor, 2_500)  // v0.6.46: más rápido para que badge se sienta live
setInterval(refreshNextActions, 15_000)  // v0.7.7: countdown update cada 15s
setInterval(refreshConnectivity, 60_000)  // cada 1min
refreshConnectivity()
setInterval(checkUpdateBanner, 30_000)
setInterval(refreshErrorBanner, 3_000)
