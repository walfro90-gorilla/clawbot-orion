// ─────────────────────────────────────────────────────────────────────────────
// Orion Sync — Content Script
//
// Inyectado en cada página de linkedin.com. Su trabajo:
//   1. Escuchar comandos del background service worker
//   2. Ejecutar la acción DOM correspondiente (click connect, fill note, etc.)
//   3. Reportar resultado al background
//
// Importante: este script vive en el mundo "isolated" del content script.
// No tiene acceso directo a `window` de la página. Para interactuar con
// scripts de LinkedIn (ej. para leer Voyager API), usaríamos chrome.scripting.
// ─────────────────────────────────────────────────────────────────────────────

console.log('[Orion content] v0.6.0 loaded on', window.location.href)

// ── Keep-alive port para que el service worker no se duerma ─────────────────
// MV3 mata el SW después de 30s idle. Mientras esta página de LinkedIn esté
// abierta, mantenemos un Port conectado que evita que el SW muera. Cuando
// cierres la tab, el SW puede dormir (sin actividad).
let keepAlivePort = null
let keepAliveDead = false  // true si el extension context fue invalidado — STOP retry

function startKeepAlive() {
  if (keepAliveDead) return  // contexto muerto — no reintentamos infinitamente
  try {
    keepAlivePort = chrome.runtime.connect({ name: 'keep-alive' })
    keepAlivePort.onDisconnect.addListener(() => {
      // Si chrome.runtime.lastError dice "Extension context invalidated",
      // significa que la extension fue recargada / actualizada. El content.js
      // de esta tab está huérfano. STOP retry — la tab necesita F5.
      const err = chrome.runtime.lastError?.message ?? ''
      if (/extension context invalidated|extension context was invalidated/i.test(err)) {
        console.warn('[Orion content] Extension context invalidated — orphaned. Reload tab (F5) to reconnect.')
        keepAliveDead = true
        return
      }
      console.log('[Orion content] keep-alive port disconnected — reconnecting in 1s')
      keepAlivePort = null
      setTimeout(startKeepAlive, 1000)
    })
    // Ping periódico para mantener actividad
    setInterval(() => {
      if (keepAliveDead) return
      try { keepAlivePort?.postMessage({ type: 'ping', ts: Date.now() }) } catch {}
    }, 10_000)
    console.log('[Orion content] keep-alive port activo')
  } catch (err) {
    // chrome.runtime.connect lanza si extension context invalidated
    if (/extension context invalidated|extension context was invalidated/i.test(err.message ?? '')) {
      console.warn('[Orion content] Extension context invalidated en startKeepAlive — STOP retry. Reload tab (F5).')
      keepAliveDead = true
      return
    }
    console.warn('[Orion content] keep-alive failed:', err.message)
    setTimeout(startKeepAlive, 2000)
  }
}
startKeepAlive()

// ── Indicador visual "tab casada con Orion" ─────────────────────────────────
// Muestra al usuario que Orion Sync está viendo/usando esta pestaña de LinkedIn:
//   • Marco de color alrededor de la página (verde=conectado, ámbar=idle, rojo=offline)
//   • Pill flotante esquina inferior-derecha con estado + última acción
//   • Punto de color en el favicon (visible en la barra de pestañas)
//   • Prefijo en el título de la pestaña
let _orionFrame = null
let _orionPill = null
let _origTitle = null

function ensureOrionIndicatorDOM() {
  if (_orionFrame && document.documentElement.contains(_orionFrame)) return
  _orionFrame = document.createElement('div')
  _orionFrame.id = 'orion-sync-frame'
  _orionFrame.style.cssText = [
    'position:fixed', 'inset:0', 'pointer-events:none', 'z-index:2147483646',
    'box-shadow:inset 0 0 0 3px rgba(34,197,94,0)', 'transition:box-shadow 0.4s ease',
  ].join(';')
  document.documentElement.appendChild(_orionFrame)

  _orionPill = document.createElement('div')
  _orionPill.id = 'orion-sync-pill'
  _orionPill.style.cssText = [
    'position:fixed', 'bottom:16px', 'right:16px', 'z-index:2147483647',
    'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
    'font-size:12px', 'font-weight:600', 'padding:7px 12px', 'border-radius:20px',
    'display:flex', 'align-items:center', 'gap:7px',
    'box-shadow:0 4px 14px rgba(0,0,0,0.3)', 'transition:opacity 0.3s ease',
    'backdrop-filter:blur(8px)', 'user-select:none',
  ].join(';')
  _orionPill.addEventListener('mouseenter', () => { _orionPill.style.opacity = '0.3' })
  _orionPill.addEventListener('mouseleave', () => { _orionPill.style.opacity = '1' })
  document.documentElement.appendChild(_orionPill)

  if (!document.getElementById('orion-pulse-style')) {
    const st = document.createElement('style')
    st.id = 'orion-pulse-style'
    st.textContent = '@keyframes orionPulse{0%,100%{opacity:1}50%{opacity:0.35}}'
    document.documentElement.appendChild(st)
  }
}

function setOrionFaviconDot(color) {
  try {
    const size = 32
    const canvas = document.createElement('canvas')
    canvas.width = size; canvas.height = size
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#0a66c2'
    ctx.fillRect(0, 0, size, size)
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 20px Arial'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('in', size / 2, size / 2 + 1)
    ctx.beginPath()
    ctx.arc(size - 7, 7, 6, 0, 2 * Math.PI)
    ctx.fillStyle = color; ctx.fill()
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#0a0e1a'; ctx.stroke()
    let link = document.querySelector('link#orion-favicon')
    if (!link) {
      link = document.createElement('link')
      link.id = 'orion-favicon'; link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.href = canvas.toDataURL('image/png')
  } catch {}
}

function actionShort(a) {
  return ({
    send_followup: 'enviando mensaje', send_invite: 'invitando',
    check_inbox: 'leyendo inbox', check_sent_invites: 'verificando',
    check_connections: 'verificando conexiones',
    search: 'buscando leads',
  })[a] ?? 'trabajando'
}

function updateOrionIndicator(state) {
  if (!document.body) return
  ensureOrionIndicatorDOM()
  let color, label, frameColor
  if (!state.wsConnected) {
    color = '#ef4444'; frameColor = 'rgba(239,68,68,0.55)'; label = 'Orion offline'
  } else if (state.secsSinceCommand != null && state.secsSinceCommand < 90) {
    color = '#22c55e'; frameColor = 'rgba(34,197,94,0.85)'; label = `Orion activo · ${actionShort(state.lastCommandAction)}`
  } else {
    color = '#22c55e'; frameColor = 'rgba(34,197,94,0.30)'; label = 'Orion conectado'
  }
  _orionFrame.style.boxShadow = `inset 0 0 0 3px ${frameColor}`
  _orionPill.style.background = state.wsConnected ? 'rgba(10,14,26,0.92)' : 'rgba(60,10,10,0.92)'
  _orionPill.style.color = '#e5e7eb'
  _orionPill.style.border = `1px solid ${color}66`
  const pulse = (state.secsSinceCommand != null && state.secsSinceCommand < 90)
  _orionPill.innerHTML =
    `<span style="width:8px;height:8px;border-radius:50%;background:${color};box-shadow:0 0 6px ${color};${pulse ? 'animation:orionPulse 1.2s infinite;' : ''}"></span>` +
    `<span>${label}</span>`
  setOrionFaviconDot(color)
  // Título: strip robusto de CUALQUIER prefijo de estado previo (emojis multi-byte
  // + diamantes/círculos + surrogate halves huérfanos + espacios) usando flag `u`.
  // Sin esto, la clase [🟢🟡🔴] sin `u` no matchea y los emojis se ACUMULAN.
  const emoji = state.wsConnected ? '🟢' : '🔴'
  const cleanTitle = document.title.replace(ORION_TITLE_PREFIX_RE, '')
  const nextTitle = `${emoji} ${cleanTitle}`
  if (document.title !== nextTitle) document.title = nextTitle
}

// Strip: whitespace + 🟢(1F7E2) 🟡(1F7E1) 🔴(1F534) + ◆(25C6) ●(25CF) + replacement(FFFD)
const ORION_TITLE_PREFIX_RE = /^[\s\u{1F7E2}\u{1F7E1}\u{1F534}◆●�]+/u

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'orion_bound') {
    updateOrionIndicator({ wsConnected: true, isBoundTab: true, secsSinceCommand: 0, lastCommandAction: msg.action })
  }
})

async function pollOrionStatus() {
  if (keepAliveDead) {
    try { updateOrionIndicator({ wsConnected: false, isBoundTab: false, secsSinceCommand: null }) } catch {}
    return
  }
  try {
    const status = await chrome.runtime.sendMessage({ type: 'get_orion_status' })
    if (status) updateOrionIndicator(status)
  } catch {}
}
function startOrionIndicator() {
  if (!document.body) { setTimeout(startOrionIndicator, 500); return }
  pollOrionStatus()
  setInterval(pollOrionStatus, 5000)
}
startOrionIndicator()

// ── Listener de comandos del background ─────────────────────────────────────

// MUTEX: solo UN comando puede ejecutarse a la vez en este tab. Sin esto, si
// llegan 2 orion_command concurrentes (duplicado, re-dispatch post-redirect),
// dos loops de humanType escriben en el MISMO editor alternando caracteres →
// mensaje entrelazado ("HHoollaa"). El segundo comando se rechaza para que el
// bridge lo reintente limpio cuando el primero termine.
let _isExecuting = false
let _executingSince = 0
let _currentCommandId = null  // v0.6.46: para detectar re-dispatch del mismo cmd

// v0.7.1: hard timeout DINÁMICO basado en msg.length (era 120s fijo, insuficiente
// para mensajes >400 chars que humanType toma ~80-100s + 30s overhead = >120s).
// Now: msg.length * 200ms + 60s base, min 60s, max 240s.
const EXEC_HARD_TIMEOUT_MIN_MS = 90_000
const EXEC_HARD_TIMEOUT_MAX_MS = 480_000  // 8 min para messages muy largos
const EXEC_HARD_TIMEOUT_MS = 120_000  // fallback para acciones sin payload.message

function calcHardTimeout(action, payload) {
  if (action === 'publish_post') {
    const len = payload?.postText?.length ?? 0
    return Math.max(EXEC_HARD_TIMEOUT_MIN_MS, Math.min(EXEC_HARD_TIMEOUT_MAX_MS, len * 550 + 90_000))
  }
  if (action === 'send_followup' || action === 'send_invite') {
    const msgLen = (payload?.message?.length ?? 0)
    // v0.7.22 BUG-M: sin mensaje (Path A.1 no-note / send_followup vacío) → floor 90s.
    if (!payload?.message) return EXEC_HARD_TIMEOUT_MIN_MS
    // v0.7.22 BUG-M: CON mensaje, el modelo previo (400ms/char + 90s) subestimaba
    // Path A.2 (con nota) y send_followup Path B en horas pesadas CDMX (10-11h, 18-19h).
    // Realidad MEDIDA: ~1000ms/char (jitter v0.7.21 pct=0.70) + 60-100s navigate overhead.
    // Caso Miguel (147 chars): exec real 189.8s vs budget viejo 148.8s → timeout.
    // Nuevo modelo: 550ms/char + 120s base. Para 147 chars → 200.85s (margen 11s).
    const dynamic = msgLen * 550 + 120_000
    return Math.max(EXEC_HARD_TIMEOUT_MIN_MS, Math.min(EXEC_HARD_TIMEOUT_MAX_MS, dynamic))
  }
  // v0.7.19: check_inbox dinámico — captureThreads + maxCaptures dominan tiempo.
  // v0.7.22 BUG-E: 7s/capture era muy ajustado (177s budget vs 164s real, margen 13s).
  // Algunos captures gastan 8-10s (URL bounce + DOM hydration React). Subir a 9s/capture.
  if (action === 'check_inbox') {
    const captures = payload?.captureThreads ? (payload?.maxCaptures ?? 12) : 0
    const limit = payload?.limit ?? 20
    const dynamic = 60_000 + (captures * 9_000) + (Math.ceil(limit / 10) * 4_000)
    return Math.max(60_000, Math.min(300_000, dynamic))
  }
  return 120_000
}

// v0.7.1: bypass del modal nativo "Leave site?" del navegador cuando Orion está
// navegando intencionalmente. LinkedIn registra beforeunload handlers que disparan
// el modal cuando hay texto sin guardar en el editor. Cuando el SW navega (via
// chrome.tabs.update), Chrome lanza el modal y bloquea la navegación. Setear
// __orionExpectedNav antes de cualquier nav intencional permite que el unload
// proceda silencioso.
;(function setupBeforeUnloadBypass() {
  const orig = window.addEventListener
  window.addEventListener = function(type, listener, options) {
    if (type === 'beforeunload' && typeof listener === 'function') {
      const wrapped = function(e) {
        if (window.__orionExpectedNav) {
          try { e.returnValue = '' } catch {}
          try { e.preventDefault?.() } catch {}
          return undefined
        }
        return listener.call(this, e)
      }
      return orig.call(this, type, wrapped, options)
    }
    return orig.call(this, type, listener, options)
  }
})()

// ── v0.7.9 LinkedIn Discard-Modal Auto-Canceller ──────────────────────────
// El modal NATIVO de LinkedIn (NO el de Chrome) que aparece cuando hay draft
// + intento de route-change: "¿Salir? ¿Seguro que quieres eliminar este
// mensaje?" con botones Cancelar / Descartar (focus default en Descartar).
// Si el Enter del flow o el timeout natural lo consume → draft perdido + send
// nunca se ejecuta. Solución: MutationObserver permanente que detecta el
// modal por TEXTO (no por selector — LinkedIn cambia clases con frecuencia)
// y clickea "Cancelar" automáticamente (NUNCA "Descartar"). Solo activo si
// Orion espera navegación O está ejecutando comando (evita falsos positivos
// en discard modals legítimos del usuario humano).
const ORION_DISCARD_REGEX = /(descartar|discard).*(mensaje|message|draft)|salir.*mensaje|leave.*message|delete.*draft|eliminar.*mensaje/i
const ORION_CANCEL_REGEX = /^(cancelar|cancel|seguir editando|keep editing|continue editing)$/i

function orionDetectDiscardModal() {
  // Solo actuamos si Orion está en medio de un comando o esperando nav.
  if (!window.__orionExpectedNav && !window._orionIsExecuting) return false
  const dialogs = document.querySelectorAll('[role="dialog"], .artdeco-modal')
  for (const dlg of dialogs) {
    if (dlg.offsetParent === null) continue
    const txt = (dlg.textContent || '').slice(0, 600)
    if (!ORION_DISCARD_REGEX.test(txt)) continue
    // Encontrado: buscar el botón "Cancelar" / "Seguir editando" — NUNCA Descartar.
    const btns = Array.from(dlg.querySelectorAll('button, [role="button"]'))
    const cancelBtn = btns.find(b => {
      if (b.offsetParent === null) return false
      const t = (b.textContent || '').trim()
      const aria = (b.getAttribute('aria-label') || '').trim()
      return ORION_CANCEL_REGEX.test(t) || ORION_CANCEL_REGEX.test(aria)
    })
    if (cancelBtn) {
      console.warn('[Orion v0.7.9] ⚠️  LinkedIn discard-modal detectado — auto-click Cancelar para preservar draft')
      try { cancelBtn.click() } catch (e) { console.warn('[Orion v0.7.9] click Cancelar falló:', e?.message) }
      // Telemetría: trigger Visual Learning tracker (3× en 1h → captura)
      try { vlOnPhaseTimeout && vlOnPhaseTimeout('linkedin_discard_modal_intercepted') } catch {}
      return true
    } else {
      // No hay Cancelar visible — al menos NO dejar que Enter caiga en Descartar.
      // Cerrar via ESC (LinkedIn lo trata como Cancel en su artdeco-modal).
      console.warn('[Orion v0.7.9] ⚠️  discard-modal sin botón Cancelar — ESC fallback')
      try { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) } catch {}
      try { vlOnPhaseTimeout && vlOnPhaseTimeout('linkedin_discard_modal_no_cancel_btn') } catch {}
      return true
    }
  }
  return false
}

;(function setupDiscardModalObserver() {
  if (!document.body) {
    // body aún no listo (run_at=document_idle suele estar OK pero defensive)
    return setTimeout(setupDiscardModalObserver, 200)
  }
  const observer = new MutationObserver((mutations) => {
    // Fast-path: solo correr si alguna mutación añadió un nodo (no por text-changes)
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length > 0) {
        orionDetectDiscardModal()
        return
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  // Poll defensivo cada 1s — el observer puede perder modals que se montan
  // ANTES del observe (race con React portal). Cost: ~queryAll de 1-2 dialogs.
  setInterval(() => { try { orionDetectDiscardModal() } catch {} }, 1000)
  console.log('[Orion v0.7.9] Discard-modal observer instalado')
})()

// ── v0.7.9 SPA Route-Change Guard ──────────────────────────────────────────
// Wrap de history.pushState/replaceState que ABORTA el route-change si:
//   (a) Orion está ejecutando un comando (_orionIsExecuting === true), Y
//   (b) hay un editor contenteditable visible con texto (draft activo), Y
//   (c) la fase actual NO es 'send_clicked'/'send_confirmed' (post-send la
//       navegación a /thread/<id> es LEGÍTIMA y no debemos bloquearla).
// Esto previene que el propio LinkedIn dispare el discard-modal y elimina
// el disparador raíz del bug que vio Marco.
;(function setupSpaRouteGuard() {
  const origPush = history.pushState
  const origReplace = history.replaceState
  // v0.7.21 P2-6: removidos 'navigating' y 'hydrating' (referencias muertas — nunca emitidas).
  const BLOCKED_PHASES = new Set(['dispatched', 'thread_opened', 'typing', 'typed'])

  function hasActiveDraft() {
    try {
      const eds = document.querySelectorAll(
        '.msg-form__contenteditable, div[contenteditable="true"][role="textbox"], div.msg-form__msg-content-container [contenteditable="true"]'
      )
      for (const ed of eds) {
        if (ed.offsetParent === null) continue
        if ((ed.textContent || '').trim().length > 3) return true
      }
    } catch {}
    return false
  }

  function shouldBlock(targetUrl) {
    if (!window._orionIsExecuting) return false
    if (window.__orionAllowSpaNav) return false  // escape hatch para nav intencional
    const phase = window._orionCurrentPhase || ''
    if (!BLOCKED_PHASES.has(phase)) return false
    if (!hasActiveDraft()) return false
    console.warn(`[Orion v0.7.9] BLOCKED pushState→${(targetUrl||'').slice(0,80)} (phase=${phase}, draft activo)`)
    try { vlOnPhaseTimeout && vlOnPhaseTimeout(`spa_nav_blocked_phase_${phase}`) } catch {}
    return true
  }

  history.pushState = function(state, title, url) {
    if (shouldBlock(url)) return undefined
    return origPush.apply(this, arguments)
  }
  history.replaceState = function(state, title, url) {
    if (shouldBlock(url)) return undefined
    return origReplace.apply(this, arguments)
  }
  console.log('[Orion v0.7.9] SPA route-change guard instalado')
})()

// ── v0.7.3 Runtime Config (auto-learning-driven) ──────────────────────────
// Fetched once per content.js init desde /api/runtime-config + cached en
// chrome.storage.local. Permite que phase-analyzer auto-aplique cambios
// (timeouts más generosos, send method reorder, etc.) sin necesidad de
// recompilar/redeploy. Re-fetch cada 30min via SW alarm.
let _runtimeConfig = {
  phase_timeouts: {
    editor_focused: 3000,
    typing_complete: 4000,
    send_button_enabled: 4000,
    editor_cleared_via_humanClick: 4500,
    editor_cleared_via_ctrl_enter: 4500,
    editor_cleared_via_plain_enter: 4500,
    editor_cleared_via_form_submit: 4500,
    message_in_dom: 12000,
  },
  send_method_order: ['humanClick','ctrl_enter','plain_enter','form_submit'],
  page_errors_extra: [],
}

async function loadRuntimeConfig() {
  try {
    // Primero: cache local
    const cached = await chrome.storage.local.get('_runtime_config')
    if (cached?._runtime_config?.config) {
      _runtimeConfig = { ..._runtimeConfig, ...cached._runtime_config.config }
      console.log(`[Orion content] runtime_config cargado de cache (${Object.keys(_runtimeConfig).length} keys)`)
    }
    // Segundo: fetch fresh del server (no blocking — usa cache si falla)
    const stored = await chrome.storage.local.get(['orion_url', 'account_id'])
    if (stored?.orion_url) {
      // v0.7.47: account_id → el API mergea overrides per-cuenta. Sin account_id → URL global (idéntico).
      const rcUrl = stored.account_id
        ? `${stored.orion_url}/api/runtime-config?account_id=${encodeURIComponent(stored.account_id)}`
        : `${stored.orion_url}/api/runtime-config`
      const r = await fetch(rcUrl, { cache: 'no-store' }).catch(() => null)
      if (r?.ok) {
        const j = await r.json().catch(() => null)
        if (j?.config) {
          _runtimeConfig = { ..._runtimeConfig, ...j.config }
          await chrome.storage.local.set({ _runtime_config: j })
          console.log(`[Orion content] runtime_config refrescado del server`)
        }
      }
      // v0.7.4: fetch learned_selectors
      await loadLearnedSelectors(stored.orion_url)
      // v0.7.12 P0-1 heartbeat: POST snapshot del config actual + account_id + version
      // para que phase-analyzer pueda detectar drift (P2-2) y para verificar T13.
      try {
        const stored2 = await chrome.storage.local.get(['account_id', 'extension_api_key'])
        if (stored2?.account_id) {
          await fetch(`${stored.orion_url}/api/runtime-config/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              account_id: stored2.account_id,
              ext_version: chrome.runtime.getManifest().version,
              phase_timeouts: _runtimeConfig.phase_timeouts ?? null,
              send_method_order: _runtimeConfig.send_method_order ?? null,
              page_errors_extra: _runtimeConfig.page_errors_extra ?? null,
            }),
          }).catch(() => null)
        }
      } catch {}
    }
  } catch (err) {
    console.warn('[Orion content] loadRuntimeConfig falló:', err?.message)
  }
}
loadRuntimeConfig()  // fire-and-forget

// v0.7.12 P0-1: periodic refresh cada 5 min — sin esto, tunes de phase-analyzer
// (L3 timeouts, L4 send order, L5 page errors) nunca llegan a la extensión.
// Causa raíz del 3% success rate v0.7.7-v0.7.11.
setInterval(loadRuntimeConfig, 5 * 60 * 1000)

// v0.7.12 P0-1: listener para refresh forzado desde SW alarm (background.js)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'orion_runtime_config_refresh') {
    loadRuntimeConfig().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }))
    return true  // async response
  }
})

// v0.7.4: cache de learned_selectors agrupados por label
let _learnedSelectors = {}  // { label: [{ id, selector, alternatives, priority }, ...] }

async function loadLearnedSelectors(orionUrl) {
  try {
    const r = await fetch(`${orionUrl}/api/visual-learning/learned-selectors`, { cache: 'no-store' })
      .catch(() => null)
    if (!r?.ok) return
    const j = await r.json().catch(() => null)
    if (j?.byLabel) {
      _learnedSelectors = j.byLabel
      const total = Object.values(_learnedSelectors).reduce((s, arr) => s + arr.length, 0)
      if (total > 0) console.log(`[Orion content] learned_selectors cargados: ${total} en ${Object.keys(_learnedSelectors).length} labels`)
    }
  } catch {}
}

// Devuelve el array de selectores aprendidos para un label, ordenado por priority desc.
// content.js los PREPENDEA antes de selectores hardcoded.
function getLearnedSelectors(label, phaseName = null) {
  const arr = _learnedSelectors[label] ?? []
  let filtered = arr.filter(ls => !ls.phase_name || ls.phase_name === phaseName)
  return filtered.map(ls => ({
    id: ls.id,
    selector: ls.selector,
    alternatives: ls.selector_alternatives ?? [],
  }))
}

// Reporta hit/miss a server para tracking de health del learned_selector
function reportLearnedSelectorStat(selectorId, hit) {
  if (!selectorId) return
  chrome.storage.local.get(['orion_url']).then(stored => {
    if (!stored?.orion_url) return
    fetch(`${stored.orion_url}/api/visual-learning/learned-selectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectorId, hit }),
    }).catch(() => {})
  }).catch(() => {})
}

// Helper para buscar elemento con selectors APRENDIDOS primero, luego defaults.
// Si un learned matches → reporta hit. Si todos fallan → reporta miss para cada
// learned intentado.
function findElementSmart(label, defaultSelectors = [], phaseName = null) {
  const learned = getLearnedSelectors(label, phaseName)
  // 1. Intentar learned (todos)
  for (const ls of learned) {
    try {
      const el = document.querySelector(ls.selector)
      if (el) {
        reportLearnedSelectorStat(ls.id, true)
        return el
      }
      // Probar alternativas
      for (const alt of ls.alternatives) {
        try {
          const el2 = document.querySelector(alt)
          if (el2) {
            reportLearnedSelectorStat(ls.id, true)
            return el2
          }
        } catch {}
      }
      reportLearnedSelectorStat(ls.id, false)
    } catch {}
  }
  // 2. Fallback: defaults hardcoded
  for (const sel of defaultSelectors) {
    try {
      const el = document.querySelector(sel)
      if (el) return el
    } catch {}
  }
  return null
}

function getPhaseTimeout(phaseName, defaultMs) {
  return _runtimeConfig.phase_timeouts?.[phaseName] ?? defaultMs
}

function getSendMethodOrder() {
  return _runtimeConfig.send_method_order ?? ['humanClick','ctrl_enter','plain_enter','form_submit']
}

// ── v0.7.6 NOT-MESSAGEABLE DETECTOR ────────────────────────────────────────
// Detecta cuando una conversación NO permite enviar mensajes nuevos. Casos:
//   1. Lead es 2°/3° grado y NO ha contestado → LinkedIn esconde editor
//   2. "No has recibido respuesta aún" badge + no editor → InMail only
//   3. Lead bloqueó comunicación o desactivó cuenta
//   4. Sponsored/Patrocinado thread (no es real lead)
//
// Devuelve { detected: bool, reason: string, signals: object } para reportar
// al bridge sin reintentar.
function detectNotMessageable() {
  const signals = {}
  let detected = false
  let reasons = []

  // Signal 1: degree badge "2°" o "3°" en header (LinkedIn marca explícitamente)
  // Busca elementos pequeños cerca del header que digan "2°" o "3°"
  try {
    const headerArea = document.querySelector(
      '.msg-thread__title-container, .msg-overlay-conversation-bubble__title-bar, [class*="msg-thread"] header, .msg-conversations-container__title-row'
    ) || document.body
    const degreeTexts = Array.from(headerArea.querySelectorAll('span, div, a'))
      .slice(0, 50)
      .map(el => (el.textContent ?? '').trim())
      .filter(t => t.length > 0 && t.length < 15)
    const has2nd = degreeTexts.some(t => /^2[°º]$/.test(t) || /\b2(nd|do|°|º)\b/i.test(t))
    const has3rd = degreeTexts.some(t => /^3[°º]$/.test(t) || /\b3(rd|er|°|º)\b/i.test(t))
    if (has2nd) { signals.degree = '2nd'; reasons.push('lead_is_2nd_degree'); detected = true }
    if (has3rd) { signals.degree = '3rd'; reasons.push('lead_is_3rd_degree'); detected = true }
  } catch {}

  // Signal 2: "No has recibido respuesta aún" / "Awaiting reply" badge visible
  try {
    const bodyText = document.body.innerText.toLowerCase()
    const awaitingPhrases = [
      'no has recibido respuesta',
      'awaiting reply',
      'awaiting their reply',
      'pending response',
      'aún no ha contestado',
    ]
    const awaitingFound = awaitingPhrases.find(p => bodyText.includes(p))
    if (awaitingFound) {
      signals.awaiting_reply_badge = awaitingFound
      reasons.push('awaiting_reply_badge_present')
      // No marcamos detected aquí solo — solo si COMBINADO con no-editor
    }
  } catch {}

  // Signal 3: InMail button visible (LinkedIn requiere créditos para mensaje 2°)
  try {
    const inmailButtons = document.querySelectorAll(
      'button[aria-label*="InMail" i], a[aria-label*="InMail" i], button[class*="inmail"], [class*="inmail-cta"]'
    )
    const inmailVisible = Array.from(inmailButtons).find(b => b.offsetParent !== null)
    if (inmailVisible) {
      signals.inmail_button = inmailVisible.tagName + ':' + (inmailVisible.className || '').slice(0, 50)
      reasons.push('inmail_required')
      detected = true
    }
    // InMail "créditos disponibles" texto típico del compose 2nd-degree
    const inmailHintText = ['de \\d+ créditos', 'inmail credits', 'créditos disponibles']
    for (const pat of inmailHintText) {
      if (new RegExp(pat, 'i').test(document.body.innerText)) {
        signals.inmail_hint = pat
        reasons.push('inmail_credits_hint')
        detected = true
        break
      }
    }
  } catch {}

  // Signal 4: Editor NO presente Y tampoco hay textarea de typing
  // Combinado con awaiting_reply_badge = LinkedIn cerró el thread
  try {
    const editorPresent = !!document.querySelector(
      '.msg-form__contenteditable, div[contenteditable="true"][role="textbox"], textarea[name*="message" i]'
    )
    signals.editor_present = editorPresent
    if (!editorPresent && signals.awaiting_reply_badge) {
      reasons.push('no_editor_with_awaiting_badge')
      detected = true
    }
  } catch {}

  // Signal 5: Thread es "Patrocinado" / Sponsored
  try {
    const sponsoredPhrases = ['patrocinado', 'promoted', 'sponsored']
    const titleEl = document.querySelector('.msg-thread__title-container, .msg-overlay-conversation-bubble__title-bar')
    const titleText = (titleEl?.textContent ?? '').toLowerCase()
    if (sponsoredPhrases.some(p => titleText.includes(p))) {
      signals.sponsored = true
      reasons.push('sponsored_thread_not_real_lead')
      detected = true
    }
  } catch {}

  // Signal 6 (2026-07-04): botón "Conectar"/"Connect" visible en el ÁREA de la conversación
  // = el participante NO es 1er grado (nos ELIMINÓ, o nunca fue conexión). Cierra el hueco de
  // la ruta thread donde LinkedIn muestra el editor normal pero ofrece "Conectar". Scopeado a
  // la conversación (no la nav global ni sugerencias del sidebar) para evitar falsos positivos.
  // reason incluye "2nd_degree" para que extension-bridge lo escale a Super DEAD (anti-ban).
  try {
    const convArea = document.querySelector(
      '.msg-thread, [class*="msg-thread"], .msg-overlay-conversation-bubble, .msg-s-message-list-container, .msg-title-bar'
    )
    if (convArea) {
      const hasConnect = Array.from(convArea.querySelectorAll('button, a[role="button"]'))
        .filter(b => b.offsetParent !== null)
        .some(b => {
          const t = (b.textContent ?? '').trim().toLowerCase()
          const aria = (b.getAttribute('aria-label') ?? '').toLowerCase()
          return t === 'conectar' || t === 'connect' || /^(conectar|connect|invitar|invite)\b/.test(aria)
        })
      if (hasConnect) { signals.connect_cta_in_thread = true; reasons.push('connect_cta_2nd_degree'); detected = true }
    }
  } catch {}

  const reason = reasons.length > 0 ? reasons.join('+') : null
  return { detected, reason, signals }
}

// ── v0.7.8 AWAITING-RESPONSE LOCK DETECTOR ────────────────────────────────
// Caso: lead CONECTADO (1er grado) al que ya enviamos FU1/FU2/FU3 y NO ha
// respondido. LinkedIn aplica una "ban window" que mantiene el composer
// presente pero deshabilitado (aria-disabled), y muestra un banner
// "No has recibido respuesta aún" / "You haven't received a reply yet".
// DIFERENTE de detectNotMessageable() (que detecta 2°/3°/InMail → dead).
// Aquí el lead está OK, solo hay que esperar a que conteste; el bridge
// marca status='awaiting_response' sin tocar fu_count ni reintentar.
async function detectAwaitingResponseLock(editor) {
  const signals = {}
  try {
    // Signal A: banner textual (es / en)
    const bodyText = (document.body.innerText || '').toLowerCase()
    const phrases = [
      'no has recibido respuesta aún',
      'no has recibido respuesta aun',
      "you haven't received a reply yet",
      'you have not received a reply yet',
      'awaiting their reply',
      'awaiting reply',
    ]
    const phraseFound = phrases.find(p => bodyText.includes(p))
    if (phraseFound) signals.banner_phrase = phraseFound

    // Signal B: composer presente pero aria-disabled="true"
    let composerDisabled = false
    if (editor) {
      const ariaDisabled = editor.getAttribute('aria-disabled')
      const ceAttr = editor.getAttribute('contenteditable')
      if (ariaDisabled === 'true' || ceAttr === 'false') composerDisabled = true
      // Algunos layouts envuelven el editor en un form deshabilitado
      const formAncestor = editor.closest('form, .msg-form, [class*="msg-form"]')
      if (formAncestor) {
        const formDisabled = formAncestor.getAttribute('aria-disabled') === 'true' ||
                             formAncestor.classList.toString().toLowerCase().includes('disabled')
        if (formDisabled) composerDisabled = true
      }
      signals.composer_aria_disabled = ariaDisabled
      signals.composer_contenteditable = ceAttr
    }

    // Signal C: send button visible y disabled (best-effort, sin escribir aún)
    let sendBtnDisabled = false
    try {
      const sendBtns = Array.from(document.querySelectorAll(
        'button[class*="msg-form__send-button"], button[type="submit"][class*="msg-form"]'
      ))
      const visibleSend = sendBtns.find(b => b.offsetParent !== null)
      if (visibleSend) {
        const dis = visibleSend.disabled === true ||
                    visibleSend.getAttribute('aria-disabled') === 'true' ||
                    visibleSend.getAttribute('disabled') !== null
        if (dis) sendBtnDisabled = true
        signals.send_btn_state = dis ? 'disabled' : 'enabled'
      }
    } catch {}

    // Veredicto: banner + (composer-disabled O send-btn-disabled) = lock confirmado.
    // Requerimos AMBAS condiciones (banner + algún disabled) para minimizar
    // falsos positivos sobre threads que solo muestran el badge informativo.
    if (signals.banner_phrase && (composerDisabled || sendBtnDisabled)) {
      // Re-check tras 600ms — algunos layouts de LinkedIn habilitan el editor
      // un instante después de renderizar el banner.
      await sleep(600)
      let stillLocked = false
      try {
        const ad = editor ? editor.getAttribute('aria-disabled') : null
        const ce = editor ? editor.getAttribute('contenteditable') : null
        const stillComposerDis = ad === 'true' || ce === 'false'
        const sendBtns2 = Array.from(document.querySelectorAll(
          'button[class*="msg-form__send-button"], button[type="submit"][class*="msg-form"]'
        ))
        const vs = sendBtns2.find(b => b.offsetParent !== null)
        const stillSendDis = vs && (vs.disabled === true || vs.getAttribute('aria-disabled') === 'true')
        stillLocked = stillComposerDis || stillSendDis
      } catch {}
      if (stillLocked) {
        const reason = composerDisabled ? 'banner_plus_composer_disabled'
                       : sendBtnDisabled ? 'banner_plus_send_btn_disabled'
                       : 'banner_plus_lock'
        return { locked: true, reason, signals }
      }
    }
  } catch (e) {
    signals.detector_error = String(e?.message || e).slice(0, 120)
  }
  return { locked: false, reason: null, signals }
}

// ── v0.7.4 Visual Selector Learning ────────────────────────────────────────
// Cuando una phase falla N veces en M minutos, capturamos screenshot + DOM
// snapshot del viewport actual + lo subimos al bridge para crear un ticket.
// Admin lo abre, hace pins, y aprendemos selectores nuevos.

const VL_FAILURE_TRACKER_KEY = '_vl_failures'
const VL_DEFAULT_THRESHOLD = 3
const VL_DEFAULT_WINDOW_MIN = 60

// Tracker de fails per phase en storage.session (survives SW restart)
async function vlTrackFailure(phaseName, accountInfo) {
  try {
    const stored = await chrome.storage.session?.get?.(VL_FAILURE_TRACKER_KEY)
    const tracker = stored?.[VL_FAILURE_TRACKER_KEY] ?? {}
    const now = Date.now()
    const windowMs = (_runtimeConfig?.visual_learning_config?.auto_capture_window_minutes ?? VL_DEFAULT_WINDOW_MIN) * 60_000
    const threshold = _runtimeConfig?.visual_learning_config?.auto_capture_threshold ?? VL_DEFAULT_THRESHOLD
    const list = (tracker[phaseName] ?? []).filter(ts => now - ts < windowMs)
    list.push(now)
    tracker[phaseName] = list.slice(-20)
    await chrome.storage.session?.set?.({ [VL_FAILURE_TRACKER_KEY]: tracker })
    if (list.length >= threshold) {
      console.log(`[Orion VL] phase "${phaseName}" failed ${list.length}× en ${Math.round(windowMs/60000)}min → triggering capture`)
      await vlTriggerCapture(phaseName, 'auto_threshold', accountInfo)
      // Clear tracker para no spamear
      tracker[phaseName] = []
      await chrome.storage.session?.set?.({ [VL_FAILURE_TRACKER_KEY]: tracker })
    }
  } catch (err) {
    console.warn('[Orion VL] vlTrackFailure error:', err?.message)
  }
}

// Mapeo phase → elemento de referencia a scrollear antes de capturar
const VL_REFERENCE_SELECTORS = {
  editor_focused:        '.msg-form__contenteditable, .msg-form, [class*="msg-form"]',
  typing_complete:       '.msg-form__contenteditable, .msg-form',
  send_button_enabled:   '.msg-form__send-button, button[class*="send"], .msg-form',
  editor_cleared_via_humanClick:   '.msg-form__send-button, .msg-form',
  editor_cleared_via_ctrl_enter:   '.msg-form__send-button, .msg-form',
  editor_cleared_via_plain_enter:  '.msg-form__send-button, .msg-form',
  editor_cleared_via_form_submit:  '.msg-form__send-button, .msg-form',
  message_in_dom:        '.msg-s-message-list, [class*="msg-s-message-list"]',
  thread_visible_in_list: '.msg-conversations-container__conversations-list, ul[class*="conversations-list"]',
  list_rendered:          '.msg-conversations-container__conversations-list',
  thread_opened:          '.msg-s-message-list, .msg-form',
}

// Genera un selector CSS "estable" de un elemento (preferimos aria-label, role,
// data-*, class names estables sobre hash class names random).
function vlGenerateStableSelector(el) {
  if (!el || el.nodeType !== 1) return null
  const candidates = []
  const tag = el.tagName.toLowerCase()

  // 1. ID estable (no hash)
  if (el.id && !/^[a-z0-9]{8,}$/.test(el.id) && !el.id.startsWith('ember')) {
    candidates.push({ sel: `${tag}#${CSS.escape(el.id)}`, score: 0.95 })
  }

  // 2. aria-label
  const aria = el.getAttribute('aria-label')
  if (aria && aria.length > 1 && aria.length < 50) {
    candidates.push({ sel: `${tag}[aria-label="${aria.replace(/"/g,'\\"')}" i]`, score: 0.90 })
  }

  // 3. data-* atributos
  for (const attr of el.attributes) {
    if (attr.name.startsWith('data-') && attr.value && attr.value.length < 50 &&
        !/^[a-z0-9]{20,}$/.test(attr.value)) {
      candidates.push({ sel: `${tag}[${attr.name}="${attr.value}"]`, score: 0.85 })
    }
  }

  // 4. role + class estable
  const role = el.getAttribute('role')
  const classes = (el.className?.toString() ?? '').split(/\s+/).filter(c =>
    c.length > 3 && c.length < 50 &&
    !/^[a-z0-9]{10,}$/.test(c) &&         // no hash
    !c.startsWith('ember') &&
    (c.includes('-') || c.includes('_'))  // tiene separadores
  )
  if (role && classes.length > 0) {
    candidates.push({ sel: `${tag}[role="${role}"].${classes[0]}`, score: 0.80 })
  } else if (role) {
    candidates.push({ sel: `${tag}[role="${role}"]`, score: 0.70 })
  }

  // 5. Class names estables
  if (classes.length > 0) {
    const topClass = classes.find(c => c.includes('msg-') || c.includes('artdeco-')) ?? classes[0]
    candidates.push({ sel: `${tag}.${topClass}`, score: 0.65 })
    if (classes.length >= 2) {
      candidates.push({ sel: `${tag}.${classes[0]}.${classes[1]}`, score: 0.70 })
    }
  }

  // 6. contenteditable= como discriminador
  if (el.getAttribute('contenteditable') === 'true') {
    const ariaPart = aria ? `[aria-label="${aria.replace(/"/g,'\\"')}" i]` : ''
    candidates.push({ sel: `${tag}[contenteditable="true"]${ariaPart}`, score: 0.75 })
  }

  candidates.sort((a, b) => b.score - a.score)
  return {
    primary: candidates[0]?.sel ?? null,
    alternatives: candidates.slice(1, 4).map(c => c.sel),
    confidence: candidates[0]?.score ?? 0,
  }
}

// Serializa los elementos visibles del viewport en JSON. Incluye:
// - tagName, attributes relevantes, rect (x,y,w,h), textPreview, depth
// Usado para resolver pin(x,y) → element posteriormente.
function vlCaptureDOMSnapshot(maxElements = 500) {
  const snapshot = []
  const seen = new WeakSet()
  // Walk árbol del body
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
  let node = walker.currentNode
  let depth = 0
  while (node && snapshot.length < maxElements) {
    const el = node
    if (!seen.has(el)) {
      seen.add(el)
      try {
        const rect = el.getBoundingClientRect()
        if (rect.width > 8 && rect.height > 8 &&
            rect.bottom > 0 && rect.top < window.innerHeight &&
            rect.right > 0 && rect.left < window.innerWidth) {
          const attrs = {}
          for (const a of el.attributes) {
            if (a.name === 'id' || a.name === 'role' ||
                a.name.startsWith('aria-') || a.name.startsWith('data-')) {
              attrs[a.name] = a.value.slice(0, 80)
            }
          }
          snapshot.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className?.toString?.() ?? '').slice(0, 200),
            attrs,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            textPreview: (el.textContent ?? '').slice(0, 60).replace(/\s+/g, ' ').trim(),
            editable: el.getAttribute?.('contenteditable') === 'true',
            depth,
          })
        }
      } catch {}
    }
    node = walker.nextNode()
  }
  return snapshot
}

async function vlTriggerCapture(phaseName, source, accountInfo) {
  try {
    // 1. Scroll al elemento de referencia
    const refSel = VL_REFERENCE_SELECTORS[phaseName]
    if (refSel) {
      const ref = document.querySelector(refSel)
      if (ref) {
        ref.scrollIntoView({ behavior: 'instant', block: 'center' })
        await sleep(600)  // dejar React re-render + paint
      }
    }
    // 2. DOM snapshot
    const domSnapshot = vlCaptureDOMSnapshot(500)
    // 3. Enviar al SW para que tome screenshot
    chrome.runtime.sendMessage({
      type: 'orion_visual_capture',
      phaseName,
      source,
      commandId: _currentCommandId,
      url: location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight, scrollY: window.scrollY },
      domSnapshot,
      capturedAt: new Date().toISOString(),
    }).catch(err => console.warn('[Orion VL] sendMessage capture failed:', err?.message))
    console.log(`[Orion VL] capture triggered for phase "${phaseName}" (${domSnapshot.length} DOM elements, source=${source})`)
  } catch (err) {
    console.warn('[Orion VL] vlTriggerCapture error:', err?.message)
  }
}

// Hook al MicroPhaseRunner — cuando una phase reporta 'timeout', tracking dispara
// async setTimeout para no bloquear el flow del runner.
function vlOnPhaseTimeout(phaseName) {
  // Fire-and-forget
  vlTrackFailure(phaseName).catch(() => {})
}

// ── FSM v0.7.0 ────────────────────────────────────────────────────────────────
// Phase state machine. content.js es la única fuente de verdad del estado del
// cmd. El SW DEBE consultar phase antes de navegar/dispatchear.
//
// Transitions válidas:
//   idle → dispatched → navigating → hydrating → thread_opened → typed
//        → send_clicked → send_confirmed → done
//   (cualquier phase puede ir a 'error')
//
// v0.7.21 P2-6: removidos 'navigating' y 'hydrating' (nunca emitidos por setPhase).
// "Active" phases (SW NO debe navegar): dispatched, thread_opened, typing, typed, send_clicked.
// "Safe" phases (SW puede navegar): idle, send_confirmed, done, error.
const FSM_ACTIVE_PHASES = new Set([
  'dispatched', 'thread_opened', 'typing', 'typed', 'send_clicked'
])
const FSM_SAFE_PHASES = new Set(['idle', 'send_confirmed', 'done', 'error'])
const FSM_STORAGE_KEY = '_phase_fsm'

async function setPhase(state, extra = {}) {
  const ts = Date.now()
  const phase = {
    state,
    commandId: _currentCommandId,
    transitionedAt: ts,
    elapsed: ts - (_executingSince || ts),
    ...extra,
  }
  // v0.7.9: expose to window para que SPA route-guard + discard-modal observer
  // (instalados al init, ANTES del listener) puedan leer el estado vivo.
  try { window._orionCurrentPhase = state } catch {}
  console.log(`[Orion FSM] → ${state} (cmd ${_currentCommandId?.slice(0,8) ?? '?'}, ${extra.note ?? ''})`)
  try {
    await chrome.storage.session?.set?.({ [FSM_STORAGE_KEY]: phase })
  } catch (err) {
    console.warn(`[Orion FSM] storage set failed:`, err?.message)
  }
  // También notificamos al SW via runtime para que pueda logear / forward a bridge
  try {
    chrome.runtime.sendMessage({
      type: 'orion_phase_update',
      commandId: _currentCommandId,
      phase: state,
      ts,
      extra,
    }).catch(() => {})
  } catch {}
}

async function clearPhase() {
  try { await chrome.storage.session?.remove?.(FSM_STORAGE_KEY) } catch {}
  try { window._orionCurrentPhase = 'idle' } catch {}
}

// ── v0.7.2 MICRO-PHASE ENGINE ───────────────────────────────────────────────
// Cada paso del flow es un CHECKPOINT que se confirma con evidencia DOM observable
// (NO con timers). Pattern: runner.runPhase(name, evidenceFn, options) polea hasta
// que evidenceFn retorne truthy, o falla con timeout. Cada transition se persiste
// para audit + debug.
class MicroPhaseRunner {
  constructor(commandId, actionName) {
    this.commandId = commandId
    this.actionName = actionName
    this.phases = []
    this.startedAt = Date.now()
  }

  /**
   * Corre una micro-phase: polea evidenceFn() hasta truthy, persist transition.
   * @param {string} name - nombre de la phase (e.g., 'editor_focused')
   * @param {Function} evidenceFn - retorna truthy si la evidencia está presente
   * @param {object} options - { timeoutMs, intervalMs, label }
   * @returns evidence value (lo que retornó evidenceFn cuando passed)
   */
  async runPhase(name, evidenceFn, options = {}) {
    const { timeoutMs = 8000, intervalMs = 200, label } = options
    const phaseStart = Date.now()
    await this._record(name, { state: 'started', label })

    // v0.9 ANTI-THROTTLE en el poll: Chrome ralentiza setTimeout (~1/min) en tabs en
    // background/ocluidas → el sleep(intervalMs) se estira y la fase se rinde con 1 solo
    // poll real (causa de micro_phase_typing_complete_timeout pese al foco v0.7.42). Si
    // detectamos un sleep throttled (slept >> intervalMs), devolvemos el exceso al
    // deadline (hasta maxCredit) para que la fase reciba suficientes polls reales antes
    // de declarar timeout. Ver docs/fix-typing-throttle.md.
    let deadline = Date.now() + timeoutMs
    let lastError = null
    let polls = 0
    let throttleCredit = 0
    const maxCredit = timeoutMs * 3
    while (Date.now() < deadline) {
      polls++
      try {
        const ev = await evidenceFn()
        if (ev) {
          const ms = Date.now() - phaseStart
          await this._record(name, {
            state: 'ok',
            ms,
            polls,
            evidence: typeof ev === 'object' && ev !== null ? ev : true,
          })
          return ev
        }
      } catch (err) {
        lastError = err.message
        // No abort — sigue poleando (evidenceFn puede tener errores transitorios)
      }
      const _sleepT0 = Date.now()
      await sleep(intervalMs)
      const slept = Date.now() - _sleepT0
      if (slept > intervalMs * 4 && throttleCredit < maxCredit) {
        const extra = Math.min(slept - intervalMs, maxCredit - throttleCredit)
        deadline += extra
        throttleCredit += extra
      }
    }

    const ms = Date.now() - phaseStart
    await this._record(name, { state: 'timeout', ms, polls, lastError, timeoutMs, throttleCredit })
    // v0.7.4: trigger Visual Learning tracker (async, fire-and-forget)
    try { vlOnPhaseTimeout(name) } catch {}
    throw new Error(`micro_phase_${name}_timeout_${ms}ms`)
  }

  /**
   * Marca una phase como instantánea (no poll) — usado para milestones que ya
   * sabemos que ocurrieron (e.g., justo después de humanClick).
   */
  async mark(name, extra = {}) {
    await this._record(name, { state: 'mark', ...extra })
  }

  async _record(name, extra) {
    const entry = {
      name,
      ts: Date.now(),
      elapsed: Date.now() - this.startedAt,
      ...extra,
    }
    this.phases.push(entry)
    console.log(`[Orion µ-phase] ${name}: ${extra.state} (${extra.ms ?? 0}ms${extra.polls ? `, ${extra.polls} polls` : ''}${extra.evidence ? `, ev=${JSON.stringify(extra.evidence).slice(0, 80)}` : ''})`)
    // Persist to storage.session
    try {
      await chrome.storage.session?.set?.({
        _micro_phase: {
          commandId: this.commandId,
          action: this.actionName,
          latest: entry,
          count: this.phases.length,
        },
      })
    } catch {}
    // Forward al SW → bridge → DB
    try {
      chrome.runtime.sendMessage({
        type: 'orion_micro_phase',
        commandId: this.commandId,
        action: this.actionName,
        entry,
      }).catch(() => {})
    } catch {}
  }

  getPhases() { return [...this.phases] }
}

// Helper para confirmar envío: polea el DOM buscando un mensaje outbound
// reciente que matchee el fingerprint (primeros 50 chars normalizados).
// 15s budget, polling 500ms. v0.7.0 reemplaza a verifyFollowupSent.
async function confirmMessageSent(message, options = {}) {
  const { budgetMs = 15000, intervalMs = 500 } = options
  // v0.7.16 L6: fingerprint MÁS PERMISIVO. slice(0,20) y normalización agresiva
  // (quita puntuación + colapsa whitespace) — LinkedIn está mutando encoding/anidación.
  const normalize = (s) => (s ?? '').toLowerCase()
    .replace(/[ ​-‍﻿]/g, ' ')        // NBSP, ZWJ, BOM
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')                    // quita puntuación/símbolos
    .replace(/\s+/g, ' ').trim()
  const fingerprint = normalize(message).slice(0, 50)
  if (!fingerprint || fingerprint.length < 8) return { confirmed: false, reason: 'empty_fingerprint' }
  const fpShort = fingerprint.slice(0, 20)              // antes 30 — más laxo
  const deadline = Date.now() + budgetMs
  let pollCount = 0
  while (Date.now() < deadline) {
    pollCount++
    // v0.7.16: pool ampliado (incluye contenedores padre + role=listitem fallback)
    const messages = document.querySelectorAll(
      '.msg-s-message-list__event, .msg-s-event-listitem, [class*="msg-s-event"], ' +
      '.msg-s-message-group, [class*="message-group"], ' +
      '.msg-s-message-list li, li[role="listitem"]'
    )
    // Buscar entre las últimas 8 (antes 5)
    for (let i = messages.length - 1; i >= Math.max(0, messages.length - 8); i--) {
      const text = normalize(messages[i]?.textContent)
      if (text.includes(fpShort)) {
        return { confirmed: true, pollCount, foundAt: i, totalMessages: messages.length, matchedOn: 'textContent' }
      }
      // v0.7.16: fallback — buscar en innerHTML por si LinkedIn anida <span> raros
      const html = normalize((messages[i]?.innerHTML ?? '').replace(/<[^>]+>/g, ' '))
      if (html.includes(fpShort)) {
        return { confirmed: true, pollCount, foundAt: i, totalMessages: messages.length, matchedOn: 'innerHTML' }
      }
    }
    await sleep(intervalMs)
  }
  return { confirmed: false, reason: 'fingerprint_not_found_in_dom', pollCount }
}

function withHardTimeout(promise, ms, action) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`exec_hard_timeout_${action}_${ms}ms`)), ms)
    promise.then(v => { clearTimeout(t); resolve(v) },
                 e => { clearTimeout(t); reject(e) })
  })
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // v0.6.46: ping status del content.js — el SW lo usa ANTES de navegar para
  // saber si content.js sigue ejecutando un cmd previo (caso post-WS-reconnect).
  if (msg.type === 'orion_status_ping') {
    sendResponse({
      isExecuting: _isExecuting,
      currentCommandId: _currentCommandId,
      since: _executingSince,
      elapsedMs: _executingSince ? Date.now() - _executingSince : 0,
    })
    return true
  }

  if (msg.type !== 'orion_command') return false

  const { commandId, action, payload } = msg

  // Opción B — ACK de recepción: confirmamos al SW que RECIBIMOS el comando
  // (antes de cualquier guard/ejecución). El SW lo reenvía al bridge → acked_at.
  // Si luego el comando expira sin resultado, acked_at distingue
  // content_died_mid_work (recibido, murió) de content_unreachable (nunca llegó).
  // Fire-and-forget; si el SW no está, el catch lo ignora.
  try {
    chrome.runtime.sendMessage({ type: 'orion_cmd_ack', commandId, ts: Date.now() }).catch(() => {})
  } catch {}

  // Guard: si hay un comando en ejecución, rechazar el nuevo.
  // Safety: si lleva >2min "ejecutando" asumimos que se colgó y liberamos el lock.
  // Bajado de 180s→125s (alineado con EXEC_HARD_TIMEOUT_MS + margen 5s).
  if (_isExecuting && (Date.now() - _executingSince) < 125_000) {
    console.warn(`[Orion content] Command ${action} (${commandId}) RECHAZADO — otro comando en ejecución desde hace ${Math.round((Date.now()-_executingSince)/1000)}s`)
    sendResponse({ ok: false, error: 'content_busy_executing' })
    return true
  }

  // Si llegamos aquí con _isExecuting=true es porque el lock está stale (>125s).
  // Forzamos release para arrancar limpio.
  if (_isExecuting) {
    console.warn(`[Orion content] Lock stale ${Math.round((Date.now()-_executingSince)/1000)}s → force-release`)
    _isExecuting = false
  }

  // v0.6.44: limpiar editor de basura del comando ANTERIOR antes de empezar
  // este. Si Leave-site modal apareció + se aceptó, queda texto huérfano en
  // el editor que ensucia el próximo typing. También dispara `beforeunload`
  // cleanup para evitar el modal.
  try {
    const dirtyEditors = document.querySelectorAll(
      '.msg-form__contenteditable, div[contenteditable="true"][role="textbox"]'
    )
    for (const ed of dirtyEditors) {
      if (ed.textContent && ed.textContent.trim().length > 0) {
        ed.innerHTML = ''
        ed.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
  } catch {}

  _isExecuting = true
  _executingSince = Date.now()
  _currentCommandId = commandId  // v0.6.46
  // v0.7.9: expose to window para discard-modal observer + SPA route guard.
  try { window._orionIsExecuting = true } catch {}
  // v0.6.49: storage.session mutex como fallback al ping (más rápido + survives SW restart)
  try {
    chrome.storage.session?.set?.({
      _executing: { commandId, since: _executingSince, url: location.href }
    })
  } catch {}
  // v0.7.0 FSM: phase 'dispatched' al recibir el cmd
  setPhase('dispatched', { action, leadName: payload?.leadName, kind: payload?.kind })
  // v0.7.1: avisar al beforeunload handler que Orion espera nav (en caso de
  // re-dispatch post-WS-reconnect, SW podría navegar de nuevo a esta misma tab).
  // El flag se borra al limpiar el editor en .finally().
  window.__orionExpectedNav = true
  console.log(`[Orion content] Command ${action} (${commandId})`, payload)

  // v0.7.1: hard timeout dinámico según msg.length (era 120s fijo, insuficiente
  // para mensajes >400 chars que humanType toma ~80-100s).
  const hardTimeoutMs = calcHardTimeout(action, payload)
  console.log(`[Orion content] Hard timeout dinámico: ${hardTimeoutMs}ms para ${action} (msg ${payload?.message?.length ?? 0} chars)`)

  withHardTimeout(executeAction(action, payload), hardTimeoutMs, action)
    .then(result => sendResponse({ ok: true, ...result }))
    .catch(err => {
      const errMsg = err.message ?? String(err)
      // v0.7.5: si exec_hard_timeout, también dispara Visual Learning (3× en 1h → capture).
      // Phase pseudoname para tracker: 'exec_hard_timeout_<action>'.
      if (errMsg.startsWith('exec_hard_timeout_')) {
        try { vlOnPhaseTimeout(`exec_hard_timeout_${action}`) } catch {}
      }
      sendResponse({ ok: false, error: errMsg })
    })
    .finally(() => {
      _isExecuting = false
      _currentCommandId = null
      // v0.7.9: limpiar flag global para que el discard-observer/spa-guard se desactiven.
      try { window._orionIsExecuting = false } catch {}
      // v0.6.49: limpiar mutex de storage al terminar
      try { chrome.storage.session?.remove?.('_executing') } catch {}
      // v0.7.0 FSM: clear phase (back to idle)
      clearPhase()
      // v0.7.1: UNIVERSAL EDITOR CLEANUP — sin importar por qué salimos, vaciar
      // cualquier editor con texto huérfano. Esto previene el modal "Leave site?"
      // del navegador cuando el SW navegue para el siguiente cmd. Es la red
      // de seguridad final del flow.
      try {
        const editors = document.querySelectorAll(
          '.msg-form__contenteditable, div[contenteditable="true"][role="textbox"], div.msg-form__msg-content-container [contenteditable="true"]'
        )
        let cleaned = 0
        for (const ed of editors) {
          if (ed.textContent && ed.textContent.trim().length > 0) {
            ed.innerHTML = ''
            ed.dispatchEvent(new Event('input', { bubbles: true }))
            cleaned++
          }
        }
        if (cleaned > 0) console.log(`[Orion content] v0.7.1 final cleanup: ${cleaned} editor(s) vaciado(s)`)
      } catch {}
      // v0.7.31 SAFETY: para send_invite, desarmar+cerrar cualquier modal de
      // invitación que el flujo dejó abierto (cuelgue/timeout post-typing). Evita
      // invitaciones "armadas" con nota que podrían enviarse en una interacción
      // posterior. Corre incluso en exec_hard_timeout (este finally settla la race).
      if (action === 'send_invite') {
        try { safeDismissInviteModal() } catch {}
      }
      // v0.7.1: limpiar flag de nav esperada (próxima navegación humana mostrará modal normal)
      try { delete window.__orionExpectedNav } catch { window.__orionExpectedNav = false }
    })

  return true  // mantener canal abierto para sendResponse asíncrono
})

// ── Acciones disponibles ────────────────────────────────────────────────────

// v0.7.16 — Pre-flight LinkedIn security banner detector.
// Bilingüe ES/EN. Solo dispara si TEXT match Y selector visible (doble confirmación
// → low false-positive). Severity 'critical' → abort + pause; 'warning' → soft
// abort + cooldown; 'benign' → auto-dismiss + continue.
const BANNER_RULES = {
  captcha_checkpoint: {
    severity: 'critical',
    textSignals: [
      /captcha|recaptcha/i,
      /verify you are human|verifica que eres humano/i,
      /security check|comprobaci[óo]n de seguridad/i,
      /confirm your identity|confirma tu identidad/i,
    ],
    selectorSignals: ['.g-recaptcha', '[class*="recaptcha"]', 'iframe[src*="recaptcha"]', '[class*="challenge"]'],
  },
  account_locked: {
    severity: 'critical',
    textSignals: [
      /account (has been )?restricted|cuenta (ha sido )?restringida/i,
      /temporarily (disabled|restricted)|deshabilitada temporalmente/i,
      /unusual activity|actividad inusual/i,
      /we['']ve detected|hemos detectado/i,
    ],
    selectorSignals: ['[class*="alert-banner"][class*="error"]', '[class*="account-restricted"]', '[aria-label*="restricted"]'],
  },
  session_expired: {
    severity: 'critical',
    textSignals: [
      /sesi[óo]n (expirada|expir[óo])|session expired|session has ended/i,
      /vuelve a iniciar sesi[óo]n|log in again|sign in to continue/i,
    ],
    selectorSignals: ['[class*="auth-wall"]', '[data-testid*="sign_in"]', 'form[action*="login"]'],
  },
  invite_limit_warning: {
    severity: 'warning',
    textSignals: [
      /(weekly )?invitation limit|l[íi]mite (semanal )?de invitaciones/i,
      /you['']?ve sent many invitations|has enviado muchas invitaciones/i,
    ],
    selectorSignals: ['[class*="limit"]', '[class*="invitation-limit"]'],
  },
  rate_limit_notice: {
    severity: 'warning',
    textSignals: [
      /sent many messages recently|muchos mensajes recientemente/i,
      /slow down|take a break|espera un poco/i,
    ],
    selectorSignals: ['[class*="rate-limit"]', '[class*="throttle"]'],
  },
}

function checkBannersBeforeExecute() {
  try {
    const bodyText = (document.body?.innerText ?? '').toLowerCase().slice(0, 8000)
    const titleText = (document.title ?? '').toLowerCase()
    for (const [code, rule] of Object.entries(BANNER_RULES)) {
      let textMatch = null
      for (const rx of rule.textSignals) {
        if (rx.test(bodyText) || rx.test(titleText)) { textMatch = rx.source; break }
      }
      if (!textMatch) continue
      let selMatch = null
      for (const sel of rule.selectorSignals) {
        try {
          const el = document.querySelector(sel)
          if (el && (el.offsetParent !== null || el.tagName === 'IFRAME')) { selMatch = sel; break }
        } catch {}
      }
      if (!selMatch) continue
      return { detected: true, code, severity: rule.severity, textSignal: textMatch, selectorSignal: selMatch }
    }
  } catch (err) {
    console.warn('[Orion content] bannerCheck error:', err.message)
  }
  return { detected: false }
}

// v0.9.3: LinkedIn antepone modales de UPSELL (Sales Navigator / Premium) sobre el
// composer de /messaging/compose → tapan el editor y rompen send_followup (el bot no
// puede teclear → typing_complete_timeout). NO son security checks (no abortar): se
// cierran con el botón X (o ESC) y se continúa. Devuelve true si cerró alguno.
function dismissUpsellModals() {
  let dismissed = false
  try {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .artdeco-modal'))
    for (const d of dialogs) {
      if (d.offsetParent === null) continue
      const txt = (d.textContent || '').toLowerCase()
      const isUpsell =
        /sales\s*navigator|premium/.test(txt) &&
        /descuento|mensajes a cualquier|más eficaz|cancela en cualquier|prueba gratis|free trial|upgrade|inmail|relaciones con clientes/.test(txt)
      if (!isUpsell) continue
      const close =
        d.querySelector('button[aria-label*="cerrar" i], button[aria-label*="close" i], button[aria-label*="descartar" i], button[aria-label*="dismiss" i], .artdeco-modal__dismiss') ||
        Array.from(d.querySelectorAll('button')).find(b =>
          b.offsetParent !== null &&
          (b.querySelector('svg[data-test-icon*="close"], use[href*="close"]') || /^[\s✕×x]+$/.test((b.textContent || '').trim())))
      if (close) {
        close.click(); dismissed = true
        console.warn('[Orion content] upsell modal (Sales Navigator/Premium) cerrado')
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }))
        dismissed = true
      }
    }
  } catch (e) {
    console.warn('[Orion content] dismissUpsellModals error:', e?.message)
  }
  return dismissed
}

async function executeAction(action, payload) {
  // v0.7.16 pre-flight: detecta banners de seguridad LinkedIn ANTES de cualquier acción.
  // Skip para capture_session (no toca LinkedIn DOM normal).
  if (action !== 'capture_session') {
    const banner = checkBannersBeforeExecute()
    if (banner.detected) {
      console.warn(`[Orion content] BANNER PRE-FLIGHT: ${banner.code} (${banner.severity}) — abort ${action}`)
      try { vlOnPhaseTimeout(`banner_${banner.code}`) } catch {}
      // Error code estandarizado consumido por bridge handler.
      return {
        status: 'error',
        error: `linkedin_security_check`,
        bannerCode: banner.code,
        bannerSeverity: banner.severity,
        textSignal: banner.textSignal,
        selectorSignal: banner.selectorSignal,
      }
    }
    // v0.9.3: cerrar modales de upsell (Sales Navigator/Premium) que tapan el composer.
    try { dismissUpsellModals() } catch {}
  }
  switch (action) {
    case 'check_inbox':
      return await checkInbox(payload)
    case 'check_sent_invites':
      return await checkSentInvites(payload)
    case 'check_connections':
      return await checkConnections(payload)
    case 'send_invite':
      return await sendInvite(payload)
    case 'send_followup':
      return await sendFollowup(payload)
    case 'search':
      return await (payload?.searchMode === 'sales_navigator'
        ? scrapeSalesNavPeople(payload)
        : searchLeads(payload))
    case 'search_posts':
      return await searchPosts(payload)
    case 'resolve_company':
      return await resolveCompanyOnPage(payload)
    case 'comment_on_post':
      return await commentOnPost(payload)
    case 'publish_post':
      return await publishPost(payload)
    case 'capture_session':
      return await captureSession()
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}

// ── 2.6 — captura inicial de sesión ─────────────────────────────────────────
// Cuando el usuario instala la extension y se autentica, server pide capture_session.
// El extension lee todas las cookies de linkedin.com + fingerprint y las manda.

async function captureSession() {
  // Cookies se leen en el background con chrome.cookies (mejor permisos)
  // Aquí capturamos el fingerprint del browser real
  return {
    fingerprint: {
      userAgent:       navigator.userAgent,
      platform:        navigator.platform,
      languages:       Array.from(navigator.languages || []),
      locale:          navigator.language,
      viewport:        { width: window.innerWidth, height: window.innerHeight },
      screen:          { width: screen.width, height: screen.height, depth: screen.colorDepth },
      timezone:        Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffset:  new Date().getTimezoneOffset(),
      deviceMemory:    navigator.deviceMemory,
      hardwareConcurrency: navigator.hardwareConcurrency,
      // WebGL fingerprint (opcional, requiere canvas)
      webgl: getWebGLInfo(),
    },
    capturedAt: new Date().toISOString(),
    currentUrl: window.location.href,
  }
}

function getWebGLInfo() {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
    if (!gl) return null
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    return {
      vendor:   dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    }
  } catch { return null }
}

// ── 2.2 — check_inbox REAL — scrape /messaging/ ────────────────────────────
//
// Estrategia: si no estamos en /messaging/, navegamos. Esperamos lista cargada.
// Scrape DOM con múltiples selectores (LinkedIn rota selectors, fallbacks).
// Retornamos array normalizado: [{name, snippet, unread, threadUrl, threadId, lastActivity}]

async function checkInbox(payload = {}) {
  let _captureStoppedFlag = false  // v0.7.23 BUG-O: true si captureThreads cortó por budget
  const deepScrape = !!payload.deepScrape
  const daysWindow = Math.min(payload.daysWindow ?? 15, 90)  // window in days para deepScrape
  const limit = deepScrape ? 500 : Math.min(payload.limit ?? 30, 50)
  console.log(`[Orion content] checkInbox: deepScrape=${deepScrape} daysWindow=${daysWindow} limit=${limit}, currentUrl=${location.href}`)

  // 1. Verificar que estamos en /messaging/ (si no, error rápido — la auto-navegación
  // mata el content.js antes de responder; navegación se hará en background.js futuro)
  if (!location.pathname.startsWith('/messaging')) {
    return {
      action: 'check_inbox',
      status: 'error',
      error:  'not_on_messaging_page',
      currentUrl: location.href,
      note:   'Abre https://www.linkedin.com/messaging/ en la pestaña y vuelve a ejecutar',
    }
  }

  // 2. Esperar a que el contenedor de conversaciones aparezca
  // v0.7.20: pool ampliado con fallbacks defensivos contra selector drift LinkedIn
  const containerSel = [
    '.msg-conversations-container__conversations-list',
    '.msg-conversations-container',
    '[class*="msg-conversations-container"]',
    'ul[class*="conversations-list"]',
    '[class*="msg-conversation-list"]',
    'aside[aria-label*="essag" i]',
    'aside[aria-label*="ist" i] ul',
    'main[role="main"] ul[role="list"]',
    '[data-test-msg-conversations-container]',
  ]
  const containerFound = await waitForSelector(containerSel, 15000)
  if (!containerFound) {
    // v0.7.20: enriquecer error con DOM debug para L6 ticket sin necesidad de re-run
    const bodyClasses = document.body?.className?.slice(0, 200) ?? ''
    const ulSample = Array.from(document.querySelectorAll('ul, aside')).slice(0, 5).map(el => ({
      tag: el.tagName.toLowerCase(),
      cls: (el.className ?? '').slice(0, 150),
      al:  el.getAttribute('aria-label')?.slice(0, 80) ?? null,
      childCount: el.children?.length ?? 0,
    }))
    return {
      action: 'check_inbox',
      status: 'error',
      error: 'conversations_container_not_found',
      url: location.href,
      debugSample: { bodyClasses, ulSample },
    }
  }

  // Pequeña pausa para hidratación tardía
  await sleep(1200)

  // 3. Scrape items
  const itemSelectors = [
    'li.msg-conversation-listitem',
    'li[class*="msg-conversation-listitem"]',
    '.msg-conversations-container__conversations-list li',
    'ul[class*="conversations-list"] > li',
  ]
  const getItems = () => {
    for (const sel of itemSelectors) {
      const arr = Array.from(document.querySelectorAll(sel))
      if (arr.length > 0) return arr
    }
    return []
  }
  let items = getItems()
  if (items.length === 0) {
    return { action: 'check_inbox', status: 'empty', conversations: [], url: location.href, note: 'No conversation items found in DOM' }
  }

  // 3b. Si deepScrape: scroll el contenedor para cargar conversaciones más viejas
  // hasta que cubramos daysWindow O no carguen más items (máx 30 scrolls).
  if (deepScrape) {
    const scrollContainer = document.querySelector(
      '.msg-conversations-container__conversations-list, ul[class*="conversations-list"]'
    ) ?? document.querySelector('.msg-conversations-container')
    if (scrollContainer) {
      let prevCount = items.length
      let stagnant = 0
      const maxScrolls = 30
      for (let i = 0; i < maxScrolls; i++) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight
        await sleep(randInt(800, 1400))  // espera lazy-load
        items = getItems()
        console.log(`[Orion content] deepScrape: scroll ${i+1}/${maxScrolls} → ${items.length} items`)
        if (items.length === prevCount) {
          stagnant++
          if (stagnant >= 3) { console.log('[Orion content] deepScrape: no new items, stop'); break }
        } else {
          stagnant = 0
          prevCount = items.length
        }
        if (items.length >= limit) { console.log('[Orion content] deepScrape: limit alcanzado'); break }
      }
    }
  }

  console.log(`[Orion content] ${items.length} conversation items detectados (deepScrape=${deepScrape})`)

  // 4. Normalizar cada item (guardamos referencia al DOM para click-capture)
  const conversations = []
  const itemByName = new Map()
  for (const el of items.slice(0, limit)) {
    const parsed = parseConversationItem(el)
    if (parsed) {
      conversations.push(parsed)
      if (parsed.name) itemByName.set(parsed.name, el)
    }
  }

  // 4b. CLICK-CAPTURE de thread_id (P-C): LinkedIn ya NO expone el thread_id en
  // el DOM del inbox (es estado React interno). La única forma confiable de
  // obtenerlo es CLICKEAR la conversación → la URL cambia a /messaging/thread/<id>/.
  // Lo hacemos solo para conversaciones sin threadId (prioriza unread), capeado
  // y humanizado para no parecer bot.
  if (payload.captureThreads) {
    // v0.7.43: priorizar conversaciones INBOUND (el contacto escribió último → necesitan
    // thread_id para auto-reply) sobre outbound (ya respondimos). Antes ordenaba SOLO por
    // unread, así que un inbound ya leído (unread=0, p.ej. el usuario lo abrió sin contestar)
    // caía fuera del budget → su thread_id nunca se capturaba → quedaba como orphan sin
    // respuesta (caso Bernardo / Pedro Ramírez / Natalia). Ahora: inbound primero, luego unread.
    const needCapture = conversations
      .filter(c => !c.threadId)
      .map(c => ({ c, inbound: isInboundSnippet(c.snippet) }))
      .sort((a, b) =>
        (Number(b.inbound) - Number(a.inbound)) ||         // inbound primero
        ((b.c.unread ?? 0) - (a.c.unread ?? 0))            // luego unread
      )
      .map(x => x.c)
      // v0.7.46 ANTI-THROTTLE: si la tab está OCULTA, Chrome throttlea los sleeps de cada
      // captura (URL-wait + scroll + post-capture → 120-180s c/u en intensive throttling) →
      // 1-2 capturas revientan el hard timeout (~207s) → check_inbox pierde TODO el scrape
      // (replies/accepts incluidos), y NO emite micro_phases (se ve como cuelgue, fases:0).
      // Bajo throttle SALTAMOS capturas: el scrape de convos (DOM sync) igual detecta
      // replies/accepts; los thread_ids se capturan en el próximo check con foco o el deep
      // sweep 1×/día. Una check_inbox que COMPLETA >> una que hace timeout y pierde todo.
      .slice(0, document.hidden ? 0 : Math.min(payload.maxCaptures ?? 12, 20))
    if (document.hidden) console.warn('[Orion content] captureThreads: tab OCULTA → SKIP capturas (anti-throttle); scrape igual corre')
    console.log(`[Orion content] captureThreads: ${needCapture.length} conversaciones sin threadId`)
    // v0.7.23 BUG-O: budget de tiempo. En horas pesadas CDMX cada capture toma
    // 11-12s (era 9s estimado) → 15 captures pueden exceder el hard timeout y
    // PERDER TODO el inbox (timeout = result vacío). Derivamos el budget del mismo
    // hard timeout (calcHardTimeout check_inbox) menos 55s de overhead (setup +
    // scroll + parse + return), y cortamos al alcanzarlo retornando parciales.
    const _capN = payload?.captureThreads ? (payload?.maxCaptures ?? 12) : 0
    const _lim = payload?.limit ?? 20
    const _hardMs = Math.max(60_000, Math.min(300_000, 60_000 + (_capN * 9_000) + (Math.ceil(_lim / 10) * 4_000)))
    const captureBudgetMs = Math.max(30_000, _hardMs - 55_000)
    const captureStart = Date.now()
    let captureStopped = false
    for (const convo of needCapture) {
      if (Date.now() - captureStart > captureBudgetMs) {
        console.warn(`[Orion content] captureThreads: budget ${Math.round(captureBudgetMs/1000)}s agotado tras ${needCapture.indexOf(convo)} captures — retorno parcial`)
        captureStopped = true
        break
      }
      const el = itemByName.get(convo.name)
      if (!el) continue
      const clickable = el.querySelector(
        '.msg-conversation-listitem__link, [class*="convo-item-link"]'
      ) ?? el
      try {
        // BUG fix crítico: capturar URL ANTES del click. Si LinkedIn ignora el click
        // sintético (isTrusted=false en anchors SPA), la URL NO cambia y el código
        // anterior asignaba el thread_id de la conversación previa al convo actual
        // → orphans con thread_ids cruzados → mensajes a leads equivocados.
        const beforeUrl = location.href
        const beforeThread = beforeUrl.match(/\/messaging\/thread\/([^/?#]+)/)?.[1] ?? null
        clickable.scrollIntoView({ block: 'center', behavior: 'instant' })
        await sleep(randInt(250, 600))
        clickable.click()
        // Esperar a que la URL CAMBIE — no basta que tenga "/thread/" (podría ser la
        // anterior si el click no funcionó). Verificar (a) URL distinta a beforeUrl
        // Y (b) thread_id distinto al previo.
        const start = Date.now()
        let captured = false
        while (Date.now() - start < 4000) {
          const currentUrl = location.href
          const m = currentUrl.match(/\/messaging\/thread\/([^/?#]+)/)
          if (m && currentUrl !== beforeUrl && m[1] !== beforeThread) {
            convo.threadId = decodeURIComponent(m[1])
            convo.threadUrl = currentUrl.split('?')[0]
            captured = true
            // v0.7.39: el thread está ABIERTO → capturar profileUrl del participante
            // desde el HEADER (insight #553: el list-item SDUI no expone /in/). Scoped
            // al título/top-bar; null si no matchea (sin regresión). SIN sleep extra
            // (el header ya está al cambiar la URL) — un sleep aquí se throttlea a ~1s
            // en background tab y reventaba el hard-timeout de check_inbox (v0.7.39a).
            try {
              const hdr = document.querySelector(
                '.msg-title-bar a[href*="/in/"], .msg-thread__top-bar a[href*="/in/"], ' +
                '[class*="title-bar"] a[href*="/in/"], [class*="thread-header"] a[href*="/in/"], ' +
                '[class*="msg-entity-lockup"] a[href*="/in/"]'
              )
              if (hdr) {
                const h = hdr.getAttribute('href') || ''
                if (h.includes('/in/')) convo.profileUrl = (hdr.href || `https://www.linkedin.com${h}`).split('?')[0]
              }
            } catch {}
            break
          }
          await sleep(300)
        }
        if (!captured) {
          console.warn(`[Orion content] captureThreads: NO cambio de URL para ${convo.name} (click ignorado, prob. isTrusted=false). Skip — no cruzar threadId.`)
        }
        await sleep(randInt(400, 900))  // dwell humano
      } catch (err) {
        console.warn(`[Orion content] captureThreads click falló para ${convo.name}:`, err?.message)
      }
    }
    const captured = needCapture.filter(c => c.threadId).length
    console.log(`[Orion content] captureThreads: ${captured}/${needCapture.length} thread_ids capturados${captureStopped ? ' (PARCIAL — budget agotado)' : ''}`)
    if (captureStopped) _captureStoppedFlag = true
  }

  // 5. Debug enriquecido v0.7.17: si threadId-null > 50% OR profileUrl-null > 50%,
  // capturamos sample profundo del primer item para L6 visual ticket.
  const total = conversations.length
  const threadIdNullPct = total > 0 ? (conversations.filter(c => !c.threadId).length / total) * 100 : 0
  const profileUrlNullPct = total > 0 ? (conversations.filter(c => !c.profileUrl).length / total) * 100 : 0
  const triggerDebug = total > 0 && (threadIdNullPct > 50 || profileUrlNullPct > 50)
  const debugSample = triggerDebug && items[0] ? {
    outerHTML: items[0].outerHTML.slice(0, 1500),
    attrs: Array.from(items[0].attributes).map(a => ({ name: a.name, value: a.value.slice(0, 120) })),
    linkHrefs: Array.from(items[0].querySelectorAll('a[href]')).map(a => a.href).slice(0, 5),
    dataHrefs: Array.from(items[0].querySelectorAll('[data-href]')).map(d => d.getAttribute('data-href')).slice(0, 5),
    dataAttrs: Array.from(items[0].querySelectorAll('[data-conversation-urn], [data-urn], [data-conversation-id], [data-thread-id], [data-test-conversation-urn], [data-app-aware-link]')).map(d => {
      const out = {}
      for (const a of d.attributes) if (a.name.startsWith('data-')) out[a.name] = a.value.slice(0, 120)
      return out
    }).slice(0, 5),
    dropRates: {
      threadId_null_pct: Math.round(threadIdNullPct),
      profileUrl_null_pct: Math.round(profileUrlNullPct),
      sample_size: total,
    },
  } : null

  return {
    action: 'check_inbox',
    status: 'ok',
    conversations,
    scrapedAt: new Date().toISOString(),
    url: location.href,
    ...(debugSample ? { debugSample } : {}),
    ...(_captureStoppedFlag ? { capturePartial: true } : {}),
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function waitForSelector(selectors, timeoutMs = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    for (const sel of (Array.isArray(selectors) ? selectors : [selectors])) {
      if (document.querySelector(sel)) return sel
    }
    await sleep(300)
  }
  return null
}

function textOf(el, ...selectors) {
  for (const sel of selectors) {
    const found = el.querySelector(sel)
    if (found?.textContent) return found.textContent.trim().replace(/\s+/g, ' ')
  }
  return null
}

// v0.7.43: detecta conversaciones GRUPALES (3+ personas) en la tarjeta del inbox.
// Doble señal: (1) patrón del nombre — LinkedIn incluye "y tú"/"and you"/"y N más"/
// "+N" o varios nombres separados por coma; (2) facepile con >1 avatar distinto.
// Cualquiera de las dos dispara. Un 1:1 NUNCA muestra "y tú" ni stack de avatares.
function detectGroupConversation(el, name) {
  const n = (name ?? '').trim()
  if (
    /\sy\s+t[úu]\b/i.test(n) ||
    /\sand\s+you\b/i.test(n) ||
    /\sy\s+\d+\s+m[áa]s\b/i.test(n) ||
    /\sand\s+\d+\s+other/i.test(n) ||
    /,\s*\+\d+/.test(n) ||
    (/,/.test(n) && /\s(?:y|and)\s/i.test(n))
  ) return true
  try {
    const avatars = el.querySelectorAll(
      '.msg-facepile-grid img, [class*="facepile"] img, .presence-entity__image, img[class*="presence-entity"]'
    )
    const srcs = new Set(
      Array.from(avatars).map(a => a.getAttribute('src')).filter(Boolean)
    )
    if (srcs.size > 1) return true
  } catch {}
  return false
}

// v0.7.43: ¿el snippet de la conversación es INBOUND (el contacto escribió último)?
// Outbound si arranca con "Tú:"/"Tu:"/"You:" (nosotros escribimos último). Usado para
// priorizar la captura de thread_id hacia conversaciones que necesitan auto-reply.
function isInboundSnippet(snippet) {
  const s = (snippet ?? '').trim()
  if (!s) return false
  return !/^(\[?\s*t[úu]\s*\]?|you)\s*:/i.test(s)
}

function parseConversationItem(el) {
  try {
    // Nombre del lead
    const name = textOf(el,
      '.msg-conversation-listitem__participant-names',
      '.msg-conversation-card__participant-names',
      '[class*="participant-names"]',
      'h3[class*="participant"]',
    )
    if (!name) return null

    // Último mensaje preview
    const snippet = textOf(el,
      '.msg-conversation-card__message-snippet',
      '.msg-conversation-listitem__message-snippet',
      '[class*="message-snippet"]',
      'p[class*="msg-conversation"]',
    )

    // Unread badge
    const unreadEl = el.querySelector(
      '.notification-badge--show, .notification-badge .notification-badge__count, [class*="notification-badge"]:not([class*="hidden"])'
    )
    let unread = 0
    if (unreadEl) {
      const txt = unreadEl.textContent?.trim() ?? ''
      unread = parseInt(txt) || (unreadEl ? 1 : 0)
    }

    // Timestamp visible
    const time = textOf(el,
      '.msg-conversation-listitem__time-stamp',
      'time[class*="msg-conversation"]',
      '[class*="time-stamp"]',
    )

    // ── Thread ID extraction ─────────────────────────────────────────────
    // LinkedIn embebe el URN/threadId en varios lugares — buscamos en orden:
    //   1. data-conversation-urn / data-urn / id en el LI o descendientes
    //   2. href de cualquier <a> que contenga /messaging/thread/
    //   3. Atributo data-control-name o similares con thread reference
    let threadId = null
    let threadUrl = null

    // (1) data attributes en el item o cualquier descendiente — pool ampliado v0.7.17
    // Inbox parser drift 2026-06-02: LinkedIn migró __link de <a> a <div tabindex=0>
    // → linkHrefs=[]. Buscamos data-attrs en TODOS los descendientes, no solo el li.
    const dataAttrs = [
      'data-conversation-urn',
      'data-urn',
      'data-conversation-id',
      'data-thread-id',
      'data-test-conversation-urn',
      'data-app-aware-link',
      'data-control-id',
    ]
    for (const attr of dataAttrs) {
      const direct = el.getAttribute(attr)
      const descendantEls = el.querySelectorAll(`[${attr}]`)
      const candidates = [direct, ...Array.from(descendantEls).map(d => d.getAttribute(attr))].filter(Boolean)
      for (const found of candidates) {
        const m = found.match(/2-[A-Za-z0-9_=-]{16,}/)
        if (m) { threadId = m[0]; break }
      }
      if (threadId) break
    }

    // (2) href de links que matchean /messaging/thread/<id>/ — busca también data-href (lazy anchors)
    if (!threadId) {
      const linkEls = el.querySelectorAll('a[href], [data-href], a[data-test-app-aware-link]')
      for (const linkEl of linkEls) {
        const href = linkEl.getAttribute('href') ?? linkEl.getAttribute('data-href') ?? ''
        const m = href.match(/\/messaging\/thread\/([^/?#]+)/)
        if (m) {
          threadId = decodeURIComponent(m[1])
          threadUrl = linkEl.href || `https://www.linkedin.com/messaging/thread/${threadId}/`
          break
        }
      }
    }

    // (3) NEW v0.7.17: scan outerHTML por pattern urn:li:fsd_conversation o thread urn
    // como ULTIMO RECURSO antes de marcarlo null. LinkedIn embebe URNs en React props.
    if (!threadId) {
      try {
        // v0.7.20: cap a 50KB para evitar regex lento sobre items con props React grandes
        const html = (el.outerHTML ?? '').slice(0, 50000)
        // urn:li:fsd_conversation:(urn:li:fsd_profile:...,2-<id>) o solo 2-<id>=
        const m = html.match(/(?:fsd_conversation|msg_conversation|conversation_urn)[^"']{0,500}?(2-[A-Za-z0-9_=-]{16,})/)
        if (m) threadId = m[1]
      } catch {}
    }
    // Construir threadUrl si tenemos threadId pero no URL
    if (threadId && !threadUrl) {
      threadUrl = `https://www.linkedin.com/messaging/thread/${threadId}/`
    }

    // ── Profile URL del otro participante ────────────────────────────────
    // v0.7.17 fallback: en el listing puede no aparecer; LinkedIn ahora suele
    // poner /in/ slug en avatar img wrapper o aria-label. Buscamos:
    //   (a) <a href*="/in/"> directo
    //   (b) [data-href*="/in/"]
    //   (c) URN fsd_profile en outerHTML → derivar /in/ no posible (URN ≠ slug)
    //       — pero al menos capturamos URN para que server-side haga lookup
    let profileUrl = null
    let profileUrn = null
    const profileLinks = el.querySelectorAll('a[href*="/in/"], [data-href*="/in/"]')
    for (const pl of profileLinks) {
      const href = pl.getAttribute('href') ?? pl.getAttribute('data-href') ?? ''
      if (href.includes('/in/')) {
        profileUrl = pl.href || `https://www.linkedin.com${href}`
        break
      }
    }
    if (!profileUrl) {
      try {
        // v0.7.20: cap a 50KB preventivo
        const html = (el.outerHTML ?? '').slice(0, 50000)
        const urnMatch = html.match(/urn:li:fsd_profile:([A-Za-z0-9_=-]{1,200})/)
        if (urnMatch) profileUrn = urnMatch[1]
      } catch {}
    }

    // ── Conversación GRUPAL (3+ personas) ────────────────────────────────
    // v0.7.43: LinkedIn nombra los grupos "A, B y tú" / "A, B y N más" / "A, +N"
    // y muestra un facepile con múltiples avatares. NO son leads 1:1 — el
    // auto-reply mezcla el contexto de varios participantes y confunde al AI
    // (caso Yatin+Rajveer: respondió dirigiéndose al dueño de la cuenta con
    // contexto de otra conversación). Se marcan isGroup → el bridge los skipea.
    const isGroup = detectGroupConversation(el, name)

    return {
      name,
      snippet:    snippet ? snippet.slice(0, 250) : null,
      unread,
      time,           // texto crudo: "1 min", "Yesterday", "20 may"
      threadId,
      threadUrl,
      profileUrl,
      profileUrn,     // v0.7.17: fallback URN para lookup server-side
      isGroup,        // v0.7.43: true si es conversación grupal (3+ personas)
    }
  } catch (err) {
    console.warn('[Orion content] parse error:', err.message)
    return null
  }
}

// ── 2.3 — send_invite REAL ──────────────────────────────────────────────────
//
// Payload: {
//   profileUrl: 'https://www.linkedin.com/in/<slug>/',
//   message:    '<AI-generated note>',  // opcional — si null, intenta send-without-note
//   leadName:   '...',                  // para verificar que estamos en el perfil correcto
//   dryRun:     true|false              // si true, no clickea Send final
// }
//
// El background.js ya navegó la tab al profileUrl antes de llamarnos.
// Aquí solo: detect Connect → click → modal → fill note → click Send.

// Fase 2b (SalesNav): vuelca el DOM de acciones de la página de lead SalesNav (botones,
// aria-labels, data-control-name, menús) SIN clickear nada — para localizar "Conectar" y
// construir el flujo real en v4. Cuenta real → probe read-only, cero riesgo.
function salesNavInvitePageProbe() {
  const vis = el => el.offsetParent !== null
  const clickables = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], [role="menuitem"], li[role="menuitem"]'))
    .filter(vis)
    .map(el => ({
      tag:  el.tagName.toLowerCase(),
      txt:  (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 45),
      aria: (el.getAttribute('aria-label') || '').slice(0, 55),
      dcn:  el.getAttribute('data-control-name') || '',
    }))
    .filter(b => b.txt || b.aria)
    .slice(0, 45)
  const connectish = clickables.filter(b => /conectar|connect|invitar|invite|m[áa]s|more|acciones|actions/i.test(b.txt + ' ' + b.aria))
  return {
    url:         location.href.slice(0, 140),
    onSalesLead: /\/sales\/lead\//.test(location.pathname),
    buttonCount: document.querySelectorAll('button').length,
    connectish,
    clickables,
    bodySnippet: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 250),
  }
}

// Fase 2b v4 — invita desde la página de lead SalesNav. El "Conectar" vive en el menú "…"
// (aria "Abrir el menú de exceso de acciones"). Flujo: dismiss popups → abrir "…" → click
// "Conectar" → modal → "Enviar" (sin nota). SELECTORES ESTRICTOS + dump-y-aborta en cada
// fallo: NUNCA clickea algo que no sea Conectar/Enviar → cero mis-clicks en cuenta real.
async function sendInviteSalesNav(payload = {}) {
  // v7: SalesNav "Conectar" pide EMAIL para leads 2do-grado fríos (gate anti-spam de SalesNav,
  // empuja a InMail) → NO se puede conectar desde aquí sin el correo. En su lugar RESOLVEMOS el
  // /in/ público del lead y lo devolvemos; el bridge actualiza leads.linkedin_url y el próximo
  // tick invita desde el perfil PÚBLICO (flujo free, que SÍ funciona, sin muro de email) — y el
  // FU/auto-reply también funcionan al tener /in/. SalesNav queda como fuente de BÚSQUEDA.
  console.log(`[Orion content] sendInviteSalesNav(v7 resolve /in/): url=${location.href}`)
  if (payload.dryRun) return { ok: true, action: 'send_invite', status: 'dry_run', path: 'salesnav_resolve' }

  await waitForSelector(['a[href*="/in/"]', 'button[aria-label*="exceso de acciones"]', 'main'], 12000)
  await sleep(randInt(1500, 2500))

  const grabIn = () => {
    for (const a of Array.from(document.querySelectorAll('a[href*="/in/"]'))) {
      const href = a.getAttribute('href') || ''
      const full = href.startsWith('http') ? href : `https://www.linkedin.com${href}`
      const u = full.split('?')[0].replace(/\/$/, '') + '/'
      if (/linkedin\.com\/in\//.test(u)) return u
    }
    return null
  }

  // 1) /in/ directo en la página del lead ("Ver perfil de LinkedIn").
  let inUrl = grabIn()

  // 2) si no está visible, abrir el menú "…" (ahí suele estar "Ver perfil de LinkedIn").
  if (!inUrl) {
    const overflow = Array.from(document.querySelectorAll('button'))
      .find(b => b.offsetParent !== null && /exceso de acciones|overflow|more actions|más acciones/i.test(b.getAttribute('aria-label') || ''))
    if (overflow) {
      await humanClick(overflow)
      await sleep(randInt(900, 1500))
      inUrl = grabIn()
    }
  }

  if (inUrl) {
    // v7-C: resolve + invite EN UN SOLO COMANDO. Redirigimos al SPA route de invite del perfil
    // PÚBLICO (/preload/custom-invite/, el path free confiable) → background re-navega + re-
    // despacha → corre el sendInvite free en /in/ (invite REAL, sin el muro de email de SalesNav).
    // `resolvedInUrl` viaja para que el bridge persista linkedin_url=/in/ (así el FU funciona).
    // Antes (v7-A) esto gastaba 2 slots de gap (resolve, luego invite); ahora 1 solo.
    const vanity = (inUrl.match(/\/in\/([^/?]+)/) || [])[1]
    const redirectUrl = vanity
      ? `https://www.linkedin.com/preload/custom-invite/?vanityName=${vanity}`
      : inUrl
    return { ok: true, action: 'send_invite', status: 'needs_redirect', redirectUrl, resolvedInUrl: inUrl, currentUrl: location.href }
  }

  // Sin /in/ → NO mentir "sent"; dump para afinar de dónde sacar el perfil público.
  return { ok: false, action: 'send_invite', status: 'error', error: 'salesnav_public_profile_not_found',
    currentUrl: location.href, debugSample: salesNavInvitePageProbe() }
}

// Dump del dropdown "…" abierto (para afinar el item "Conectar" si el selector falla).
function salesNavMenuProbe() {
  const items = Array.from(document.querySelectorAll('[role="menuitem"], .artdeco-dropdown__item, [role="menu"] button, [role="menu"] li, ul li'))
    .filter(el => el.offsetParent !== null)
    .map(el => ({ txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 45), aria: (el.getAttribute('aria-label') || '').slice(0, 50), dcn: el.getAttribute('data-control-name') || '' }))
    .filter(i => i.txt || i.aria).slice(0, 30)
  return { url: location.href.slice(0, 120),
    dropdownsOpen: document.querySelectorAll('.artdeco-dropdown__content--is-open, [role="menu"]').length,
    menuItems: items, bodySnippet: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 250) }
}

async function sendInvite(payload = {}) {
  const { profileUrl, message, leadName, dryRun } = payload
  console.log(`[Orion content] sendInvite: profile=${profileUrl}, dryRun=${dryRun}, currentUrl=${location.href}`)

  // ── Fase 2b/v7 (SalesNav): lead Pro con URL /sales/lead/<token>. Resolvemos su /in/ público y
  // redirigimos al SPA route de invite (v7-C). CHEQUEA location.pathname (NO el payload): tras el
  // redirect la location ya es /preload/custom-invite/ o /in/ → NO re-entra aquí → corre el path
  // free normal. El path free queda 100% intacto. ──
  if (/\/sales\/lead\//.test(location.pathname)) {
    return await sendInviteSalesNav(payload)
  }

  // ── PATH A: SPA route /preload/custom-invite/ — modal abre AUTO al cargar ──
  // Background.js nos trae aquí directamente para evitar el click problemático
  // del Conectar anchor (event.isTrusted filter de LinkedIn).
  if (location.href.includes('/preload/custom-invite/')) {
    return await sendInviteFromCustomInvite(payload)
  }

  // PATH B (fallback): perfil normal /in/<vanity>/ — usamos click logic
  if (!location.href.includes('linkedin.com/in/')) {
    return { action: 'send_invite', status: 'error', error: 'not_on_profile_page', currentUrl: location.href }
  }

  // 2. Captcha/checkpoint check
  if (/\/checkpoint|\/challenge|\/authwall/.test(location.href)) {
    return { action: 'send_invite', status: 'error', error: 'captcha_or_checkpoint', currentUrl: location.href }
  }

  // 3. Esperar a que el profile cargue
  await waitForSelector(['.pv-top-card', 'main', 'h1'], 12000)
  await sleep(1500)

  // 4. Verificar nombre del lead aparece en el profile (sanity check)
  if (leadName) {
    const h1Text = document.querySelector('h1')?.textContent?.trim() ?? ''
    const firstName = leadName.split(/\s+/)[0].toLowerCase()
    if (h1Text && !h1Text.toLowerCase().includes(firstName)) {
      console.warn(`[Orion content] Nombre mismatch: esperado="${firstName}", h1="${h1Text}"`)
      // No abortamos — el perfil puede tener nombre con diferente formato. Solo warning.
    }
  }

  // 5. Buscar botón Connect — primero directo, después en overflow "Más"
  let connectBtn = findConnectButton()
  if (!connectBtn) {
    // Tal vez ya están conectados (botón dice "Message" en lugar de "Connect")
    const msgBtn = findMessageButton()
    if (msgBtn) {
      return { action: 'send_invite', status: 'already_connected', note: 'Botón Message visible — ya hay conexión' }
    }
    // Intentar abrir el overflow "Más" buscando Conectar adentro
    console.log('[Orion content] Connect directo no encontrado — intentando overflow Más')
    const overflowBtn = findOverflowButton()
    if (overflowBtn) {
      await humanClick(overflowBtn)
      await sleep(randInt(600, 1100))
      connectBtn = findConnectInOverflow()
      if (!connectBtn) {
        return {
          action: 'send_invite',
          status: 'error',
          error:  'no_connect_option',
          note:   'Perfil sin opción de conectar (solo Follow). Posiblemente restringido o ya invitado.',
          visibleBtns: listVisibleButtons(),
          dropdownItems: dumpOverflowDropdown(),
        }
      }
      console.log('[Orion content] ✓ Conectar encontrado en overflow')
      // (verificado que en este perfil NO triggerea Quick Connect — abre modal)
    } else {
      // Debug profundo: listar todos los "Más" buttons con sus posiciones
      const masButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(b => {
          const t = (b.textContent ?? '').trim().toLowerCase()
          const aria = (b.getAttribute('aria-label') ?? '').toLowerCase()
          return (t === 'más' || t === 'more' || /más|more/i.test(aria)) && b.offsetParent !== null
        })
        .slice(0, 10)
        .map(b => {
          const r = b.getBoundingClientRect()
          return {
            text:   (b.textContent ?? '').trim().slice(0, 30),
            aria:   (b.getAttribute('aria-label') ?? '').slice(0, 50),
            top:    Math.round(r.top),
            left:   Math.round(r.left),
            inNav:  !!b.closest('nav, .global-nav'),
          }
        })

      return {
        action: 'send_invite',
        status: 'error',
        error:  'connect_button_not_found',
        visibleBtns: listVisibleButtons(),
        masButtons,
      }
    }
  }

  // 6. Click Connect (human-like) + debug info exhaustivo
  const connectBtnInfo = {
    tag:    connectBtn.tagName,
    role:   connectBtn.getAttribute?.('role') ?? '',
    text:   (connectBtn.textContent ?? '').trim().slice(0, 40),
    aria:   (connectBtn.getAttribute?.('aria-label') ?? '').slice(0, 50),
    href:   connectBtn.getAttribute?.('href') ?? '',
    classes: (connectBtn.className ?? '').slice(0, 100),
    outerHTML: connectBtn.outerHTML.slice(0, 400),
  }

  // Snapshot ANTES del click: número de dialogs/textareas/overlays
  const before = {
    dialogs:   document.querySelectorAll('[role="dialog"], .artdeco-modal').length,
    textareas: document.querySelectorAll('textarea, [contenteditable="true"]').length,
    bodyKids:  document.body.children.length,
  }

  console.log('[Orion content] Clicking Connect:', connectBtnInfo)
  await humanClick(connectBtn)
  await sleep(randInt(1500, 2200))

  // Snapshot tras click native
  let afterNative = {
    dialogs:   document.querySelectorAll('[role="dialog"], .artdeco-modal').length,
    textareas: document.querySelectorAll('textarea, [contenteditable="true"]').length,
    bodyKids:  document.body.children.length,
    url:       location.href,
  }
  console.log('[Orion content] After native click:', afterNative)

  // FALLBACK: si no abrió modal (anchors con href de SPA route a veces no
  // responden a click sintético), intentar activación vía teclado Enter.
  if (afterNative.dialogs === before.dialogs && afterNative.bodyKids === before.bodyKids) {
    console.log('[Orion content] Native click no triggea modal — fallback Enter key')
    await activateViaKeyboard(connectBtn)
    await sleep(randInt(1500, 2500))
  }

  // Snapshot final
  const after = {
    dialogs:   document.querySelectorAll('[role="dialog"], .artdeco-modal').length,
    textareas: document.querySelectorAll('textarea, [contenteditable="true"]').length,
    bodyKids:  document.body.children.length,
    url:       location.href,
  }
  console.log('[Orion content] Final after:', after)
  connectBtnInfo.beforeClick  = before
  connectBtnInfo.afterClick   = after
  connectBtnInfo.afterNative  = afterNative

  // 7. Capturar response URN/threadId de la red — listener antes de Send
  const capturedThreadIds = []
  const fetchOrig = window.fetch  // (no podemos override fetch desde content world reliably)
  // En content.js no podemos interceptar fetch del page. Saltamos por ahora.

  // 8. Modal aparece. Esperamos que se renderice + buscamos textarea/add-note.
  await sleep(randInt(800, 1400))  // hidratación del modal

  let textareaUsed = false
  let modalDebugInfo = null

  if (message && message.trim().length > 0) {
    // Estrategia 1: ¿textarea visible directamente? (algunos modales lo muestran sin paso)
    let textarea = await findNoteTextarea({ timeoutMs: 1500 })

    if (!textarea) {
      // Estrategia 2: clickear "Añadir nota" / "Personalizar" / etc.
      const addNoteBtn = findAddNoteButton()
      if (addNoteBtn) {
        console.log('[Orion content] Add-note button found — clicking:', (addNoteBtn.textContent ?? addNoteBtn.getAttribute('aria-label') ?? '').slice(0, 40))
        await humanClick(addNoteBtn)
        await sleep(randInt(700, 1200))
        textarea = await findNoteTextarea({ timeoutMs: 3000 })
      } else {
        // Capturar TODO el contenido del modal para debug
        modalDebugInfo = dumpModalContent()
        console.warn('[Orion content] No add-note button NI textarea directo. Modal items:', modalDebugInfo)
      }
    }

    if (textarea) {
      // Llenar con typing humano
      await humanType(textarea, message.slice(0, 290))  // LinkedIn límite 300, margin
      textareaUsed = true
      await sleep(randInt(500, 900))
    }
    // Si textarea sigue null pero el modal está abierto, el invite irá sin nota
    // (LinkedIn lo acepta — mensaje se pierde pero invitación sí va)
  }

  // 10. DRY_RUN: si dryRun=true, NO click final Send — solo confirmamos que llegamos aquí
  if (dryRun) {
    console.log('[Orion content] DRY RUN — saltando click Send final')
    // Cerrar modal si está abierto para no dejar UI a medias
    const cancelBtn = findCancelButton()
    if (cancelBtn) { try { cancelBtn.click() } catch {} }
    return {
      action: 'send_invite',
      status: 'dry_run_ok',
      textareaUsed,
      messageLength: message?.length ?? 0,
      connectBtnInfo,
      ...(modalDebugInfo ? { modalDebugInfo } : {}),
    }
  }

  // 11. Click Send final
  const sendBtn = findSendButton()
  if (!sendBtn) {
    return { action: 'send_invite', status: 'error', error: 'send_button_not_found', textareaUsed }
  }
  await humanClick(sendBtn)

  // 12. Esperar confirmación (toast aparece OR modal cierra)
  const confirmed = await waitForSendConfirmation(8000)

  return {
    action: 'send_invite',
    status: confirmed ? 'sent' : 'sent_unconfirmed',
    textareaUsed,
    capturedThreadIds,
    sentAt: new Date().toISOString(),
  }
}

// ── PATH A: send_invite cuando background navegó a /preload/custom-invite/ ──
// El modal "¿Añadir una nota?" abre automáticamente. Tareas:
//   1. Esperar a que el modal renderice
//   2. Click "Añadir una nota" (botón real, no anchor SPA)
//   3. Esperar textarea
//   4. humanType el mensaje
//   5. Si dryRun → click "X" o ESC para cancelar
//   6. Si !dryRun → click "Enviar" / "Send"
// v0.7.31 instrumentación send_invite (cierra el FSM-gap): emite checkpoints a
// micro_phase_log para ver DÓNDE cuelga el flujo (especialmente Path A.2 con nota,
// que hizo exec_hard_timeout 219s sin pista). Sobrevive al timeout (persistido en bridge).
function emitInviteCheckpoint(name, extra) {
  try {
    chrome.runtime.sendMessage({
      type: 'orion_micro_phase',
      commandId: _currentCommandId,
      action: 'send_invite',
      entry: {
        name, ts: Date.now(),
        elapsed: Date.now() - (_executingSince || Date.now()),
        state: 'mark', extra: extra ?? null,
      },
    }).catch(() => {})
  } catch {}
}

async function sendInviteFromCustomInvite(payload) {
  const { message, dryRun } = payload
  const withNote = !!message  // Si message es null/empty/undefined → sin nota
  console.log(`[Orion content] PATH A — Modal SPA route, withNote=${withNote}`)
  emitInviteCheckpoint('invite_start', { withNote, dryRun: !!dryRun })

  // 1. Esperar modal (¿Añadir una nota?)
  const modalSel = '[role="dialog"], .artdeco-modal'
  const found = await waitForSelector([modalSel], 8000)
  if (!found) {
    emitInviteCheckpoint('modal_not_rendered')
    return { action: 'send_invite', status: 'error', error: 'preload_modal_not_rendered', url: location.href }
  }
  emitInviteCheckpoint('modal_found', { withNote })
  await sleep(randInt(800, 1400))  // hidratación

  // ── PATH A.1: SIN NOTA — Click directo "Enviar sin nota" o "Enviar" ──────
  if (!withNote) {
    const sendNoNoteBtn = findSendWithoutNoteButton()
    if (!sendNoNoteBtn) {
      return {
        action: 'send_invite', status: 'error',
        error:  'send_without_note_btn_not_found',
        modalDebug: dumpModalContent(),
      }
    }
    if (dryRun) {
      console.log('[Orion content] DRY RUN sin nota — cerrando modal sin enviar')
      const closeBtn = document.querySelector('[role="dialog"] button[aria-label*="cerrar" i], [role="dialog"] button[aria-label*="close" i], .artdeco-modal__dismiss')
      if (closeBtn) await humanClick(closeBtn)
      else document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return {
        action: 'send_invite', status: 'dry_run_ok',
        textareaUsed: false, withNote: false, path: 'spa_route_no_note',
      }
    }
    console.log('[Orion content] Clicking "Enviar sin nota"')
    await humanClick(sendNoNoteBtn)
    await sleep(2500)
    // REMOVED 2026-05-29: setTimeout location.href causaba modal "Leave site?" cuando
    // un siguiente command (FU/auto-reply) empezaba a typear durante la navegación.
    // LinkedIn detectaba texto sin guardar y mostraba el modal. Sin el auto-nav,
    // la tab queda en /preload/custom-invite/ pero next command navega correctamente.
    return {
      action: 'send_invite', status: 'sent',
      textareaUsed: false, withNote: false, path: 'spa_route_no_note',
    }
  }

  // ── PATH A.2: CON NOTA — flow original ───────────────────────────────────
  // 2. Buscar botón "Añadir una nota"
  const addNoteBtn = findAddNoteButtonInPreloadModal()
  if (!addNoteBtn) {
    // El modal no tiene "Añadir nota" — quizás LinkedIn quiere enviar sin nota directo
    // Reportamos para que decidamos estrategia
    return {
      action: 'send_invite',
      status: 'error',
      error:  'add_note_btn_not_found_in_preload_modal',
      modalDebug: dumpModalContent(),
    }
  }

  // 3. Click "Añadir una nota"
  console.log('[Orion content] Clicking "Añadir una nota"')
  emitInviteCheckpoint('add_note_btn_found')
  await humanClick(addNoteBtn)
  emitInviteCheckpoint('add_note_clicked')
  await sleep(randInt(1500, 2500))  // espera a que textarea aparezca

  // 4. Buscar textarea
  const textarea = await findNoteTextarea({ timeoutMs: 5000 })
  if (!textarea) {
    emitInviteCheckpoint('textarea_not_found')
    return {
      action: 'send_invite',
      status: 'error',
      error:  'textarea_not_appeared_after_add_note_click',
      modalDebug: dumpModalContent(),
    }
  }
  emitInviteCheckpoint('textarea_found', { tag: textarea.tagName, ce: textarea.isContentEditable })

  // 5. Tipear mensaje — v0.7.33 humanTypeChunked (evita el throttle de background
  // tab que hacía colgar el char-por-char ~180s → exec_hard_timeout).
  console.log(`[Orion content] Typing message (${message.length} chars) — chunked`)
  emitInviteCheckpoint('typing_start', { len: Math.min(message.length, 290) })
  await humanTypeChunked(textarea, message.slice(0, 290), 12)
  emitInviteCheckpoint('typing_done')
  await sleep(randInt(500, 1000))

  // 6. dryRun: cerrar sin enviar. v0.7.33: usar safeDismissInviteModal (vacía la
  // nota PRIMERO → cierre sin disparar el modal "¿Descartar?" que hacía pelear al
  // observer v0.7.9 y colgaba el cierre ~158s). Limpio y rápido.
  if (dryRun) {
    emitInviteCheckpoint('dry_run_closing')
    console.log('[Orion content] DRY RUN — desarmando + cerrando modal sin enviar')
    safeDismissInviteModal()
    emitInviteCheckpoint('dry_run_done')
    return {
      action: 'send_invite',
      status: 'dry_run_ok',
      textareaUsed: true,
      messageLength: message.length,
      path: 'spa_route',
    }
  }

  // 7. Click Send
  const sendBtn = findSendButtonInPreloadModal()
  if (!sendBtn) {
    return { action: 'send_invite', status: 'error', error: 'send_button_not_found', modalDebug: dumpModalContent() }
  }
  await humanClick(sendBtn)
  await sleep(2000)

  // REMOVED 2026-05-29: setTimeout location.href causaba modal "Leave site?" cuando
  // un siguiente command empezaba a typear durante la navegación a /mynetwork/.
  // Lo dejamos sin auto-nav — el next command llegará y navegará donde necesite.

  return {
    action: 'send_invite',
    status: 'sent',
    textareaUsed: true,
    messageLength: message.length,
    path: 'spa_route',
    sentAt: new Date().toISOString(),
  }
}

function findAddNoteButtonInPreloadModal() {
  // Texto exacto "Añadir una nota" en el modal del SPA route
  const modal = document.querySelector('[role="dialog"], .artdeco-modal')
  if (!modal) return null
  const buttons = Array.from(modal.querySelectorAll('button, [role="button"]'))
  return buttons.find(b => {
    if (b.offsetParent === null) return false
    const t = (b.textContent ?? '').trim().toLowerCase()
    return /^añadir.*nota|^agregar.*nota|^add.*note|^personali/i.test(t)
  })
}

function findSendButtonInPreloadModal() {
  const modal = document.querySelector('[role="dialog"], .artdeco-modal')
  if (!modal) return null
  const buttons = Array.from(modal.querySelectorAll('button, [role="button"]'))
  return buttons.find(b => {
    if (b.offsetParent === null) return false
    const t = (b.textContent ?? '').trim().toLowerCase()
    return t === 'enviar' || t === 'send' || /^enviar.+invitaci|send invitation/i.test(t)
  })
}

// Botón "Enviar sin nota" / "Send without a note" / "Enviar" directo en modal preload
function findSendWithoutNoteButton() {
  const modal = document.querySelector('[role="dialog"], .artdeco-modal')
  if (!modal) return null
  const buttons = Array.from(modal.querySelectorAll('button, [role="button"]'))

  // Prioridad 1: botón explícito "Enviar sin nota" / "Send without a note"
  const explicit = buttons.find(b => {
    if (b.offsetParent === null) return false
    const t = (b.textContent ?? '').trim().toLowerCase()
    return /enviar.*sin.*nota|send.*without.*note/i.test(t)
  })
  if (explicit) return explicit

  // Prioridad 2: botón "Enviar" / "Send" simple (sin "invitación") — algunos
  // modales no muestran "Añadir nota" + "Enviar sin nota" sino directamente "Enviar"
  const send = buttons.find(b => {
    if (b.offsetParent === null) return false
    const t = (b.textContent ?? '').trim().toLowerCase()
    return t === 'enviar' || t === 'send'
  })
  return send ?? null
}

// ── Helpers DOM Connect/Note/Send buttons ───────────────────────────────────

function findConnectButton() {
  // Top-card buttons (excluye nav "Mensajes")
  const selectors = [
    'button[aria-label^="Invitar a" i][aria-label*="conectar" i]',
    'button[aria-label*="Connect" i]',
    'button.artdeco-button--primary',  // ojo: puede matchear otros — chequeo texto abajo
  ]
  // Buscar por texto exacto
  const all = Array.from(document.querySelectorAll('button'))
  const byText = all.find(b => {
    const t = (b.textContent ?? '').trim().toLowerCase()
    return (t === 'connect' || t === 'conectar') && isInTopCard(b)
  })
  if (byText) return byText
  for (const sel of selectors) {
    const el = document.querySelector(sel)
    if (el && isInTopCard(el)) return el
  }
  // Tal vez está en "More actions" overflow
  return null
}

function findOverflowButton() {
  // Estrategia: encontrar Follow button del profile, después buscar el "Más"
  // más cercano verticalmente (típicamente al lado del Follow).
  // El "Más" del profile suele tener: aria-label="Más" (o "More"), text vacío,
  // mismo container que Follow, dentro de ±100px verticalmente.
  const all = Array.from(document.querySelectorAll('button, [role="button"]'))

  // 1. Follow button (action card del profile)
  const followBtn = all.find(b => {
    if (b.offsetParent === null) return false
    const t = (b.textContent ?? '').trim().toLowerCase()
    return /^(seguir|follow)\b/i.test(t)
  })

  const isOverflowLike = (b) => {
    if (b.offsetParent === null) return false
    const t = (b.textContent ?? '').trim().toLowerCase()
    const aria = (b.getAttribute('aria-label') ?? '').toLowerCase().trim()
    // text == 'más'/'more' o aria empieza/equivale a 'más'/'more'
    return (t === 'más' || t === 'more' || t === '…' ||
            aria === 'más' || aria === 'more' ||
            /^más\b|^more\b|más acciones|more actions/i.test(aria))
  }

  if (followBtn) {
    const followRect = followBtn.getBoundingClientRect()
    // Buscar overflow buttons cercanos al Follow (±150px vertical)
    const candidates = all.filter(b => b !== followBtn && isOverflowLike(b))
    // Excluir los que están en nav
    const profileCandidates = candidates.filter(b => !b.closest('nav, .global-nav, [class*="global-nav"]'))
    // Ordenar por proximidad al Follow button
    profileCandidates.sort((a, b) => {
      const da = Math.abs(a.getBoundingClientRect().top - followRect.top)
      const db = Math.abs(b.getBoundingClientRect().top - followRect.top)
      return da - db
    })
    // El más cercano que esté dentro de 200px del Follow
    const nearest = profileCandidates[0]
    if (nearest && Math.abs(nearest.getBoundingClientRect().top - followRect.top) < 200) {
      return nearest
    }
  }

  // Fallback final: cualquier overflow profile (no nav)
  return all.find(b => {
    if (!isOverflowLike(b)) return false
    if (b.closest('nav, .global-nav, [class*="global-nav"]')) return false
    return true
  })
}

function findConnectInOverflow() {
  // PRIORIDAD ALTA: buscar directamente [role="menuitem"] / div clickable cuyo
  // textContent contenga "Conectar"/"Connect". Esto es lo que React/Ember
  // bindea al click handler.
  const menuItems = Array.from(document.querySelectorAll(
    '[role="menuitem"], .artdeco-dropdown__item, [class*="dropdown__item"], li[class*="dropdown"]'
  )).filter(el => el.offsetParent !== null)

  for (const item of menuItems) {
    const t = (item.textContent ?? '').trim().toLowerCase()
    if (t.startsWith('conectar') || t.startsWith('connect') ||
        t === 'conectar' || t === 'connect') {
      return item
    }
  }

  // FALLBACK: si no hay menuitem explícito, buscar leaf con texto "Conectar"
  const allElements = Array.from(document.querySelectorAll('*'))
  for (const el of allElements) {
    if (el.children.length > 0) continue
    if (el.offsetParent === null) continue
    const t = (el.textContent ?? '').trim().toLowerCase()
    if (t === 'conectar' || t === 'connect') {
      // Subir buscando menuitem o anything clickable
      let node = el
      for (let i = 0; i < 6 && node; i++) {
        const role = node.getAttribute?.('role')
        if (role === 'menuitem' || node.tagName === 'BUTTON' || node.tagName === 'A' ||
            role === 'button' || node.onclick !== null) {
          return node
        }
        node = node.parentElement
      }
      return el
    }
  }
  return null
}

// Debug helper: lista los menuitems visibles tras abrir overflow
function dumpOverflowDropdown() {
  const items = Array.from(document.querySelectorAll(
    '[role="menuitem"], [role="menu"] li, .artdeco-dropdown__item, [class*="dropdown"] li, [class*="dropdown"] [role="button"]'
  )).filter(el => el.offsetParent !== null).slice(0, 15)

  return items.map(el => ({
    tag:   el.tagName,
    role:  el.getAttribute('role') ?? '',
    text:  (el.textContent ?? '').trim().slice(0, 60),
    aria:  (el.getAttribute('aria-label') ?? '').slice(0, 50),
  }))
}

function findMessageButton() {
  const all = Array.from(document.querySelectorAll('button, a'))
  return all.find(b => {
    const t = (b.textContent ?? '').trim().toLowerCase()
    return (t === 'message' || t === 'mensaje') && isInTopCard(b)
  })
}

function isInTopCard(el) {
  // Heurística: el botón debe estar en el top 700px de la página
  const r = el.getBoundingClientRect()
  return r.top < 700 && r.left < window.innerWidth * 0.7
}

function findAddNoteButton() {
  const all = Array.from(document.querySelectorAll('button, [role="button"]'))
  return all.find(b => {
    const t = (b.textContent ?? '').trim().toLowerCase()
    const aria = (b.getAttribute('aria-label') ?? '').toLowerCase()
    return /add a note|añadir.*nota|agregar.*nota|personali[sz]e/i.test(t + ' ' + aria)
  })
}

// v0.7.31 SAFETY — cleanup garantizado del modal de invitación. Si el flujo de
// send_invite cuelga/falla DESPUÉS de teclear la nota pero ANTES de cerrar, el modal
// queda "armado" (nota escrita, a un click de enviarse). Este helper, llamado desde
// el .finally() del executeAction, VACÍA la nota (nada que enviar accidentalmente) y
// cierra el modal. Idempotente y defensivo — no-op si no hay modal.
function safeDismissInviteModal() {
  try {
    const modal = document.querySelector('[role="dialog"], .artdeco-modal')
    if (!modal) return false
    // 1. Vaciar cualquier nota escrita (textarea o contenteditable) → desarmar.
    const inputs = [
      ...modal.querySelectorAll('textarea'),
      ...modal.querySelectorAll('div[contenteditable="true"]'),
    ]
    let cleared = 0
    for (const el of inputs) {
      const hasText = (el.value ?? el.textContent ?? '').trim().length > 0
      if (!hasText) continue
      if (el.tagName.toLowerCase() === 'textarea') {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        if (setter) { setter.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })) }
      } else if (el.isContentEditable) {
        el.innerHTML = ''
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      cleared++
    }
    // 2. Cerrar el modal (X). Con la nota vacía, NO dispara "¿Descartar?".
    const dismiss = modal.querySelector(
      'button[aria-label*="cerrar" i], button[aria-label*="close" i], .artdeco-modal__dismiss'
    )
    if (dismiss && dismiss.offsetParent !== null) dismiss.click()
    if (cleared > 0) console.log(`[Orion content] SAFETY: invite modal desarmado (${cleared} nota vaciada) + cerrado`)
    return true
  } catch { return false }
}

async function findNoteTextarea({ timeoutMs = 4000 } = {}) {
  // Búsqueda ULTRA permissiva: cualquier textarea o contenteditable VISIBLE
  // en cualquier parte del documento. Si después de clickear Conectar aparece
  // un textarea visible que antes no estaba, es el nuestro.
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    // Candidatos: textareas + contenteditables
    const candidates = [
      ...Array.from(document.querySelectorAll('textarea')),
      ...Array.from(document.querySelectorAll('div[contenteditable="true"]')),
    ]
    // Filtrar solo los visibles (offsetParent !== null + height > 0)
    const visible = candidates.filter(el => {
      if (el.offsetParent === null) return false
      const r = el.getBoundingClientRect()
      return r.width > 50 && r.height > 20  // tamaño razonable para un input de mensaje
    })
    if (visible.length > 0) {
      // Preferir el que esté dentro de un dialog/modal-like overlay
      const inDialog = visible.find(el => el.closest('[role="dialog"], .artdeco-modal, [class*="modal"], [class*="overlay"]'))
      return inDialog ?? visible[0]
    }
    await sleep(250)
  }
  return null
}

function dumpModalContent() {
  // Búsqueda amplia: cualquier modal/overlay visible en la página
  const candidates = [
    ...document.querySelectorAll('[role="dialog"]'),
    ...document.querySelectorAll('.artdeco-modal'),
    ...document.querySelectorAll('[class*="modal"][class*="open"]'),
    ...document.querySelectorAll('[class*="overlay"]'),
    ...document.querySelectorAll('[class*="popup"]'),
  ]
  const modal = candidates.find(m => m.offsetParent !== null)

  if (!modal) {
    // Dump global: textareas y buttons visibles top-of-page (modal puede no tener role)
    const allTextareas = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'))
      .filter(t => t.offsetParent !== null)
      .slice(0, 5)
      .map(t => ({
        tag:  t.tagName,
        id:   t.id ?? '',
        aria: (t.getAttribute('aria-label') ?? '').slice(0, 50),
        placeholder: t.getAttribute('placeholder') ?? '',
        visible: true,
        rect: { ...['top','left','width','height'].reduce((acc, k) => { acc[k] = Math.round(t.getBoundingClientRect()[k]); return acc }, {}) },
      }))
    return { found: false, foundGlobal: allTextareas.length, globalTextareas: allTextareas }
  }

  const buttons = Array.from(modal.querySelectorAll('button, [role="button"]'))
    .filter(b => b.offsetParent !== null)
    .slice(0, 10)
    .map(b => ({
      text: (b.textContent ?? '').trim().slice(0, 50),
      aria: (b.getAttribute('aria-label') ?? '').slice(0, 50),
    }))

  const textareas = Array.from(modal.querySelectorAll('textarea, [contenteditable="true"]'))
    .filter(t => t.offsetParent !== null)
    .slice(0, 5)
    .map(t => ({
      tag:  t.tagName, id: t.id, name: t.name,
      aria: (t.getAttribute('aria-label') ?? '').slice(0, 50),
      placeholder: t.getAttribute('placeholder') ?? '',
    }))

  return {
    found:     true,
    modalClass: modal.className.slice(0, 80),
    modalRole:  modal.getAttribute('role') ?? '',
    title:     (modal.querySelector('h1, h2, [role="heading"]')?.textContent ?? '').trim().slice(0, 80),
    buttons,
    textareas,
  }
}

function findSendButton() {
  const all = Array.from(document.querySelectorAll('button, [role="button"]'))
  // Prioridad: aria-label contiene "send invitation" / "enviar invitación"
  const priority = all.find(b => {
    const aria = (b.getAttribute('aria-label') ?? '').toLowerCase()
    return /send invitation|enviar invitaci|send now|enviar ahora/.test(aria)
  })
  if (priority) return priority
  // Fallback: texto = "Send" / "Enviar" / "Send invitation"
  return all.find(b => {
    const t = (b.textContent ?? '').trim().toLowerCase()
    return /^(send|enviar|send invitation|enviar invitación)$/i.test(t) && b.offsetParent !== null
  })
}

function findCancelButton() {
  const all = Array.from(document.querySelectorAll('button, [role="button"]'))
  return all.find(b => {
    const t = (b.textContent ?? '').trim().toLowerCase()
    return (t === 'cancel' || t === 'cancelar') && b.offsetParent !== null
  })
}

function listVisibleButtons() {
  return Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null)
    .slice(0, 25).map(b => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 50))
}

async function waitForSendConfirmation(timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    // Si modal cerró (no hay role=dialog visible) → asumimos sent
    const modal = document.querySelector('[role="dialog"], .artdeco-modal')
    if (!modal || modal.offsetParent === null) return true
    // Si toast con "enviada" / "sent" aparece
    const toast = Array.from(document.querySelectorAll('[role="alert"], [class*="toast"]'))
      .find(t => /enviad[ao]|sent|success/i.test(t.textContent ?? ''))
    if (toast) return true
    await sleep(400)
  }
  return false
}

// ── humanClick + humanType ───────────────────────────────────────────────────

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

async function humanClick(el) {
  if (!el) return false
  el.scrollIntoView({ behavior: 'instant', block: 'center' })
  await sleep(randInt(150, 400))
  const r = el.getBoundingClientRect()
  const x = r.left + r.width / 2 + (Math.random() - 0.5) * 10
  const y = r.top + r.height / 2 + (Math.random() - 0.5) * 6
  const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }

  // Hover synthetic para que React vea actividad de mouse
  el.dispatchEvent(new MouseEvent('mouseover', opts))
  await sleep(randInt(80, 160))
  el.dispatchEvent(new MouseEvent('mousemove', opts))
  await sleep(randInt(40, 100))

  // Click NATIVO — el browser dispara internamente mousedown/mouseup/click
  // de manera que React puede procesar en su SyntheticEvent system.
  // En anchors con href, el browser respeta preventDefault del handler.
  // NO añadimos dispatch click para evitar double-trigger.
  try { el.focus() } catch {}
  el.click()
  return true
}

// Variante específica para activar links/menuitems vía Enter (anchor activation).
// Útil cuando .click() no triggea handler React (LinkedIn /preload/ routes).
async function activateViaKeyboard(el) {
  el.focus()
  await sleep(randInt(80, 150))
  const keyOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
  el.dispatchEvent(new KeyboardEvent('keydown', keyOpts))
  await sleep(randInt(30, 70))
  el.dispatchEvent(new KeyboardEvent('keypress', keyOpts))
  await sleep(randInt(30, 70))
  el.dispatchEvent(new KeyboardEvent('keyup', keyOpts))
}

// v0.7.33 FIX background-throttle: Chrome throttlea setTimeout a ~1000ms en tabs
// en background (la tab LinkedIn la maneja el SW sin foco). humanType char-por-char
// hace 1 sleep POR carácter → 180 chars × ~1000ms throttled = ~180s → exec_hard_timeout.
// (Era la causa real del hang de invite-con-nota / BUG-M / send_followup lento.)
// Tipear en CHUNKS reduce los sleeps ~10x (180 chars / chunk 12 = 15 sleeps ≈ 15s)
// manteniendo variabilidad. React registra el input event por chunk igual.
async function humanTypeChunked(el, text, chunkSize = 12) {
  el.focus()
  await sleep(randInt(150, 300))
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
                ?? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  const isTextareaLike = (el.tagName.toLowerCase() === 'textarea' || el.tagName.toLowerCase() === 'input')
  for (let i = 0; i < text.length; i += chunkSize) {
    if (setter && isTextareaLike) {
      setter.call(el, text.slice(0, i + chunkSize))   // valor acumulado
      el.dispatchEvent(new Event('input', { bubbles: true }))
    } else if (el.isContentEditable) {
      document.execCommand('insertText', false, text.slice(i, i + chunkSize))  // solo el trozo nuevo
    } else {
      el.value = text.slice(0, i + chunkSize)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await sleep(randInt(120, 320))  // pausa variable entre chunks
  }
}

async function humanType(el, text) {
  el.focus()
  await sleep(randInt(200, 400))
  for (const ch of text) {
    // React/LinkedIn requieren actualizar value + disparar input event
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
                ?? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    if (setter && el.tagName.toLowerCase() === 'textarea') {
      setter.call(el, (el.value ?? '') + ch)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    } else if (el.isContentEditable) {
      // contenteditable — usa execCommand
      document.execCommand('insertText', false, ch)
    } else {
      el.value = (el.value ?? '') + ch
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    // v0.7.21 P1-3: jitter_pct_typing wired desde runtime_config (default 0.70).
    // Centro 100ms × (1 ± pct) → si pct=0.70 → [30,170] (igual que v0.7.16).
    // Permite tuning sin redeploy via UPDATE runtime_config.
    const pct = _runtimeConfig?.jitter_pct_typing ?? 0.70
    const min = Math.max(10, Math.round(100 * (1 - pct)))
    const max = Math.round(100 * (1 + pct))
    let delay = randInt(min, max)
    if ('.,!?¡¿'.includes(ch)) delay += randInt(60, 240)
    if (Math.random() < 0.07) delay += randInt(200, 600)
    await sleep(delay)
  }
}

// ── 2.4 — send_followup REAL ────────────────────────────────────────────────
//
// Payload: {
//   threadUrl: 'https://www.linkedin.com/messaging/thread/<id>/',
//   profileUrl: '...',     // fallback si no hay thread_id en DB
//   message:    '<AI-generated FU>',
//   leadName:   '...',
//   dryRun:     true|false
// }
//
// El background.js navegó la tab a threadUrl antes de llamarnos.
// Tareas:
//   1. Verificar que estamos en /messaging/thread/...
//   2. Esperar a que el editor inline aparezca (.msg-form__contenteditable)
//   3. Verificar que el header del thread matche leadName (sanity check)
//   4. humanType el mensaje en el editor contenteditable
//   5. dryRun: NO clickear Send, limpiar el editor + return
//   6. !dryRun: click Send (botón regular, no anchor) + esperar confirmation

// v0.6.42: el inbox tiene filtros (Prioritarios / No leídos / Empleos / Contactos
// / Mensajes InMail / Marcados). Si el usuario tiene activo "Prioritarios" o
// "Empleos", el lead probablemente no aparece. Detectamos qué chip está activo
// y, si NO es el universal, lo desactivamos clickeándolo (LinkedIn toggle).
// Toggle off un filter chip = ver TODOS los mensajes.
async function ensureInboxAllFilter() {
  try {
    // Los chips de filtros son button con aria-pressed="true" cuando activos.
    // Texto visible: "Prioritarios", "Empleos", "No leídos", "Contactos",
    // "Mensajes InMail", "Marcados".
    const restrictiveLabels = /^(prioritarios|empleos|no leídos|no leidos|contactos|mensajes inmail|inmail|marcados)$/i
    const chips = Array.from(document.querySelectorAll('button[aria-pressed], [role="button"][aria-pressed]'))
    for (const chip of chips) {
      if (chip.getAttribute('aria-pressed') !== 'true') continue
      const label = (chip.textContent ?? '').trim()
      if (restrictiveLabels.test(label)) {
        console.log(`[Orion content] inbox filter "${label}" activo → toggle off`)
        chip.click()
        await sleep(randInt(600, 1100))
        return true
      }
    }
  } catch (err) {
    console.warn('[Orion content] ensureInboxAllFilter falló:', err?.message)
  }
  return false
}

// P1: abre una conversación clickeándola desde la lista del inbox (SPA in-app).
// Más confiable que navegar directo al thread URL (que deja la página a medias).
// Match por nombre del lead (el thread_id no está en el DOM de la lista).
async function openThreadFromInbox(leadName, threadUrl) {
  // v0.6.42: si el usuario está en tab "Prioritarios" o "Empleos", la conversación
  // del lead no aparece. Cambiamos a "No leídos"→"Contactos" o forzamos "Mostrar todo".
  // El filter chip se aplica como un button con aria-pressed.
  await ensureInboxAllFilter()

  // Asegurar que la lista de conversaciones cargó
  const containerSel = [
    '.msg-conversations-container__conversations-list',
    'ul[class*="conversations-list"]',
    '.msg-conversations-container',
  ]
  const found = await waitForSelector(containerSel, 12000)
  if (!found) { console.warn('[Orion content] openThreadFromInbox: lista no cargó'); return false }
  await sleep(randInt(800, 1400))

  // Extract thread_id from threadUrl for primary matching by href
  // (más robusto que por nombre — funciona aunque el lead esté en vista filtrada
  // o con nombre abreviado tipo "Jorge Francisco O.")
  const threadIdMatch = threadUrl?.match(/\/messaging\/thread\/([^/?#]+)/)
  const wantedThreadId = threadIdMatch ? decodeURIComponent(threadIdMatch[1]) : null

  const itemSels = [
    'li.msg-conversation-listitem',
    'li[class*="msg-conversation-listitem"]',
    'ul[class*="conversations-list"] > li',
  ]
  const getItems = () => {
    let r = []
    for (const sel of itemSels) { r = Array.from(document.querySelectorAll(sel)); if (r.length) break }
    return r
  }
  let items = getItems()
  if (!items.length) { console.warn('[Orion content] openThreadFromInbox: sin items'); return false }

  // v0.6.47: helper que aplica el matching contra una lista de items.
  // Devuelve { target, byThreadId } o null si nada matchea.
  const tryMatch = (currentItems) => {
    // PRIMARY: match por thread_id en anchor href (más confiable que nombre)
    if (wantedThreadId) {
      for (const el of currentItems) {
        const a = el.querySelector('a[href*="/messaging/thread/"]')
        const href = a?.getAttribute('href') ?? ''
        const m = href.match(/\/messaging\/thread\/([^/?#]+)/)
        const id = m ? decodeURIComponent(m[1]) : ''
        if (id && id === wantedThreadId) return { target: el, by: 'thread_id' }
      }
    }
    // FALLBACK: matching por SCORING de tokens del nombre
    const norm = (s) => (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').trim()
    const leadTokens = norm(leadName).split(/\s+/).filter(t => t.length >= 3)
    let best = null, bestScore = 0
    for (const el of currentItems) {
      const parsed = parseConversationItem(el)
      const n = norm(parsed?.name)
      if (!n) continue
      if (leadName && (n.includes(norm(leadName)) || norm(leadName).includes(n))) return { target: el, by: 'name_substring' }
      const nTokens = new Set(n.split(/\s+/).filter(t => t.length >= 3))
      const overlap = leadTokens.filter(t => nTokens.has(t)).length
      if (overlap >= 2 && overlap > bestScore) { bestScore = overlap; best = el }
    }
    return best ? { target: best, by: 'name_score' } : null
  }

  let match = tryMatch(items)

  // v0.6.47: SCROLL-AND-RETRY — si el thread no está en los items visibles,
  // scroleamos la lista para forzar lazy-load (LinkedIn solo renderiza ~20-30
  // items inicialmente; las convos antiguas están abajo). Repetimos hasta 6
  // veces (~12s) o hasta que aparezca el target.
  if (!match) {
    const scrollContainer = document.querySelector(
      '.msg-conversations-container__conversations-list, ul[class*="conversations-list"]'
    ) || document.querySelector('.msg-conversations-container')
    const initialCount = items.length
    for (let i = 0; i < 6 && !match; i++) {
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight  // ir hasta abajo
        await sleep(randInt(900, 1400))  // dejar que React renderice
      } else {
        // fallback: scrollear el window
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })
        await sleep(randInt(900, 1400))
      }
      items = getItems()
      if (items.length === initialCount && i > 1) break  // no se cargaron más items
      match = tryMatch(items)
    }
    if (match) {
      console.log(`[Orion content] openThreadFromInbox: ✅ encontrado tras scroll-retry (${items.length} items render)`)
    }
  }

  const target = match?.target ?? null
  if (target) console.log(`[Orion content] openThreadFromInbox: matched by ${match.by}`)

  // v0.7.46: FALLBACK — el thread no apareció en el inbox ni tras el scroll-retry (enterrado
  // muy abajo, archivado, o la lista no lo renderiza). En vez de fallar con
  // thread_not_found_in_inbox (el #1 error de send_followup: 8/14 fallos hoy), SPA-navegamos
  // DIRECTO al thread URL. Preserva el context de content.js (pushState) y espera el composer.
  // El check de thread_header downstream valida que sea el lead correcto → si el thread_id
  // fuera stale, da thread_header_mismatch (NO manda al equivocado). Recupera FUs que morían.
  if (!target && wantedThreadId) {
    console.log(`[Orion content] openThreadFromInbox: no en lista (${items.length} items) → fallback SPA-nav directo al thread ${wantedThreadId.slice(0,16)}…`)
    try {
      window.__orionAllowSpaNav = true
      history.pushState({}, '', `/messaging/thread/${wantedThreadId}/`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    } finally { window.__orionAllowSpaNav = false }
    const t0 = Date.now()
    while (Date.now() - t0 < 8000) {
      if (document.querySelector('.msg-form__contenteditable, [class*="msg-form__contenteditable"]')) {
        console.log('[Orion content] openThreadFromInbox: ✅ composer cargó via fallback directo')
        await sleep(randInt(700, 1200))  // hidratación
        return true
      }
      await sleep(300)
    }
    console.warn('[Orion content] openThreadFromInbox: fallback directo tampoco cargó composer')
  }

  if (!target) {
    console.warn(`[Orion content] openThreadFromInbox: no encontré conv de "${leadName}" (thread_id=${wantedThreadId?.slice(0,20)}…) en ${items.length} items`)
    return false
  }

  // Click en el área clickeable del item → abre la conversación (SPA)
  const clickable = target.querySelector(
    '.msg-conversation-listitem__link, [class*="convo-item-link"]'
  ) ?? target
  clickable.scrollIntoView({ block: 'center', behavior: 'instant' })
  await sleep(randInt(300, 600))
  clickable.click()

  // Esperar a que la conversación abra: URL /thread/ O composer visible
  const start = Date.now()
  while (Date.now() - start < 8000) {
    if (/\/messaging\/thread\//.test(location.href)) break
    if (document.querySelector('.msg-form__contenteditable, [class*="msg-form__contenteditable"]')) break
    await sleep(300)
  }
  await sleep(randInt(600, 1100))  // hidratación del composer
  console.log(`[Orion content] openThreadFromInbox: conversación de "${leadName}" abierta (url=${location.href.slice(0,60)})`)
  return true
}

async function sendFollowup(payload = {}) {
  const { threadUrl, profileUrl, message, leadName, dryRun } = payload
  console.log(`[Orion content] sendFollowup: thread=${threadUrl?.slice(0, 60)}, profile=${profileUrl?.slice(0, 60)}, dryRun=${dryRun}`)

  // Sub-Fase 3.8: detectar contexto:
  // - /in/<vanity>/ → click "Mensaje" → redirige a /messaging/compose/
  // - /messaging/compose/?recipient=... → composer pantalla completa (write+send)
  // - /messaging/thread/<id>/ → thread existente (flow original)
  const isProfilePage = /\/in\//.test(location.pathname) && !/\/messaging\//.test(location.pathname)
  let isThreadPage    = location.href.includes('/messaging/thread/')
  const isComposePage = /\/messaging\/compose/.test(location.pathname)
  const isInboxPage   = /\/messaging\/?($|\?)/.test(location.pathname) && !isThreadPage && !isComposePage

  if (isProfilePage) {
    return await sendFollowupFromProfile(payload)
  }

  // P1: si estamos en el INBOX (lista) y tenemos thread/lead → abrir la
  // conversación por CLICK desde la lista (SPA in-app). Navegar directo al
  // thread URL dejaba la página a medias sin composer; clickear desde la lista
  // monta la conversación + editor confiablemente (como lo haría un humano).
  //
  // v0.6.43 + v0.7.10: si la tab quedó en /messaging/thread/<id>/ por una FU
  // anterior (cascada thread_header_mismatch) O simplemente seguimos en thread
  // page del FU previo, forzamos navegar al inbox via SPA pushState ANTES de
  // click-to-open desde el inbox. El SW ya navegó a /messaging/ via
  // navigateTabAndWait (background.js:450) pero LinkedIn SPA a veces mantiene
  // el thread anterior en location.pathname → re-aseguramos aquí.
  let needForceInbox = false
  let threadMismatchDetected = false
  if (isThreadPage && threadUrl) {
    const currentMatch = location.pathname.match(/\/messaging\/thread\/([^/?#]+)/)
    const wantedMatch = threadUrl.match(/\/messaging\/thread\/([^/?#]+)/)
    const currentId = currentMatch ? decodeURIComponent(currentMatch[1]) : null
    const wantedId = wantedMatch ? decodeURIComponent(wantedMatch[1]) : null
    if (currentId && wantedId && currentId !== wantedId) {
      console.warn(`[Orion content] thread mismatch en URL — current=${currentId.slice(0,20)}… wanted=${wantedId.slice(0,20)}… → forzar inbox`)
      needForceInbox = true
      threadMismatchDetected = true
    }
  }
  // v0.7.10: incluso sin mismatch explícito, si la tab arrancó en thread page
  // forzamos pushState a /messaging/ para garantizar que openThreadFromInbox
  // monte la conv desde la lista (más confiable que reusar la pegada).
  if (isThreadPage && threadUrl && !needForceInbox) {
    needForceInbox = true
  }

  if (needForceInbox) {
    // Navegar al inbox via SPA route — preserva content.js context.
    // v0.7.10: window.__orionAllowSpaNav=true bypassa el SPA route-guard de
    // v0.7.9 (líneas 313-359) que bloquearía este pushState si hay un draft
    // activo en el thread anterior (escape hatch documentado en línea 341).
    const pushStart = Date.now()
    try {
      window.__orionAllowSpaNav = true
      history.pushState({}, '', '/messaging/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    } finally {
      // Limpiamos el flag de inmediato — el resto del flow debe respetar el guard.
      window.__orionAllowSpaNav = false
    }
    // v0.7.10: checkpoint observable para phase-analyzer y visual learning.
    // Si esto deja de aparecer en micro_phase_log → fix degradado.
    try {
      chrome.runtime.sendMessage({
        type: 'orion_micro_phase',
        commandId: _currentCommandId,
        action: 'send_followup',
        entry: {
          name: 'pre_nav_inbox_pushed',
          ts: Date.now(),
          elapsed: Date.now() - (_executingSince || Date.now()),
          state: 'mark',
          ms: Date.now() - pushStart,
          extra: {
            threadMismatch: threadMismatchDetected,
            previousUrl: location.href.slice(0, 80),
          },
        },
      }).catch(() => {})
    } catch {}
    await sleep(randInt(1200, 2000))
    isThreadPage = false  // ya no estamos en thread page
  }

  if ((isInboxPage || needForceInbox) && (threadUrl || leadName)) {
    const opened = await openThreadFromInbox(leadName, threadUrl)
    if (!opened) {
      // v0.7.5: track para visual learning (3× en 1h → captura)
      try { vlOnPhaseTimeout('thread_not_found_in_inbox') } catch {}
      return {
        action: 'send_followup',
        status: 'error',
        error:  'thread_not_found_in_inbox',
        leadName,
        currentUrl: location.href,
      }
    }
    // v0.7.10: compose-redirect guard. LinkedIn a veces redirige el click del
    // item del inbox a /messaging/compose/?profileUrn=... cuando el thread
    // está huérfano o el lead degradó a 2do grado mid-conversation. Sin este
    // guard, isThreadPage se fuerza a true abajo y el flow continúa hacia
    // humanType, terminando en exec_hard_timeout_send_followup_275000ms (275s
    // perdidos). Detectamos la URL final inmediatamente.
    if (/^\/messaging\/compose\//.test(location.pathname)) {
      console.warn(`[Orion v0.7.10] thread_lost_compose_redirect — LinkedIn redirigió a ${location.pathname.slice(0,60)} (lead=${leadName})`)
      try { vlOnPhaseTimeout('thread_lost_compose_redirect') } catch {}
      try { await setPhase('error', { leadName, reason: 'thread_lost_compose_redirect', finalUrl: location.href.slice(0, 120) }) } catch {}
      return {
        action: 'send_followup',
        status: 'error',
        error:  'thread_lost_compose_redirect',
        reason: 'linkedin_redirected_to_compose_post_inbox_click',
        leadName,
        currentUrl: location.href,
        threadUrl,
      }
    }
    isThreadPage = true  // ahora estamos en el thread abierto
  }

  // 1. Verificar URL: thread o compose page son válidas para escribir
  if (!isThreadPage && !isComposePage) {
    return {
      action: 'send_followup',
      status: 'error',
      error:  'not_on_thread_compose_or_profile_page',
      currentUrl: location.href,
      pathname: location.pathname,
    }
  }

  // 2. Captcha/checkpoint check
  if (/\/checkpoint|\/challenge|\/authwall/.test(location.href)) {
    return { action: 'send_followup', status: 'error', error: 'captcha_or_checkpoint' }
  }

  // 2a. Profile 404: LinkedIn redirige a /404/ cuando el perfil fue borrado o
  // está restringido. Marca lead como dead permanente (no más retries).
  if (/\/404\//.test(location.pathname)) {
    return {
      action: 'send_followup',
      status: 'error',
      error:  'profile_not_found',
      reason: 'linkedin_404_page',
      url:    location.href,
    }
  }

  // 2b. Sales Nav / InMail redirect = lead es 2do grado, NO conectado.
  // LinkedIn redirige a /sales/ cuando intentas msj a alguien que no es 1er grado.
  // Esto dispara el revert automático en extension-bridge.
  if (/\/sales\//.test(location.href)) {
    return {
      action: 'send_followup',
      status: 'error',
      error:  'lead_not_first_degree',
      reason: 'sales_nav_redirect',
      url:    location.href,
    }
  }
  // El overlay InMail tiene texto "créditos disponibles" o "Mensaje InMail"
  const inmailHint = deepQueryAll('h2, h3, p, span')  // v0.9.11: shadow-aware (overlay en shadow DOM)
    .slice(0, 150)
    .find(el => /créditos disponibles|InMail credits|de \d+ créditos/i.test(el.textContent ?? ''))
  if (inmailHint) {
    return {
      action: 'send_followup',
      status: 'error',
      error:  'lead_not_first_degree',
      reason: 'inmail_required',
      url:    location.href,
    }
  }

  // v0.7.6: PRE-EDITOR CHECK — detectar si el thread permite mensajes nuevos
  // ANTES de gastar 12s waitForSelector que va a fallar.
  await sleep(800)  // dejar que LinkedIn renderice el thread completo
  const messageable = detectNotMessageable()
  if (messageable.detected) {
    console.log(`[Orion content] v0.7.6 not-messageable detectado: ${messageable.reason}`)
    try { vlOnPhaseTimeout(`not_messageable_${messageable.reason}`) } catch {}
    return {
      action: 'send_followup',
      status: 'error',
      error: 'lead_not_messageable',
      reason: messageable.reason,
      signals: messageable.signals,
      headerName: leadName,
      url: location.href,
    }
  }

  // 3. Esperar al editor del thread — selectores múltiples + fallback ultra-permissive
  const editorSels = [
    '.msg-form__contenteditable',
    'div.msg-form__contenteditable',
    '[class*="msg-form__contenteditable"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label*="mensaje" i]',
    'div[contenteditable="true"][aria-label*="message" i]',
    'div.msg-form__msg-content-container [contenteditable="true"]',
    '[class*="msg-form"] [contenteditable="true"]',
  ]
  const foundSel = await waitForSelector(editorSels, 12000)
  let editor = foundSel ? document.querySelector(foundSel) : null

  // Fallback ultra-permissivo: cualquier contenteditable visible con tamaño razonable
  if (!editor || editor.offsetParent === null) {
    await sleep(2000)  // espera extra
    const candidates = Array.from(document.querySelectorAll('div[contenteditable="true"]'))
      .filter(el => {
        if (el.offsetParent === null) return false
        const r = el.getBoundingClientRect()
        return r.width > 100 && r.height > 25
      })
    editor = candidates[0] ?? null
  }

  // v0.9.8 SHADOW DOM: el composer del overlay "Nuevo mensaje" (leads sin thread previo)
  // vive en un SHADOW ROOT (top>shadow[div]) → document.querySelector no lo ve. Perforar.
  if (!editor || editor.offsetParent === null) {
    for (const sel of editorSels) {
      const deep = deepQueryAll(sel).find(el => el.offsetParent !== null)
      if (deep) { editor = deep; console.log(`[Orion content] v0.9.8 ✅ editor en SHADOW DOM vía "${sel}"`); break }
    }
    if (!editor) {
      const deepCe = deepQueryAll('div[contenteditable="true"]')
        .find(el => el.offsetParent !== null && el.getBoundingClientRect().width > 100)
      if (deepCe) { editor = deepCe; console.log('[Orion content] v0.9.8 ✅ editor (contenteditable) en SHADOW DOM') }
    }
  }

  // NUDGE: en threads, LinkedIn a veces NO monta el contenteditable hasta que
  // interactúas con el área del formulario. Si no lo encontramos, clickeamos el
  // placeholder/form footer para forzar el render, scroll al fondo, y re-esperamos.
  if (!editor) {
    console.log('[Orion content] Editor no encontrado — nudge para forzar render')
    try {
      // Scroll al fondo del thread (el form está abajo)
      const scrollable = document.querySelector('.msg-s-message-list-container, [class*="msg-s-message-list"]')
      if (scrollable) scrollable.scrollTop = scrollable.scrollHeight
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })
      await sleep(800)
      // Click en el placeholder "Escribe un mensaje..." o el contenedor del form
      const formArea = document.querySelector(
        '.msg-form__placeholder, .msg-form__msg-content-container, [class*="msg-form"]'
      )
      if (formArea && formArea.offsetParent !== null) {
        formArea.click()
        await sleep(randInt(400, 800))
      }
    } catch (err) {
      console.warn('[Orion content] nudge falló:', err?.message)
    }
    // Segunda espera tras el nudge (hidratación tardía)
    const reSel = await waitForSelector(editorSels, 8000)
    editor = reSel ? document.querySelector(reSel) : null
    if (!editor) {
      const cands2 = Array.from(document.querySelectorAll('div[contenteditable="true"]'))
        .filter(el => el.offsetParent !== null && el.getBoundingClientRect().width > 100)
      editor = cands2[0] ?? null
    }
    if (editor) console.log('[Orion content] ✅ Editor apareció tras nudge')
  }

  if (!editor) {
    // Debug: capturar TODO lo que podría ser un editor
    const allEditables = Array.from(document.querySelectorAll('div[contenteditable], textarea, input[type="text"]'))
      .slice(0, 10)
      .map(el => ({
        tag: el.tagName,
        editable: el.getAttribute('contenteditable'),
        aria: (el.getAttribute('aria-label') ?? '').slice(0, 50),
        classes: (el.className ?? '').slice(0, 80),
        visible: el.offsetParent !== null,
        el,  // referencia DOM para v0.6.48
      }))

    // v0.6.48 — COMPOSE RECIPIENT SELECT FIX: cuando estamos en /messaging/compose/
    // con un campo `msg-connections-typeahead__search-field` (selector "Para:")
    // pero sin editor de mensaje, LinkedIn está esperando que escribamos el lead
    // en el typeahead para que aparezca el editor. Caso típico: invite sin nota
    // que fue aceptada — LinkedIn no auto-popula el recipient aunque venga en URL.
    const typeaheadField = allEditables.find(e =>
      (e.classes ?? '').includes('msg-connections-typeahead__search-field') && e.visible
    )?.el
    if (isComposePage && typeaheadField && leadName) {
      console.log(`[Orion content] v0.6.48 — compose typeahead detectado, escribiendo "${leadName}" para seleccionar recipient`)
      try {
        typeaheadField.focus()
        await sleep(randInt(300, 600))
        // Tipear humanizado en el typeahead
        const firstWords = leadName.split(/\s+/).slice(0, 2).join(' ')  // 2 primeras palabras
        for (const ch of firstWords) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          setter?.call(typeaheadField, (typeaheadField.value ?? '') + ch)
          typeaheadField.dispatchEvent(new Event('input', { bubbles: true }))
          await sleep(randInt(50, 130))
        }
        await sleep(randInt(800, 1400))  // esperar autocomplete

        // Click en la primera sugerencia del dropdown — buscar li/button visible
        // con el nombre del lead dentro del dropdown que LinkedIn renderiza.
        const suggestionSels = [
          '.msg-connections-typeahead__search-result',
          '[class*="typeahead__search-result"]',
          '[class*="typeahead-suggestions"] li',
          '[role="option"]',
          '.search-typeahead-v2__hit',
        ]
        // v0.9.5 SAFETY: NO clickear la primera sugerencia a ciegas (causaba InMail/mensaje
        // al contacto EQUIVOCADO — nombre similar o sugerencia ajena). Verificar que la
        // sugerencia COINCIDA con el nombre del lead; si ninguna matchea → ABORTAR.
        const _norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()
        const _leadNorm = _norm(leadName)
        const _parts = _leadNorm.split(' ').filter(w => w.length >= 3)
        const _first = _parts[0], _last = _parts[_parts.length - 1]
        let suggestion = null
        for (const sel of suggestionSels) {
          const candidates = Array.from(document.querySelectorAll(sel)).filter(el => el.offsetParent !== null)
          for (const c of candidates) {
            const t = _norm(c.textContent)
            if (!t) continue
            const match = t.includes(_leadNorm) || (_leadNorm.length > 6 && _leadNorm.includes(t)) ||
              (_first && _last && _first !== _last && t.includes(_first) && t.includes(_last))
            if (match) { suggestion = c; break }
          }
          if (suggestion) break
        }
        if (!suggestion) {
          console.warn(`[Orion content] v0.9.5 — ninguna sugerencia del typeahead coincide con "${leadName}" → ABORT recipient_mismatch (no mensajear al equivocado)`)
          return { action: 'send_followup', status: 'error', error: 'recipient_mismatch', reason: 'typeahead_no_match', leadName, currentUrl: location.href }
        }
        if (suggestion) {
          console.log(`[Orion content] v0.9.5 — sugerencia recipient VERIFICADA matchea "${leadName}"`)
          suggestion.scrollIntoView({ block: 'center', behavior: 'instant' })
          await sleep(randInt(200, 400))
          suggestion.click()
          await sleep(randInt(1500, 2500))  // esperar que editor aparezca

          // Re-buscar el editor ahora que el recipient está seleccionado
          const reEditorSel = await waitForSelector(editorSels, 10000)
          editor = reEditorSel ? document.querySelector(reEditorSel) : null
          if (!editor || editor.offsetParent === null) {
            editor = Array.from(document.querySelectorAll('div[contenteditable="true"]'))
              .find(el => {
                if (el.offsetParent === null) return false
                const r = el.getBoundingClientRect()
                return r.width > 100 && r.height > 25
              })
          }
          if (editor) console.log(`[Orion content] v0.6.48 ✅ editor encontrado tras selección de recipient`)
        } else {
          console.warn('[Orion content] v0.6.48 — no apareció sugerencia en dropdown')
        }
      } catch (err) {
        console.warn(`[Orion content] v0.6.48 — fallo seleccionar recipient: ${err.message}`)
      }
    }

    // Patrón "compose-page-2nd-degree": estamos en /messaging/compose/, el editor
    // nunca aparece, y los únicos elementos editables son el search global + el
    // textarea oculto de recaptcha. LinkedIn esconde el editor cuando es 2do grado
    // SIN redirigir a /sales/ ni mostrar "créditos disponibles". Auto-revert.
    if (!editor && isComposePage && allEditables.length <= 3) {
      const hasOnlyNoise = allEditables.every(e =>
        (e.classes ?? '').includes('search-global-typeahead') ||
        (e.classes ?? '').includes('g-recaptcha-response')
      )
      if (hasOnlyNoise) {
        return {
          action: 'send_followup',
          status: 'error',
          error:  'lead_not_first_degree',
          reason: 'compose_no_editor_recaptcha_only',
          url:    location.href,
        }
      }
    }

    if (!editor) {
      return {
        action: 'send_followup',
        status: 'error',
        error:  'thread_editor_not_found',
        url:    location.href,
        debugEditables: allEditables.map(({ el, ...rest }) => rest),  // sin la ref DOM
      }
    }
  }
  await sleep(randInt(1500, 2500))  // hidratación

  // 4. Sanity check: header del thread debería contener nombre del lead
  let headerName = ''
  if (leadName) {
    headerName = readThreadHeader()
    const firstName = leadName.split(/\s+/)[0].toLowerCase()
    if (headerName && !headerName.toLowerCase().includes(firstName)) {
      console.warn(`[Orion content] Thread header mismatch: expected "${firstName}", got "${headerName}"`)
      return {
        action: 'send_followup',
        status: 'error',
        error:  'thread_header_mismatch',
        expected: leadName,
        gotHeader: headerName,
      }
    }
  }

  // 4.4 v0.9.11 SAFETY (compose): verificación SHADOW-AWARE de InMail(2do grado) + destinatario.
  // Las guardas viejas (~3136, detectNotMessageable) usan document.*/innerText → CIEGAS al
  // shadow DOM del overlay "Nuevo mensaje". Tras el deep-pierce de 0.9.10 el bot encontraba y
  // tecleaba el composer shadow — INCLUIDO el de InMail de un 2do-grado — y compose no
  // verificaba destinatario (headerName vacío). Esto corre sobre el shadow root REAL del
  // composer. Fail-closed: si es InMail, o no confirmo que el destinatario sea el lead → NO envía.
  // v0.9.13: guarda compartida fail-closed (InMail 2do-grado + destinatario). Misma función
  // que usa sendFollowupFromProfile → las dos rutas de compose ya no divergen.
  if (isComposePage) {
    const _guard = composeInmailRecipientGuard(leadName)
    if (_guard) return _guard
  }

  // 4.5 v0.6.45 PRE-SEND GUARD: leer los últimos mensajes del thread y verificar
  // si ya respondimos. Caso Kelisha: 12 intentos fallaron por timeout/error pero
  // uno SÍ se envió en LinkedIn — DB no se enteró y scheduler reagenda. Esta guardia
  // detecta "último mensaje del thread es OUTBOUND nuestro" → skip + report al bridge.
  const lastOutboundCheck = detectLastMessageIsOutbound()
  if (lastOutboundCheck.isOurs) {
    console.log(`[Orion content] ✋ pre-send guard: último msg del thread ya es nuestro (${lastOutboundCheck.preview?.slice(0,50)}…) — skip envío duplicado`)
    return {
      action: 'send_followup',
      status: 'already_responded',  // bridge ingest lo trata como envío silencioso
      headerName,
      lastOutboundPreview: lastOutboundCheck.preview?.slice(0, 200),
      lastOutboundTs: lastOutboundCheck.timestamp,
      note: 'thread ya tiene outbound como último msg — no se envía duplicado',
    }
  }

  // 4.6 v0.7.8 AWAITING-RESPONSE LOCK CHECK — antes de gastar typing/Send.
  // Si LinkedIn aplicó la "ban window" (banner + composer/send disabled), abortamos
  // y reportamos status='awaiting_response' para que el bridge marque el lead
  // sin consumir retry ni avanzar fu_count.
  try {
    const lock = await detectAwaitingResponseLock(editor)
    if (lock.locked) {
      console.log(`[Orion content] ⏳ awaiting_response lock: ${lock.reason}`)
      try { vlOnPhaseTimeout(`awaiting_response_${lock.reason}`) } catch {}
      return {
        action: 'send_followup',
        status: 'awaiting_response',
        reason: lock.reason,
        signals: lock.signals,
        headerName,
        url: location.href,
      }
    }
  } catch (e) {
    console.warn(`[Orion content] awaiting_response detector error:`, e?.message || e)
  }

  // 5. v0.7.2 MICRO-PHASE FLOW
  console.log(`[Orion content] Typing FU (${message.length} chars) en thread de ${headerName || '?'}`)
  await setPhase('thread_opened', { leadName, msgLen: message.length })
  const runner = new MicroPhaseRunner(_currentCommandId, 'send_followup')
  const expectedTail = (message ?? '').slice(0, 8000).slice(-25).toLowerCase().replace(/\s+/g, ' ').trim()
  const expectedHead = (message ?? '').slice(0, 30).toLowerCase().replace(/\s+/g, ' ').trim()

  // v0.9.3: cerrar el modal de upsell (Sales Navigator/Premium) que LinkedIn antepone
  // sobre el composer en /messaging/compose y tapa el editor (rompe el FU).
  if (dismissUpsellModals()) { await sleep(randInt(400, 800)); dismissUpsellModals() }

  // µ-Phase: editor_focused — esperar a que activeElement sea el editor
  // v0.7.3: timeout dinámico desde runtime_config (auto-tuned por phase-analyzer L3)
  editor.focus()
  await runner.runPhase('editor_focused', () => {
    if (document.activeElement === editor) return { tag: editor.tagName, cls: (editor.className||'').slice(0,60) }
    editor.focus()
    return null
  }, { timeoutMs: getPhaseTimeout('editor_focused', 3000), intervalMs: 200 })

  // Typing (humanType es síncronamente costoso; mark phase started/ended)
  await runner.mark('typing_started', { msgLen: message.length, expectedHead: expectedHead.slice(0, 20), chunkMode: message.length > 300 })
  // v0.7.5: progress callback emite µ-phase typing_progress cada 25%
  await humanTypeContentEditable(editor, message.slice(0, 8000), {
    progressCallback: async ({ charsTyped, total, pct }) => {
      await runner.mark(`typing_progress_${pct}pct`, { charsTyped, total })
      // Mantener phase activa para que SW no asuma stale durante typing largo
      await setPhase('typing', { leadName, charsTyped, total, pct })
    },
  })

  // µ-Phase: typing_complete — verificar que el editor contiene el mensaje completo.
  // v0.9.3 ROBUSTO: (1) re-query el editor VIVO cada poll — el ref `editor` puede quedar
  // stale si React re-renderiza el composer tras teclear (editor.textContent vacío aunque
  // el texto SÍ esté en el DOM nuevo → typing_complete_timeout pese a mensaje visible).
  // (2) aceptar por head + RATIO de longitud (0.9–1.2), no solo endsWith(tail) estricto
  // (fallaba por un char final/normalización aunque el mensaje estuviera completo).
  const expectedFullNorm = (message ?? '').slice(0, 8000).toLowerCase().replace(/\s+/g, ' ').trim()
  // v0.9.6 SAFE: preferir el ref original si sigue conectado (es el composer correcto ya
  // validado). Solo si se re-renderizó (detached) re-query el composer ESPECÍFICO — nunca
  // un genérico [contenteditable][role=textbox] (el buscador u otro aparecen antes en el
  // DOM y querySelector con coma devolvía el equivocado → 6.5 leía vacío → borraba el
  // composer con el mensaje "al querer enviar"). Causa del clear-sin-enviar de Martin.
  const liveEditor = () => {
    if (editor && editor.isConnected) return editor
    // v0.9.8: perforar shadow DOM (composer del overlay "Nuevo mensaje" vive en shadow root)
    return deepQuery('.msg-form__contenteditable')
      || deepQuery('div.msg-form__msg-content-container [contenteditable="true"]')
      || deepQuery('div[contenteditable="true"][role="textbox"]')
      || editor
  }
  try {
  await runner.runPhase('typing_complete', () => {
    const live = liveEditor()
    const actual = (live?.textContent ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
    if (actual.length < Math.min(20, expectedHead.length)) return null
    // v0.9.10 FIX RAÍZ: comparar SIN espacios. Evidencia (_typingDiag): el texto SÍ
    // aterriza (editorLen 392/405, inShadow=false) pero hasHead nunca matcheaba porque
    // el mensaje trae \n\n → en expectedHead normaliza a UN espacio ("tal! se"), pero al
    // teclear el \n se vuelve <br> y DESAPARECE de editor.textContent ("tal!se"). Sin
    // espacios, ambos lados coinciden. Causa real del ~82% de typing_complete_timeout.
    const noWs = (s) => s.replace(/\s+/g, '')
    const actualNoWs = noWs(actual)
    const expFullNoWs = noWs(expectedFullNorm)
    const hasHead = actualNoWs.startsWith(noWs(expectedHead).slice(0, 18))
    const hasTail = expectedTail.length === 0 || actualNoWs.endsWith(noWs(expectedTail).slice(-12))
    const ratio = expFullNoWs.length > 0 ? actualNoWs.length / expFullNoWs.length : 1
    const lenOk = ratio >= 0.9 && ratio <= 1.2
    if (hasHead && (hasTail || lenOk)) {
      return { editorLen: actual.length, expectedLen: message.length, ratio: +ratio.toFixed(3), via: hasTail ? 'head+tail' : 'head+ratio' }
    }
    return null
  }, { timeoutMs: getPhaseTimeout('typing_complete', 4000), intervalMs: 250 })
  } catch (tcErr) {
    // v0.9.9 DIAG: estado EXACTO del editor cuando typing_complete NO confirma (isolated world).
    // Los tests de consola (página) mostraron que encontrar+teclear el composer shadow funciona,
    // pero el bot real falla → esto captura qué ve el content script en el momento del timeout.
    const _leD = liveEditor()
    let inShadow = null, activeInShadow = null
    try { inShadow = editor?.getRootNode() instanceof ShadowRoot } catch {}
    try { const rn = editor?.getRootNode(); activeInShadow = (rn && 'activeElement' in rn) ? (rn.activeElement === editor) : null } catch {}
    const _typingDiag = {
      editorLen: editor?.textContent?.length ?? -1,
      liveLen: _leD?.textContent?.length ?? -1,
      sameElem: editor === _leD,
      editorConnected: editor?.isConnected ?? null,
      inShadow,
      activeIsEditor: (document.activeElement === editor) || activeInShadow,
      editorCls: (editor?.className ?? '').toString().slice(0, 40),
      sample: (editor?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      expectedHead: expectedHead.slice(0, 30),
      expectedLen: message.length,
    }
    console.warn('[Orion content] v0.9.9 typing_complete DIAG:', JSON.stringify(_typingDiag))
    return { action: 'send_followup', status: 'error', error: String(tcErr?.message || tcErr), _typingDiag, headerName, currentUrl: location.href }
  }

  await setPhase('typed', { leadName, charsTyped: editor.textContent?.length ?? 0 })
  await sleep(randInt(500, 1000))

  // 6. dryRun: limpiar editor + return sin enviar
  if (dryRun) {
    console.log('[Orion content] DRY RUN — limpiando editor sin enviar')
    // Limpiar contenido del editor para no dejar texto huérfano
    editor.innerHTML = ''
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    return {
      action: 'send_followup',
      status: 'dry_run_ok',
      editorUsed: true,
      messageLength: message.length,
      headerName,
    }
  }

  // 6.5 VERIFICACIÓN: confirmar que el editor contiene el mensaje completo antes
  // de clickear Send. Defensa contra typing interrumpido / texto truncado.
  // v0.7.11 fix: canonicalizar AMBOS lados con replace(/\s+/g,' ').trim()
  // — coincide con la normalización de la µ-phase typing_complete y elimina
  // el false-positive truncated que disparaba CRLF en el mensaje original
  // (cada \r\n perdía 1 char en editor.textContent porque insertText convierte
  // \n → <br>, no serializable de vuelta). Compare en forma canónica único.
  const canon = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
  const _le65 = liveEditor()  // v0.9.3: editor vivo (no el ref posiblemente stale)
  const editorRaw = (_le65?.textContent ?? _le65?.innerText ?? '')
  const expectedRaw = message.slice(0, 8000)
  const editorText = canon(editorRaw)
  const expectedText = canon(expectedRaw)
  const editorLen = editorText.length
  const expectedLen = expectedText.length
  // v0.9.10: ratio SIN espacios. canon() colapsa \n→espacio en expected, pero en
  // editor.textContent el \n (=<br>) DESAPARECE → expectedLen infla vs editorLen y
  // dispara tooShort falso en mensajes con muchos saltos. Sin whitespace = ratio fiel.
  const _nw = (s) => String(s ?? '').replace(/\s+/g, '')
  const lenRatio = _nw(expectedRaw).length > 0 ? _nw(editorRaw).length / _nw(expectedRaw).length : 0
  // Comparamos últimos 30 chars (tail, ya canónico) — si typing fue cortado, el tail no coincide
  const tailExpected = expectedText.slice(-30)
  const tailEditor = editorText.slice(-30)
  // Detección de:
  //  - typing CORTO (ratio < 0.95) → interrumpido/truncado
  //  - typing DOBLE/entrelazado (ratio > 1.15) → 2 loops concurrentes ("HHoollaa")
  //  - tail no coincide → contenido corrupto
  const tooShort = lenRatio < 0.95
  const tooLong  = lenRatio > 1.15
  const tailMismatch = !editorText.endsWith(tailExpected.slice(-15))
  // v0.9.3: tail-mismatch con longitud OK ya NO bloquea (era un false-positive que dejaba
  // el mensaje escrito sin enviar). Solo bloqueamos corrupción real (muy corto / doblado).
  if (tailMismatch && !tooShort && !tooLong) {
    console.warn(`[Orion content] typing: tail no coincide exacto pero longitud OK (ratio ${lenRatio.toFixed(2)}) → se ACEPTA y se envía`)
  }
  if (tooShort || tooLong) {
    const reason = tooLong ? 'garbled_or_doubled' : 'truncated'
    console.warn(`[Orion content] ⚠️  message_typing_invalid (${reason}): editor=${editorLen} expected=${expectedLen} ratio=${lenRatio.toFixed(2)}`)
    // Limpiar el editor corrupto para no dejar basura visible
    try { editor.innerHTML = ''; editor.dispatchEvent(new Event('input', { bubbles: true })) } catch {}
    return {
      action: 'send_followup',
      status: 'error',
      error:  'message_typing_incomplete',
      reason,
      editorLen,
      expectedLen,
      lenRatio: Number(lenRatio.toFixed(3)),
      editorTail: tailEditor,
      expectedTail: tailExpected,
      editorRawLen: editorRaw.length,
      expectedRawLen: expectedRaw.length,
    }
  }
  console.log(`[Orion content] ✅ Editor verified (canon): ${editorLen}/${expectedLen} chars match`)

  // 7. Click Send button (botón regular del thread footer / compose page)
  // El send button puede aparecer tardío en compose page — pequeño retry
  let sendBtn = findThreadSendButton(editor)
  if (!sendBtn) {
    await sleep(1200)
    sendBtn = findThreadSendButton(editor)
  }
  if (!sendBtn) {
    return {
      action: 'send_followup',
      status: 'error',
      error:  'send_button_not_found',
      path:   isComposePage ? 'compose_page' : 'thread_page',
      currentUrl: location.href,
      debugButtons: listAllVisibleButtonsVerbose(),
    }
  }
  console.log(`[Orion content] Send button: aria="${sendBtn.getAttribute('aria-label')}" cls="${(sendBtn.className ?? '').slice(0, 60)}"`)

  // µ-Phase: send_button_enabled — esperar a que el botón sea clickeable
  // (LinkedIn lo deshabilita durante typing/processing intermitentemente)
  await runner.runPhase('send_button_enabled', () => {
    if (!sendBtn.isConnected) return null
    if (sendBtn.disabled) return null
    if (sendBtn.getAttribute('aria-disabled') === 'true') return null
    return { aria: sendBtn.getAttribute('aria-label'), cls: (sendBtn.className||'').slice(0,60) }
  }, { timeoutMs: getPhaseTimeout('send_button_enabled', 4000), intervalMs: 200 })

  // v0.7.3: FALLBACK CHAIN con orden DINÁMICO desde runtime_config (L4 auto-reorder).
  // Cada método verifica si el editor se vació (LinkedIn vacía post-send exitoso).
  const sendBeforeText = (editor.textContent ?? '').trim()
  const tryAndVerifySend = async (label, action) => {
    await action()
    try {
      return await runner.runPhase(`editor_cleared_via_${label}`, () => {
        if (!editor.isConnected) return { method: label, reason: 'editor_detached_after_send' }
        const current = (editor.textContent ?? '').trim()
        if (current.length < sendBeforeText.length * 0.1) return { method: label }
        return null
      }, { timeoutMs: getPhaseTimeout(`editor_cleared_via_${label}`, 4500), intervalMs: 300 })
    } catch { return null }
  }

  const sendMethodActions = {
    humanClick: async () => {
      await humanClick(sendBtn)
      await setPhase('send_clicked', { leadName, sendBtnAria: sendBtn.getAttribute('aria-label'), method: 'humanClick' })
    },
    ctrl_enter: async () => {
      editor.focus()
      await sleep(200)
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true }))
    },
    plain_enter: async () => {
      editor.focus()
      await sleep(200)
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))
    },
    form_submit: async () => {
      const form = editor.closest('form, .msg-form, [class*="msg-form"]')
      if (form) {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        if (typeof form.requestSubmit === 'function') form.requestSubmit()
      }
    },
  }
  const sendOrder = getSendMethodOrder().filter(m => sendMethodActions[m])
  console.log(`[Orion content] send order (dinámico): ${sendOrder.join(' → ')}`)

  let sendMethod = null
  for (const methodName of sendOrder) {
    if (sendMethod) break
    sendMethod = await tryAndVerifySend(methodName, sendMethodActions[methodName])
    if (sendMethod && methodName !== 'humanClick') {
      await runner.mark(`send_clicked_via_${methodName}`)
    }
  }

  if (!sendMethod) {
    await runner.mark('send_all_methods_failed', { tried: ['humanClick','ctrl_enter','plain_enter','form_submit'] })
    return {
      action: 'send_followup',
      status: 'error',
      error: 'send_method_exhausted',
      headerName,
      microPhases: runner.getPhases().slice(-15),
    }
  }

  console.log(`[Orion content] ✅ send vía ${sendMethod.method}`)
  await setPhase('send_clicked', { leadName, method: sendMethod.method })

  // µ-Phase: message_in_dom — confirmar que el mensaje aparece en el thread
  let domConfirm = null
  try {
    domConfirm = await runner.runPhase('message_in_dom', () => {
      // v0.7.16 L6: pool ampliado + match permisivo (slice 20, normalización agresiva,
      // fallback en innerHTML). Mismo patrón que confirmMessageSent().
      const messages = document.querySelectorAll(
        '.msg-s-message-list__event, .msg-s-event-listitem, [class*="msg-s-event"], ' +
        '.msg-s-message-group, [class*="message-group"], ' +
        '.msg-s-message-list li, li[role="listitem"]'
      )
      const normalize = (s) => (s ?? '').toLowerCase()
        .replace(/[ ​-‍﻿]/g, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ').trim()
      const fingerprint = normalize(message).slice(0, 20)
      if (!fingerprint || fingerprint.length < 8) return null
      for (let i = messages.length - 1; i >= Math.max(0, messages.length - 8); i--) {
        const t = normalize(messages[i]?.textContent)
        if (t.includes(fingerprint)) {
          return { foundAt: i, totalMessages: messages.length, sendMethod: sendMethod.method, matchedOn: 'textContent' }
        }
        const html = normalize((messages[i]?.innerHTML ?? '').replace(/<[^>]+>/g, ' '))
        if (html.includes(fingerprint)) {
          return { foundAt: i, totalMessages: messages.length, sendMethod: sendMethod.method, matchedOn: 'innerHTML' }
        }
      }
      return null
    }, { timeoutMs: 12000, intervalMs: 500 })
  } catch {
    // Si no encontramos en DOM pero editor se vació, asumimos sent_unconfirmed
    domConfirm = null
  }

  const confirmation = { confirmed: !!domConfirm, ...(domConfirm ?? {}) }
  const confirmed = confirmation.confirmed
  if (confirmed) {
    await setPhase('send_confirmed', { leadName, sendMethod: sendMethod.method, foundAt: domConfirm.foundAt })
  }

  // Sub-Fase 3.8: si veníamos de /messaging/compose/, capturar thread_id post-send.
  // LinkedIn redirige a /messaging/thread/<new_id>/ tras enviar.
  let threadIdCaptured = null
  if (isComposePage) {
    // Wait hasta 6s a que URL cambie a /thread/
    const waitStart = Date.now()
    while (Date.now() - waitStart < 6000) {
      if (/\/messaging\/thread\//.test(location.pathname)) break
      await sleep(300)
    }
    const m = location.href.match(/\/messaging\/thread\/([^/?#]+)/)
    if (m) threadIdCaptured = decodeURIComponent(m[1])
    // Fallback: scrape DOM por algún anchor al thread recién creado
    if (!threadIdCaptured) {
      const a = document.querySelector('a[href*="/messaging/thread/"]')
      if (a) {
        const m2 = a.getAttribute('href').match(/\/messaging\/thread\/([^/?#]+)/)
        if (m2) threadIdCaptured = decodeURIComponent(m2[1])
      }
    }
  }

  // v0.7.0 FSM: phase final + status diferenciado por confirmación
  await setPhase('done', { leadName, confirmed, sentAt: new Date().toISOString() })
  return {
    action: 'send_followup',
    status: confirmed ? 'sent_confirmed' : 'sent_unconfirmed',
    editorUsed: true,
    headerName,
    path: isComposePage ? 'compose_page' : 'thread_page',
    threadIdCaptured,
    sentAt: new Date().toISOString(),
    confirmation: confirmation ?? null,
    sendMethod: sendMethod?.method ?? null,
    microPhases: runner.getPhases().slice(-25),  // últimas 25 transitions
  }
}

// ── Sub-Fase 3.8: sendFollowupFromProfile ────────────────────────────────────
// Cuando el lead aceptó invite sin nota, no hay thread previo. Navegamos a
// /in/<vanity>/, click botón "Mensaje", esperamos overlay compose, escribimos
// + enviamos. LinkedIn crea el thread y nos da thread_id en el URL post-send.

async function sendFollowupFromProfile(payload) {
  const { message, leadName, dryRun } = payload
  console.log(`[Orion content] sendFollowupFromProfile: lead=${leadName}, dryRun=${dryRun}`)

  // 1. Captcha check
  if (/\/checkpoint|\/challenge|\/authwall/.test(location.href)) {
    return { action: 'send_followup', status: 'error', error: 'captcha_or_checkpoint' }
  }

  // 2. Esperar a que el TOP CARD del perfil aparezca (más confiable que sleep fijo)
  const topCardSels = [
    'main section.artdeco-card',
    'main .pv-top-card',
    'main [class*="ph5"][class*="pb5"]',
    'main [class*="top-card"]',
  ]
  await waitForSelector(topCardSels, 12000)
  await sleep(randInt(2000, 3500))  // hidratación React + load buttons

  // ★ Detectar si invite sigue PENDIENTE → revertir false positive de check_sent_invites
  // No bloqueamos por grado (LinkedIn permite mensajes a 2do con Sales Nav/Premium).
  // Solo bloqueamos si el invite NO fue aceptado (todavía pending).
  if (isInvitePending()) {
    return {
      action: 'send_followup',
      status: 'error',
      error:  'lead_invite_still_pending',
      note:   'Lead aún en pending — check_sent_invites false positive. Bridge revertirá a invite_sent.',
      currentUrl: location.href,
    }
  }

  let messageBtn = findProfileMessageButton(leadName)

  // Fallback 1: scroll al top y reintentar (a veces hidratación tardía)
  if (!messageBtn) {
    window.scrollTo({ top: 0, behavior: 'instant' })
    await sleep(1500)
    messageBtn = findProfileMessageButton(leadName)
  }

  // Fallback 2: si hay botón "Más" en top card, abrir dropdown y buscar dentro
  if (!messageBtn) {
    const moreBtn = findProfileMoreButton()
    if (moreBtn) {
      console.log('[Orion content] No directo "Mensaje" — probando dropdown "Más"')
      await humanClick(moreBtn)
      await sleep(randInt(1200, 2200))
      messageBtn = findMessageInDropdown()
    }
  }

  if (!messageBtn) {
    // 2do grado detection: si NO hay "Mensaje" pero SÍ "Seguir" o "Conectar"
    // como botones principales del top card → el lead no es 1er grado.
    // Dispara el revert automático en extension-bridge.
    const topBtns = Array.from(document.querySelectorAll('main button, main a[role="button"], .pv-top-card button'))
      .filter(b => b.offsetParent !== null)
      .slice(0, 30)
    const hasFollowBtn = topBtns.some(b => {
      const t = (b.textContent ?? '').trim().toLowerCase()
      const aria = (b.getAttribute('aria-label') ?? '').toLowerCase()
      return t === 'seguir' || t === 'follow' || /^(seguir|follow)\b/.test(aria)
    })
    const hasConnectBtn = topBtns.some(b => {
      const t = (b.textContent ?? '').trim().toLowerCase()
      const aria = (b.getAttribute('aria-label') ?? '').toLowerCase()
      return t === 'conectar' || t === 'connect' || /^(invitar|invite|connect|conectar)\b/.test(aria)
    })
    // Si vemos "Seguir" o "Conectar" prominente → confirmado 2do grado / no aceptado
    if (hasFollowBtn || hasConnectBtn) {
      return {
        action: 'send_followup',
        status: 'error',
        error:  'lead_not_first_degree',
        reason: hasConnectBtn ? 'profile_shows_connect_btn' : 'profile_shows_follow_only',
        url:    location.href,
      }
    }
    return {
      action: 'send_followup',
      status: 'error',
      error:  'profile_message_button_not_found',
      url:    location.href,
      topCardBtns: dumpTopCardButtons(),
      visibleBtns: listVisibleButtons().slice(0, 12),
    }
  }

  // Inspeccionar el botón antes de actuar
  const btnTag = messageBtn.tagName
  const btnHref = messageBtn.getAttribute?.('href') ?? null
  const btnAria = messageBtn.getAttribute?.('aria-label') ?? ''
  const btnText = (messageBtn.textContent ?? '').trim().slice(0, 60)
  console.log(`[Orion content] Botón Mensaje: tag=${btnTag} text="${btnText}" aria="${btnAria}" href="${btnHref}"`)

  // Sub-Fase 2.3 insight: LinkedIn filtra clicks sintéticos en anchors con SPA
  // route href (isTrusted=false). Si es anchor con href, navegamos directo.
  const isSpaAnchor = btnTag === 'A' && btnHref && (
    /\/messaging\//.test(btnHref) || /overlay\/compose/.test(btnHref)
  )

  if (isSpaAnchor) {
    // CONTENT.JS NO PUEDE NAVEGAR vía location.href si LinkedIn hace full reload —
    // content.js muere antes de retornar y bridge ve "message channel closed".
    // SOLUCIÓN: devolver el href al background.js que navega via chrome.tabs.update
    // (no destruye content.js de la misma forma) y re-dispatcha el comando.
    const fullUrl = btnHref.startsWith('http') ? btnHref : `https://www.linkedin.com${btnHref}`
    console.log(`[Orion content] Anchor SPA — devolviendo needs_redirect a background: ${fullUrl}`)
    return {
      action: 'send_followup',
      status: 'needs_redirect',
      redirectUrl: fullUrl,
      btnHref,
      note: 'Background.js debe navegar via chrome.tabs.update + re-dispatch del comando',
    }
  }

  // Botón regular: click normal (humanClick humanizado)
  console.log('[Orion content] Botón regular — humanClick')
  await humanClick(messageBtn)
  await sleep(randInt(2500, 4000))  // espera overlay open + hidratación React

  // 3. Buscar el editor del overlay compose — extended timeout + más selectores
  const overlayEditorSels = [
    '.msg-form__contenteditable',
    'div.msg-form__contenteditable',
    '[class*="msg-form__contenteditable"]',
    '[class*="msg-form"] [contenteditable="true"]',
    '[class*="overlay"] [contenteditable="true"]',
    '[class*="compose"] [contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label*="mensaje" i]',
    'div[contenteditable="true"][aria-label*="message" i]',
    'div[contenteditable="true"][aria-label*="escribir" i]',
    'div[contenteditable="true"][aria-label*="write" i]',
    '.msg-overlay-conversation-bubble [contenteditable="true"]',
    '.msg-overlay-container [contenteditable="true"]',
    'textarea[name*="message" i]',
    'textarea[aria-label*="mensaje" i]',
  ]
  // 20s timeout (estaba 10s — overlay puede tardar en hidratarse)
  const editorSel = await waitForSelector(overlayEditorSels, 20000)
  let editor = editorSel ? document.querySelector(editorSel) : null
  if (!editor || editor.offsetParent === null) {
    // Fallback: cualquier contenteditable o textarea visible >100w
    await sleep(2500)
    editor = Array.from(document.querySelectorAll('div[contenteditable="true"], textarea'))
      .find(el => {
        if (el.offsetParent === null) return false
        const r = el.getBoundingClientRect()
        return r.width > 100 && r.height > 20
      })
  }
  // v0.9.8 SHADOW DOM: el composer del overlay "Nuevo mensaje" vive en un shadow root
  // (top>shadow[div]) → document.querySelector no lo ve. Perforar shadow DOM.
  if (!editor || editor.offsetParent === null) {
    for (const sel of overlayEditorSels) {
      const deep = deepQueryAll(sel).find(el => el.offsetParent !== null)
      if (deep) { editor = deep; console.log(`[Orion content] v0.9.8 ✅ overlay editor en SHADOW DOM vía "${sel}"`); break }
    }
  }
  if (!editor) {
    // Debug exhaustivo: dump del DOM relevante para diagnosticar
    const allEditables = Array.from(document.querySelectorAll('div[contenteditable], textarea, input[type="text"]'))
      .slice(0, 20)
      .map(el => ({
        tag: el.tagName,
        editable: el.getAttribute('contenteditable'),
        type: el.getAttribute('type'),
        aria: (el.getAttribute('aria-label') ?? '').slice(0, 60),
        classes: (el.className?.toString() ?? '').slice(0, 100),
        visible: el.offsetParent !== null,
        rect: el.offsetParent ? (() => { const r=el.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}` })() : null,
      }))
    // Overlays / modales visibles
    const overlays = Array.from(document.querySelectorAll('[class*="overlay"], [class*="modal"], [role="dialog"]'))
      .slice(0, 10)
      .map(el => ({
        classes: (el.className?.toString() ?? '').slice(0, 100),
        visible: el.offsetParent !== null,
        hasContentEditable: !!el.querySelector('[contenteditable="true"]'),
      }))
    // ¿Tenemos iframes? LinkedIn a veces embebe compose en iframe
    const iframes = Array.from(document.querySelectorAll('iframe')).map(el => ({
      src: (el.getAttribute('src') ?? '').slice(0, 80),
      visible: el.offsetParent !== null,
    }))
    return {
      action: 'send_followup',
      status: 'error',
      error:  'compose_editor_not_found_in_overlay',
      currentUrl: location.href,
      allEditables,
      overlays,
      iframes,
      visibleBtns: listVisibleButtons().slice(0, 10),
    }
  }

  // v0.9.13 SAFETY: guarda compartida ANTES de teclear — cierra el hueco de InMail a 2do-grado
  // que la auditoría (02-jul) encontró: esta ruta (sendFollowupFromProfile, la PRIMARIA del primer
  // FU) no tenía ninguna verificación anti-InMail/destinatario. Fail-closed: si es InMail o no
  // confirmo el destinatario → NO envía.
  {
    const _guard = composeInmailRecipientGuard(leadName)
    if (_guard) return _guard
  }

  // 4. Type humanizado
  console.log(`[Orion content] Typing en compose overlay (${message.length} chars)`)
  editor.focus()
  await sleep(randInt(300, 600))
  await humanTypeContentEditable(editor, message.slice(0, 8000))
  await sleep(randInt(500, 1000))

  // 5. dryRun: cerrar overlay sin enviar
  if (dryRun) {
    console.log('[Orion content] DRY RUN compose-new — limpiando editor')
    editor.innerHTML = ''
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    // Cerrar overlay si posible
    const closeBtn = document.querySelector('.msg-overlay-bubble-header button[aria-label*="cerrar" i], .msg-overlay-bubble-header button[aria-label*="close" i]')
    if (closeBtn) { try { await humanClick(closeBtn) } catch {} }
    return {
      action: 'send_followup',
      status: 'dry_run_ok',
      editorUsed: true,
      messageLength: message.length,
      path: 'profile_compose_new',
    }
  }

  // 6. Click Send button del overlay
  let sendBtn = findThreadSendButton(editor)
  if (!sendBtn) {
    await sleep(1200)
    sendBtn = findThreadSendButton(editor)
  }
  if (!sendBtn) {
    return {
      action: 'send_followup',
      status: 'error',
      error:  'send_button_not_found_in_overlay',
      currentUrl: location.href,
      debugButtons: listAllVisibleButtonsVerbose(),
    }
  }
  console.log(`[Orion content] Send button (overlay): aria="${sendBtn.getAttribute('aria-label')}" cls="${(sendBtn.className ?? '').slice(0, 60)}"`)
  await humanClick(sendBtn)
  await sleep(randInt(2500, 3500))

  // 7. Capturar thread_id del DOM (LinkedIn crea el thread y agrega el ID a
  // algún atributo o URL del overlay). Buscamos en hrefs visibles + URL actual.
  let capturedThreadId = null
  // En la URL actual
  const urlMatch = location.href.match(/messaging\/thread\/([^/?#]+)/)
  if (urlMatch) capturedThreadId = decodeURIComponent(urlMatch[1])
  // O en cualquier link visible al thread
  if (!capturedThreadId) {
    const threadAnchor = document.querySelector('a[href*="/messaging/thread/"]')
    if (threadAnchor) {
      const m = threadAnchor.getAttribute('href').match(/\/messaging\/thread\/([^/?#]+)/)
      if (m) capturedThreadId = decodeURIComponent(m[1])
    }
  }

  return {
    action: 'send_followup',
    status: 'sent',
    editorUsed: true,
    path: 'profile_compose_new',
    threadIdCaptured: capturedThreadId,
    sentAt: new Date().toISOString(),
  }
}

// Detecta el estado del invite del lead viendo el top card.
// Returns: 'connected_1st', 'pending', 'not_connected', 'unknown'
function detectLeadInviteStatus() {
  // Buscar el indicador de grado cerca del h1 (ej: "• 1er" o "• 2º" o "• 3º")
  const h1 = Array.from(document.querySelectorAll('main h1')).find(h => h.offsetParent !== null)
  if (h1) {
    // El degree indicator suele estar en un span o div cerca al h1
    const container = h1.closest('section, div') ?? h1.parentElement
    const text = (container?.textContent ?? '').toLowerCase()
    if (/•\s*1(er|st)/.test(text)) return 'connected_1st'
    if (/•\s*2[ºoº]/.test(text)) return 'not_first_degree'
    if (/•\s*3[ºoº]/.test(text)) return 'not_first_degree'
  }
  // Check si el top card tiene botón "+ Seguir" como primario (indica no 1er degree)
  const topCard = findTopCard() ?? document
  const buttons = Array.from(topCard.querySelectorAll('button'))
  const hasFollow = buttons.some(b => {
    if (b.offsetParent === null) return false
    const t = (b.textContent ?? '').trim().toLowerCase()
    return /^(\+ )?seguir$|^(\+ )?follow$/.test(t)
  })
  const hasPending = buttons.some(b => {
    if (b.offsetParent === null) return false
    const t = (b.textContent ?? '').trim().toLowerCase()
    return t === 'pendiente' || t === 'pending'
  })
  if (hasPending) return 'pending'
  if (hasFollow) return 'not_first_degree'
  return 'unknown'
}

// Detecta si el invite sigue Pendiente (puede estar en dropdown "Más" o como botón directo)
function isInvitePending() {
  // Click directo al botón "Pendiente" si existe sin abrir dropdown
  const topCard = findTopCard() ?? document
  const allBtns = Array.from(topCard.querySelectorAll('button, [role="menuitem"]'))
  return allBtns.some(b => {
    const t = (b.textContent ?? '').trim().toLowerCase()
    return t === 'pendiente' || t === 'pending'
  })
}

// Find botón "Enviar mensaje" / "Mensaje" / "Message" en el top card del LEAD.
// v0.9.13: GUARDA COMPARTIDA fail-closed contra InMail (2do grado) + destinatario equivocado,
// para CUALQUIER ruta de compose (send_followup overlay + sendFollowupFromProfile). DEEP: perfora
// el shadow DOM del overlay "Nuevo mensaje". Devuelve null si OK, o un objeto error si debe
// abortar SIN enviar. Única fuente de verdad → las rutas ya no divergen (auditoría 02-jul).
function composeInmailRecipientGuard(leadName) {
  // (1) InMail / 2do grado — texto "créditos"/InMail + botones InMail (deep = shadow-aware)
  const inmailRe = /cr[eé]ditos disponibles|inmail credits?|de \d+ cr[eé]ditos|mensaje inmail|enviar inmail/i
  const inmailText = deepQueryAll('h1, h2, h3, h4, p, span, a, button, label')
    .some(el => el.offsetParent !== null && (el.textContent || '').length < 200 && inmailRe.test(el.textContent || ''))
  const inmailBtn = deepQueryAll('button[aria-label*="InMail" i], a[aria-label*="InMail" i], [class*="inmail-cta" i], button[class*="inmail" i]')
    .some(b => b.offsetParent !== null)
  if (inmailText || inmailBtn) {
    console.warn('[Orion content] v0.9.13 guard — InMail/2do-grado detectado → ABORT, no InMail')
    return { action: 'send_followup', status: 'error', error: 'lead_not_first_degree', reason: 'inmail_overlay_shadow_aware', signal: inmailText ? 'text' : 'button', url: location.href }
  }
  // (2) destinatario = lead — el nombre vive en el DOM ligero (chip "Para:"), fuera del shadow
  // del composer. Buscar en document.body (innerText visible + innerHTML atributos). Fail-closed.
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()
  const parts = norm(leadName).split(' ').filter(w => w.length >= 3)
  if (parts.length >= 1) {
    const page = norm((document.body.innerText || '') + ' ' + (document.body.innerHTML || ''))
    const first = parts[0], last = parts[parts.length - 1]
    const match = (parts.length === 1) ? page.includes(first) : (page.includes(first) && page.includes(last))
    if (!match) {
      console.warn(`[Orion content] v0.9.13 guard — destinatario NO verificado para "${leadName}" → ABORT recipient_mismatch`)
      return { action: 'send_followup', status: 'error', error: 'recipient_mismatch', reason: 'lead_name_not_on_compose_page', leadName, url: location.href }
    }
  }
  return null
}

function findProfileMessageButton(expectedLeadName) {
  const h1 = Array.from(document.querySelectorAll('main h1')).find(h => h.offsetParent !== null)
  let topCard = h1?.closest('section.artdeco-card, .pv-top-card, [class*="top-card"], [class*="ph5"]') ?? findTopCard() ?? document

  const buttons = Array.from(topCard.querySelectorAll('button, a[role="button"], a[href*="/messaging/"]'))
  const expectsName = expectedLeadName ? expectedLeadName.toLowerCase().split(/\s+/)[0] : null

  // v0.9.13 SEGURIDAD: NUNCA devolver un botón InMail (2do grado). Antes matcheaba 'inmail' a
  // propósito → clickeaba InMail → enviaba InMail a no-conexiones (hueco de la auditoría 02-jul).
  // Si SOLO hay InMail → return null → el caller detecta 2do-grado (Seguir/Conectar) y aborta.
  const isInmail = (b) => {
    const aria = (b.getAttribute('aria-label') ?? '').toLowerCase()
    const t = (b.textContent ?? '').trim().toLowerCase()
    return aria.includes('inmail') || t.includes('inmail')
  }

  // Prioridad 1: aria-label CON nombre del lead (más específico) — SIN InMail
  if (expectsName) {
    const byNameAria = buttons.find(b => {
      if (b.offsetParent === null || isInmail(b)) return false
      const aria = (b.getAttribute('aria-label') ?? '').toLowerCase()
      return aria.includes(expectsName) && /mensaje|message/i.test(aria)
    })
    if (byNameAria) return byNameAria
  }

  // Prioridad 2: texto exacto (literal del button) — "Enviar mensaje", "Mensaje" — SIN InMail
  const byText = buttons.find(b => {
    if (b.offsetParent === null || isInmail(b)) return false
    const t = (b.textContent ?? '').trim().toLowerCase()
    return t === 'enviar mensaje' || t === 'mensaje' ||
           t === 'send message' || t === 'send a message' || t === 'message'
  })
  if (byText) return byText

  // Prioridad 3: aria-label genérico — SIN InMail
  const byAria = buttons.find(b => {
    if (b.offsetParent === null || isInmail(b)) return false
    const aria = (b.getAttribute('aria-label') ?? '').toLowerCase()
    return /^enviar mensaje|^send (a )?message|^message |^mensaje /i.test(aria)
  })
  if (byAria) return byAria

  return null
}

// Find botón "Más" / "More" del top card (no del nav superior)
function findProfileMoreButton() {
  const topCard = findTopCard()
  if (!topCard) return null
  const buttons = Array.from(topCard.querySelectorAll('button, [role="button"]'))
  return buttons.find(b => {
    if (b.offsetParent === null) return false
    const t = (b.textContent ?? '').trim().toLowerCase()
    const aria = (b.getAttribute('aria-label') ?? '').toLowerCase()
    return t === 'más' || t === 'more' ||
           /^más acciones|^more actions/i.test(aria) ||
           /^más opciones|^more options/i.test(aria)
  }) ?? null
}

// Find "Mensaje" en dropdown abierto (después de click "Más")
function findMessageInDropdown() {
  // Dropdowns LinkedIn usan div con role=menu o artdeco-dropdown__content
  const dropdownSels = [
    '.artdeco-dropdown__content--is-open',
    '[role="menu"]',
    '.artdeco-dropdown__content',
  ]
  for (const sel of dropdownSels) {
    const dropdowns = Array.from(document.querySelectorAll(sel))
    for (const dd of dropdowns) {
      if (dd.offsetParent === null) continue
      const items = Array.from(dd.querySelectorAll('button, [role="menuitem"], a'))
      const msgItem = items.find(b => {
        if (b.offsetParent === null) return false
        const t = (b.textContent ?? '').trim().toLowerCase()
        const aria = (b.getAttribute('aria-label') ?? '').toLowerCase()
        return /mensaje|message|inmail/i.test(t) || /enviar mensaje|send.+message|inmail/i.test(aria)
      })
      if (msgItem) return msgItem
    }
  }
  return null
}

function findTopCard() {
  return document.querySelector(
    'main section.artdeco-card, main .pv-top-card, main [class*="ph5"][class*="pb5"], main [class*="top-card"]'
  )
}

function dumpTopCardButtons() {
  const topCard = findTopCard()
  if (!topCard) return ['NO_TOP_CARD_FOUND']
  return Array.from(topCard.querySelectorAll('button, a[role="button"]'))
    .slice(0, 15)
    .map(b => ({
      tag: b.tagName,
      visible: b.offsetParent !== null,
      text: (b.textContent ?? '').trim().slice(0, 40),
      aria: (b.getAttribute('aria-label') ?? '').slice(0, 60),
      href: b.getAttribute('href')?.slice(0, 50) ?? null,
    }))
}

// ── Helpers thread page ──────────────────────────────────────────────────────

// ── Shadow-DOM-piercing query helpers (v0.9.8) ────────────────────────────────
// LinkedIn movió el composer del overlay "Nuevo mensaje" a un SHADOW ROOT
// (path top>shadow[div]) → document.querySelector NO lo alcanza. Estos helpers
// recorren shadow roots recursivamente. Causa raíz del ~82% de FU fallidos
// (typing_complete_timeout: el bot nunca encontraba el composer en shadow DOM).
function deepQueryAll(selector, root = document) {
  const out = []
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()
    let matches
    try { matches = node.querySelectorAll(selector) } catch { matches = [] }
    for (const el of matches) out.push(el)
    let all
    try { all = node.querySelectorAll('*') } catch { all = [] }
    for (const el of all) if (el.shadowRoot) stack.push(el.shadowRoot)
  }
  return out
}
function deepQuery(selector, root = document) {
  return deepQueryAll(selector, root)[0] || null
}

function readThreadHeader() {
  const sels = [
    '.msg-entity-lockup__entity-title',
    '.msg-thread-top-bar-contact-info .t-bold',
    '.msg-thread-detail__header .t-bold',
    'h2[class*="msg-thread"]',
  ]
  for (const sel of sels) {
    const el = deepQuery(sel)  // v0.9.8: perfora shadow DOM (overlay "Nuevo mensaje")
    if (el && el.offsetParent !== null) {  // FIX: chequear null PRIMERO
      return (el.textContent ?? '').trim()
    }
  }
  return ''
}

function findThreadSendButton(knownEditor) {
  // El botón Enviar puede estar en:
  // - Thread page: dentro de .msg-form (footer del editor)
  // - Compose page: dentro de .msg-compose-form / artdeco-modal__content / contenedor padre del editor
  // Premium compose UI es icon-only paperplane con aria-label="Enviar" o "Send" (sin "mensaje").
  //
  // Estrategia:
  //   1. Localizar el editor focused/visible
  //   2. Subir al ancestor form-like y buscar dentro
  //   3. Si nada, buscar globalmente con criterio permisivo

  const isSendCandidate = (b) => {
    if (!b || b.offsetParent === null) return false
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false
    const t = (b.textContent ?? '').trim().toLowerCase()
    const aria = (b.getAttribute('aria-label') ?? '').toLowerCase()
    const cls = (b.className ?? '').toLowerCase()
    const ctrl = (b.getAttribute('data-control-name') ?? '').toLowerCase()
    return (
      t === 'enviar' || t === 'send' ||
      aria === 'enviar' || aria === 'send' ||
      aria === 'enviar mensaje' || aria === 'send message' ||
      /^(enviar|send)( mensaje| message)?\b/.test(aria) ||
      cls.includes('msg-form__send-btn') ||    // ← clase real de LinkedIn compose
      cls.includes('msg-form__send-button') || // ← variante thread page
      cls.includes('send-btn') ||              // ← genérico con guion
      cls.includes('send-button') ||
      ctrl === 'send' || ctrl === 'send_button' || ctrl.includes('send')
    )
  }

  // 1. Buscar el editor visible — sirve como anchor para localizar el form.
  // v0.9.8: preferir el editor conocido (puede estar en shadow DOM); si no, deep-buscar.
  const editor = (knownEditor && knownEditor.offsetParent !== null)
    ? knownEditor
    : deepQueryAll('div[contenteditable="true"]')
        .find(el => el.offsetParent !== null && el.getBoundingClientRect().width > 100)

  // 2. Walk up from editor para encontrar el form-like ancestor
  if (editor) {
    let node = editor
    for (let i = 0; i < 10 && node; i++) {
      node = node.parentElement
      if (!node) break
      const cls = (node.className ?? '').toString().toLowerCase()
      if (
        node.tagName === 'FORM' ||
        cls.includes('msg-form') ||
        cls.includes('compose-form') ||
        cls.includes('msg-compose') ||
        cls.includes('compose-creation') ||
        cls.includes('messaging-compose')
      ) {
        const buttons = Array.from(node.querySelectorAll('button, [role="button"]'))
        const hit = buttons.find(isSendCandidate)
        if (hit) return hit
      }
    }
    // Si no encontramos un form ancestor identificable, buscar en el contenedor más amplio
    // (e.g. artdeco-modal__content, role=main, etc.). v0.9.8: si el editor está en shadow
    // DOM, closest() no sale del shadow → usar el shadow root como contenedor.
    const root = editor.getRootNode()
    const container = editor.closest('[role="main"], main, .artdeco-modal__content, .msg-overlay-bubble')
      || (root instanceof ShadowRoot ? root : document.body)
    const buttons = Array.from(container.querySelectorAll('button, [role="button"]'))
    const hit = buttons.find(isSendCandidate)
    if (hit) return hit
  }

  // 3. Fallback global — TODO el documento + shadow DOM (v0.9.8)
  const allButtons = deepQueryAll('button, [role="button"]')
  return allButtons.find(isSendCandidate) ?? null
}

// Dump TODOS los botones visibles + sus atributos (para debug cuando no encontramos Send).
// listVisibleButtons solo da los primeros 25; en compose page Send está más profundo.
function listAllVisibleButtonsVerbose(limit = 80) {
  return Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter(b => b.offsetParent !== null)
    .slice(0, limit)
    .map(b => ({
      txt: (b.textContent ?? '').trim().slice(0, 30),
      aria: (b.getAttribute('aria-label') ?? '').slice(0, 50),
      cls: (b.className ?? '').toString().slice(0, 60),
      ctrl: b.getAttribute('data-control-name') ?? '',
      disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
    }))
}

// v0.6.45: lee los últimos N mensajes visibles del thread abierto y determina
// si el más reciente es OUTBOUND (nuestro). Usa marcadores típicos de LinkedIn
// que distinguen quién envió el mensaje. Robusto a cambios de class names.
function detectLastMessageIsOutbound() {
  // LinkedIn marca msgs nuestros con sender name = "Tú" (es-MX) / "You" (en),
  // o con clases tipo `msg-s-message-group__profile-link--from-user`, o el
  // bloque msg-s-event-listitem--from-me. Probamos varios heurísticos.
  const allMsgs = document.querySelectorAll(
    '.msg-s-message-list__event, .msg-s-event-listitem, [class*="msg-s-event"]'
  )
  if (allMsgs.length === 0) return { isOurs: false, reason: 'no_messages_in_dom' }

  // Tomar el último visible. LinkedIn renderiza el más reciente al final.
  const last = allMsgs[allMsgs.length - 1]
  if (!last) return { isOurs: false }

  // Heurístico 1: clases con "--from-me" o "--from-user"
  const hasFromMeClass = !!last.querySelector('[class*="from-me"], [class*="from-user"]') ||
                        /from-me|from-user/.test(last.className ?? '')
  // Heurístico 2: header del grupo dice "Tú" o "You"
  const senderHeader = last.querySelector(
    '.msg-s-message-group__profile-link, .msg-s-message-group__name, [class*="message-group__name"]'
  )
  const senderText = (senderHeader?.textContent ?? '').trim().toLowerCase()
  const isYou = senderText === 'tú' || senderText === 'you' || senderText === 'tu'
  // Heurístico 3: alineación a la derecha (LinkedIn estiliza outbound a la derecha)
  // No siempre confiable; usar solo como tiebreaker.
  let isOurs = hasFromMeClass || isYou

  // Si el last es un "indicador" sin contenido (timestamp separator), buscar hacia atrás
  let probe = last
  let attempts = 5
  while (probe && attempts-- > 0) {
    const content = (probe.textContent ?? '').trim()
    if (content.length > 5) break  // tiene contenido real
    probe = probe.previousElementSibling
  }
  const preview = (probe?.textContent ?? '').trim()
  const timeEl = probe?.querySelector('time, [class*="timestamp"]')
  const timestamp = timeEl?.getAttribute('datetime') ?? timeEl?.textContent ?? null

  // Re-evaluate from probe if we walked back
  if (probe && probe !== last) {
    const probeHasFromMe = !!probe.querySelector('[class*="from-me"], [class*="from-user"]') ||
                          /from-me|from-user/.test(probe.className ?? '')
    const probeSender = probe.querySelector(
      '.msg-s-message-group__profile-link, .msg-s-message-group__name'
    )
    const probeSenderText = (probeSender?.textContent ?? '').trim().toLowerCase()
    isOurs = probeHasFromMe || probeSenderText === 'tú' || probeSenderText === 'you'
  }

  return { isOurs, preview, timestamp, senderText }
}

async function verifyFollowupSent(message) {
  // El mensaje recién enviado debe aparecer al final del thread (msg-s-event-list)
  // v0.6.41: retry loop con budget 8s en lugar de 1-shot. LinkedIn a veces tarda
  // 3-5s en renderizar el mensaje recién enviado en el DOM.
  const snippet = message.slice(0, 50).toLowerCase()
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const messages = document.querySelectorAll('.msg-s-message-list__event, [class*="msg-s-event"]')
    const last = messages[messages.length - 1]
    if (last && (last.textContent ?? '').toLowerCase().includes(snippet)) {
      return true
    }
    await sleep(400)
  }
  return false
}

// ── humanTypeContentEditable: para divs contenteditable (no textareas) ──
// v0.6.41: detecta URL change durante typing (SPA route change interrumpe typing).
// v0.7.5: CHUNK MODE para mensajes largos (>300 chars). En vez de typear char-por-char
// con pausa entre cada (que LinkedIn React re-renders y ralentiza 2-3×), typeamos
// en bursts de 10 chars con UNA pausa por burst. Reduce events ~10× y mantiene
// human-like timing (cada burst es un "thought" del humano).
//
// Para mensajes cortos (<300 chars), preservamos char-by-char con pausas naturales.
async function humanTypeContentEditable(el, text, options = {}) {
  const { progressCallback } = options
  // v0.7.11 CRLF normalization: templates/AI a veces generan \r\n (Windows EOL).
  // execCommand('insertText', ...) en contenteditable convierte el \n a <br> (que
  // luego desaparece de editor.textContent), mientras que el \r sobrevive como
  // char literal. Resultado: editor.textContent termina más corto que el buffer
  // tipeado → la verificación post-typing dispara lenRatio<0.95 = truncated
  // false-positive. Normalizamos a \n único (y limpiamos \r solitarios) UNA VEZ
  // para que el typing y el length-compare estén alineados.
  text = String(text ?? '').replace(/\r\n?/g, '\n')
  el.focus()
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)

  const startUrl = location.href
  // v0.7.40 FIX background-throttle (mismo que send_invite humanTypeChunked): en
  // tabs background Chrome throttlea setTimeout a ~1000ms → char-por-char (1 sleep
  // POR carácter) hace que un FU de 200 chars tarde ~200s → exec_hard_timeout. Era
  // la causa del ~59% success histórico de send_followup. Bajamos el umbral de 300
  // a 40 → los FU típicos (100-280 chars) ahora chunkean (chunkSize 10 → ~10-28
  // sleeps ≈ 10-28s). Solo mensajes ≤40 chars siguen char-por-char (≤40s, seguro).
  const useChunks = text.length > 40
  const chunkSize = useChunks ? 10 : 1
  let charsTyped = 0
  const total = text.length
  const reportInterval = Math.max(1, Math.floor(total / 4))  // 25%, 50%, 75%, 100%
  let lastReportThreshold = 0

  if (useChunks) {
    console.log(`[Orion content] humanType CHUNKED mode (${total} chars, chunks of ${chunkSize})`)
  }

  // v0.9.3 ANTI-THROTTLE AGRESIVO: vuelca el mensaje COMPLETO de golpe (selectAll +
  // insertText) RE-ENFOCANDO el editor, para que aterrice aunque haya perdido foco
  // durante un sleep throttled (causa de typing_complete_timeout: el bulk-insert
  // v0.7.46 no re-enfocaba → execCommand no caía en el editor → texto parcial).
  // Triggers: (1) tab oculta, (2) presupuesto total >9s (muchos sleeps de 1-2s bajo el
  // umbral por-sleep = throttle moderado, el que rompía al runPhase fix), (3) sleep
  // individual >2s (el delay legítimo máximo es ~1.1s, así que 2s = throttle real).
  const typeStartT0 = Date.now()
  const bulkInsertFull = (reason) => {
    console.warn(`[Orion content] typing: ${reason} → bulk-insert COMPLETO (${text.length} chars)`)
    try { el.focus() } catch {}
    if (document.activeElement === el) {
      document.execCommand('selectAll', false, null)
      document.execCommand('insertText', false, text)
    } else {
      // foco no aterrizó: caret al final + insertar el resto desde donde íbamos
      try {
        const r = document.createRange(); r.selectNodeContents(el); r.collapse(false)
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
      } catch {}
      document.execCommand('insertText', false, text.slice(charsTyped))
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    charsTyped = total
    try { progressCallback && progressCallback({ charsTyped, total, pct: 100 }) } catch {}
  }

  for (let i = 0; i < text.length; i += chunkSize) {
    if (location.href !== startUrl) {
      throw new Error(`navigation_during_typing_at_char_${charsTyped}_of_${total}`)
    }
    if (!el.isConnected) {
      throw new Error(`editor_detached_at_char_${charsTyped}_of_${total}`)
    }
    const chunk = text.slice(i, i + chunkSize)
    // En chunk mode: insertar string completo de chunk en UN execCommand
    document.execCommand('insertText', false, chunk)
    charsTyped += chunk.length

    // Progress: cada 25% reportar al callback opcional
    if (progressCallback && charsTyped >= lastReportThreshold + reportInterval) {
      lastReportThreshold = charsTyped
      const pct = Math.round((charsTyped / total) * 100)
      try { await progressCallback({ charsTyped, total, pct }) } catch {}
    }

    // Pausa: en chunk mode escalamos por size del chunk para mantener WPM realista
    let delay
    // v0.7.21 P1-3: jitter_pct_typing wired desde runtime_config (default 0.70).
    const pct = _runtimeConfig?.jitter_pct_typing ?? 0.70
    if (useChunks) {
      // 80-180ms por chunk de 10 chars = 8-18ms efectivo por char.
      // Centro 140 × (1 ± pct) → si pct=0.70 → [42,238] (≈v0.7.16 [40,240]).
      const minC = Math.max(20, Math.round(140 * (1 - pct)))
      const maxC = Math.round(140 * (1 + pct))
      delay = randInt(minC, maxC)
      if (Math.random() < 0.12) delay += randInt(120, 500)  // "thinking" pause
      if (/[.?!]/.test(chunk)) delay += randInt(80, 320)
    } else {
      const ch = chunk
      // Centro 100 × (1 ± pct) → si pct=0.70 → [30,170] (igual v0.7.16).
      const minC = Math.max(10, Math.round(100 * (1 - pct)))
      const maxC = Math.round(100 * (1 + pct))
      delay = randInt(minC, maxC)
      if ('.?,!¡¿\n'.includes(ch)) delay += randInt(60, 240)
      if (Math.random() < 0.07) delay += randInt(250, 600)
    }
    // v0.9.3 anti-throttle (ver helper bulkInsertFull arriba): 3 triggers que vuelcan
    // el mensaje completo re-enfocando el editor.
    const _restI = i + chunkSize
    const restPending = _restI < text.length
    if (restPending && document.hidden) { bulkInsertFull('tab oculta'); break }
    if (restPending && (Date.now() - typeStartT0) > 9000) {
      bulkInsertFull(`budget 9s (throttle moderado, char ${charsTyped}/${total})`); break
    }
    const _sleepT0 = Date.now()
    await sleep(delay)
    if (restPending && (Date.now() - _sleepT0) > 2000) {
      bulkInsertFull(`sleep throttled ${Date.now() - _sleepT0}ms`); break
    }
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

// ── 2.5 — search — scrapea /search/results/people/ ──────────────────────────
//
// Payload: { keywords, location, secondDegreeOnly, minEmployees, companyNames,
//            targetCount, maxPages, dryRun }
//
// Background.js construye la URL y navega; content.js solo scrapea el DOM.
// Strategy: scroll natural → extractProfilesFromPage() → next page → repeat.
// Post-filter por companyNames substring si fueron pasados.

// v0.7.28 normaliza para comparación robusta: minúsculas + quita acentos.
// FIX BUG location/company filter: LinkedIn renderiza ubicaciones acentuadas
// ("Ciudad de México, México") pero las campañas configuran términos sin acento
// ("Mexico") → "méxico".includes("mexico") era FALSE (é ≠ e) → rechazaba TODOS
// los perfiles aunque geoUrn ya filtró server-side → Wal/Josh scrapeaban 0.
function _normForFilter(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// ── v0.10.0 — resolve_company: nombre de empresa → company URN + slug ────────
// background.js ya navegó a /search/results/companies/?keywords=<nombre>. Aquí
// elegimos la MEJOR coincidencia. El URN numérico es lo que necesita el facet
// currentCompany de people-search (única forma de acotar DE VERDAD por empresa;
// meter el nombre en el keyword es match difuso).
//
// v0.10.1 — NO tomar el primer resultado: LinkedIn tiene páginas DUPLICADAS de la
// misma empresa (regionales, viejas, creadas por empleados) y el primer resultado
// suele ser la que coincide literal con el texto buscado, no la real. Caso medido
// 31-jul: "mondelez internacional" → urn 75967276 (4 empleados alcanzables, toda
// búsqueda por puesto daba 0) mientras "Mondelez International" → urn 1511 (la
// canónica). Ahora se puntúa por SEGUIDORES: la duplicada tiene decenas, la real
// millones.
const COMPANY_URN_RE = /urn:li:(?:fsd_company|organization|company):(\d+)/
const CONTENT_VERSION = '0.10.10'
const DISTINCTIVE_HIT = 10   // puntaje de un token distintivo: el umbral de "sí es esta empresa"
const FOLLOWERS_RE = /([\d][\d.,\s]*)\s*(mil|k|m|millones)?\s*(?:de\s+)?(?:seguidores|followers)/

// Relleno corporativo: aparece en miles de nombres, así que compartirlo NO significa
// que sea la empresa. Ver _nameScore.
const GENERIC_NAME_TOKENS = new Set([
  'internacional', 'international', 'mexico', 'mexicana', 'mexicano', 'latam',
  'grupo', 'group', 'holding', 'holdings', 'company', 'corporativo', 'corporation',
  'servicios', 'services', 'solutions', 'soluciones', 'industrias', 'industries',
  'comercial', 'global', 'sapi', 'srl', 'inc', 'ltd', 'llc', 'sade', 'de', 'cv',
])

function _nameScore(wantedTokens, title, slug) {
  let score = 0
  for (const t of wantedTokens) {
    if (!title.includes(t) && !slug.includes(t)) continue
    score += GENERIC_NAME_TOKENS.has(t) ? 1 : 10
  }
  return score
}

// v0.10.8 — el texto del ancla trae nombre + rubro + ciudad + DESCRIPCIÓN comercial, y
// puntuar sobre todo eso regalaba el match a cualquier proveedor que presuma al cliente:
// "aviator spain … mars, ferrero, mondelez international, henkel" calificaba como
// Mondelēz. Nos quedamos con el nombre a secas.
//
// LinkedIn repite el nombre al inicio del ancla (copia accesible + visible), así que el
// nombre es el prefijo más largo que aparece dos veces seguidas. Si el patrón cambia,
// caemos al slug, que nunca trae descripción.
function _leadingDoubledName(text) {
  const max = Math.floor(text.length / 2)
  for (let k = max; k >= 3; k--) {
    if (text.slice(0, k) === text.slice(k, 2 * k)) return text.slice(0, k).trim()
  }
  return ''
}

// El slug ES la identidad de la empresa: /company/mondelez-internacional. Viene
// URL-encoded cuando el nombre trae acentos (mondel%C4%93z).
function _slugWords(slug) {
  let s = slug ?? ''
  try { s = decodeURIComponent(s) } catch { /* slug con % inválido: se usa tal cual */ }
  return _normForFilter(s.replace(/[-_]+/g, ' '))
}

// "3,204,559 seguidores" | "3.2 M de seguidores" | "12 mil seguidores" | "1.2K followers"
// Solo se usa para RANKEAR, así que aproximar está bien.
function _parseFollowers(txt) {
  const m = _normForFilter(txt).match(FOLLOWERS_RE)
  if (!m) return 0
  const raw = m[1].replace(/\s/g, '')
  // 1.234.567 / 1,234,567 → separadores de miles; 3,2 / 3.2 → decimal.
  const n = /^\d{1,3}([.,]\d{3})+$/.test(raw)
    ? parseFloat(raw.replace(/[.,]/g, ''))
    : parseFloat(raw.replace(',', '.'))
  if (!isFinite(n)) return 0
  const mult = { mil: 1e3, k: 1e3, m: 1e6, millones: 1e6 }[m[2]] ?? 1
  const v = n * mult
  // Sanity (3-ago): un parse malo produjo 200,919,000 ("200.919" ya en unidades + "mil"
  // suelto en el texto) y esa inflación ganó el ranking por tamaño. Ninguna página de
  // empresa real pasa de ~40M (Google/Amazon ~30-36M). Si sale absurdo, mejor "no sé"
  // (0) que un número que corrompe la elección.
  return v > 50_000_000 ? 0 : v
}

// v0.10.5 — aísla la tarjeta de UN resultado. Antes se subían 4 niveles a ciegas desde
// el link y se aterrizaba en el contenedor de TODA la lista: los 6 candidatos leían el
// URN y los seguidores del primer resultado, así que el scorer comparaba seis copias del
// mismo dato (medido 2-ago: mondelez, durulte alimentos, aviator spain… todos con
// urn=75967276 y 76 seguidores). Ahora subimos mientras el ancestro siga conteniendo un
// solo /company/ distinto — el logo y el título del mismo resultado apuntan al mismo
// slug, así que cuentan como uno. Es agnóstico al layout: no depende de <li> ni de
// clases de LinkedIn, que cambian sin avisar.
function _companyResultCard(anchor) {
  const slugOf = (el) => (el.getAttribute('href') ?? '').match(/\/company\/([^/?#]+)/)?.[1]
  let card = anchor
  let el = anchor.parentElement
  while (el && el !== document.body) {
    const slugs = new Set(
      Array.from(el.querySelectorAll('a[href*="/company/"]')).map(slugOf).filter(Boolean)
    )
    if (slugs.size > 1) break   // ya abarca otro resultado → nos quedamos con el anterior
    card = el
    el = el.parentElement
  }
  return card
}

async function resolveCompanyOnPage(payload = {}) {
  const wanted = _normForFilter(payload.name)
  if (!/\/search\/results\/companies/.test(location.pathname)) {
    return { action: 'resolve_company', status: 'error', error: 'not_on_company_search_page', currentUrl: location.href }
  }
  await waitForSelector(['main', 'div.search-results-container'], 15000)
  await sleep(1200)  // hidratación de los resultados

  // Scope a <main>: fuera de ahí hay links a /company/ del chrome de LinkedIn
  // (anuncios, footer) que secuestrarían los resultados.
  const scope = document.querySelector('main') ?? document
  const tokens = wanted.split(/[^a-z0-9]+/).filter(t => t.length > 3)

  const seen = new Set()
  const candidates = []
  for (const a of scope.querySelectorAll('a[href*="/company/"]')) {
    const href = a.getAttribute('href') ?? ''
    const slug = (href.match(/\/company\/([^/?#]+)/) ?? [])[1]
    if (!slug || seen.has(slug)) continue
    const title = _normForFilter(a.textContent ?? '')
    if (!title) continue
    seen.add(slug)

    const card = _companyResultCard(a)
    const attr = card?.getAttribute?.('data-chameleon-result-urn') ?? ''
    const urn = (attr.match(COMPANY_URN_RE) ?? [])[1]
      ?? (card?.outerHTML?.match(COMPANY_URN_RE) ?? [])[1]
      ?? null
    // v0.10.6 — el guard de nombre pesa POR TOKEN: genéricos 1, distintivos 10, así que
    // quien trae el nombre real gana a quien solo comparte relleno corporativo.
    // v0.10.8 — y se puntúa SOLO sobre el nombre + el slug, nunca sobre la descripción.
    const slugWords = _slugWords(slug)
    const nameOnly = _leadingDoubledName(title) || slugWords
    const nameScore = _nameScore(tokens, nameOnly, slugWords)

    candidates.push({
      urn, slug, nameScore, matched: nameScore >= DISTINCTIVE_HIT,
      title: nameOnly.slice(0, 60),
      followers: _parseFollowers(card?.innerText ?? ''),
      scoredText: nameOnly.slice(0, 120),  // diagnóstico: exactamente lo que se puntuó
    })
    if (candidates.length >= 6) break
  }

  if (candidates.length === 0) {
    const bodyTxt = _normForFilter(document.body?.innerText ?? '')
    const captcha = ['captcha', 'verify you are human', 'verifica que eres humano', 'security check'].some(s => bodyTxt.includes(s))
    return { action: 'resolve_company', status: captcha ? 'error' : 'ok',
             error: captcha ? 'captcha_detected' : 'no_company_results',
             urn: null, slug: null, matched: false, currentUrl: location.href }
  }

  // El nombre es un FILTRO, no un ranking: o la página es de esta empresa o no lo es.
  // Entre las que sí lo son manda el tamaño, que es lo que separa a la corporativa de las
  // duplicadas regionales (Mondelēz: 3.4M vs 77). Ordenar por parecido de nombre sería
  // peor: "mondelez internacional" (la duplicada, 2 tokens) le ganaría a "mondelez
  // international" (la real, 1 token) para siempre.
  // v0.10.9 — SIN fallback a coincidencias genéricas. Antes, si ningún candidato traía un
  // token distintivo, se aceptaba cualquiera que compartiera relleno y ganaba el más
  // grande: "Grupo Aduanero M.S." terminó atado a arcaargentina (351k seguidores) por la
  // palabra *grupo*. Atar la empresa equivocada es el peor resultado posible — manda
  // invitaciones a otra compañía. Si no hay token distintivo, NO se resuelve: la fila
  // queda 'unresolved' y se busca por nombre exacto, que es honesto y reversible.
  const pool = candidates.filter(c => c.nameScore >= DISTINCTIVE_HIT)
  if (pool.length === 0) {
    return { action: 'resolve_company', status: 'ok', error: 'no_name_match',
             urn: null, slug: null, matched: false, contentVersion: CONTENT_VERSION,
             candidates: candidates.map(c => ({ urn: c.urn, title: c.title, followers: c.followers, nameScore: c.nameScore })) }
  }
  const best = pool.slice().sort((a, b) =>
    ((b.urn ? 1 : 0) - (a.urn ? 1 : 0))
    || (b.followers - a.followers)
    || (parseInt(a.urn ?? '9e15', 10) - parseInt(b.urn ?? '9e15', 10))
  )[0]

  return {
    action: 'resolve_company', status: 'ok',
    // Versión del CONTENT script (no la del manifest, que la reporta el service worker):
    // si estas dos divergen, la pestaña está corriendo código viejo. Ver
    // reloadLinkedInTabsOnVersionChange en background.js.
    contentVersion: CONTENT_VERSION,
    urn: best.urn, slug: best.slug, matched: best.matched, resultTitle: best.title,
    followers: best.followers, nameScore: best.nameScore,
    // Para diagnosticar cuando una empresa quede pegada en 0 resultados.
    candidates: candidates.map(c => ({ urn: c.urn, title: c.title, followers: c.followers, nameScore: c.nameScore, scoredText: c.scoredText })),
  }
}

// ── Post-Prospecting (v0.9) ──────────────────────────────────────────────────
// search_posts: scrapea /search/results/content/ (posts donde alguien pide algo).
// A diferencia de people-search, content-search es SCROLL INFINITO en una sola
// página → no navegamos entre páginas (evita la reinyección de content.js que
// rompe el scrape multi-página). Hacemos scroll + extract hasta target o sin
// crecimiento. background.js construye la URL y navega; aquí solo scrapeamos.
async function searchPosts(payload = {}) {
  const targetCount = Math.min(payload.targetCount ?? 20, 60)
  const maxScrolls = Math.min(payload.maxScrolls ?? 12, 30)

  console.log(`[Orion content] searchPosts target=${targetCount} maxScrolls=${maxScrolls} url=${location.href}`)

  if (!/\/search\/results\/content/.test(location.pathname)) {
    return { action: 'search_posts', status: 'error', error: 'not_on_content_search_page', currentUrl: location.href }
  }

  const containerSel = await waitForSelector(['main', 'div.search-results-container'], 12000)
  if (!containerSel) {
    return { action: 'search_posts', status: 'error', error: 'results_container_not_found', currentUrl: location.href }
  }
  await sleep(1500)

  const collected = []
  const seenUrns = new Set()
  let stopReason = null
  let noGrowthStreak = 0

  for (let scroll = 0; scroll < maxScrolls && collected.length < targetCount; scroll++) {
    const before = collected.length
    const pagePosts = extractPostsFromPage()
    for (const p of pagePosts) {
      if (!p.postUrn || seenUrns.has(p.postUrn)) continue
      if (!p.authorProfileUrl) continue  // sin /in/ del autor no se puede graduar a lead
      seenUrns.add(p.postUrn)
      collected.push(p)
      if (collected.length >= targetCount) break
    }
    console.log(`[Orion content] searchPosts scroll ${scroll + 1}: +${collected.length - before} (total ${collected.length}/${targetCount})`)

    if (collected.length >= targetCount) { stopReason = 'target_reached'; break }

    // Distinguir captcha / empty-state / drift en el primer scroll si no hay nada.
    if (scroll === 0 && collected.length === 0) {
      const bodyTxt = (document.body?.innerText ?? '').toLowerCase()
      const captchaSignals = ['captcha', 'verify you are human', 'verifica que eres humano', 'security check', 'unusual activity']
      if (captchaSignals.some(s => bodyTxt.includes(s))) {
        return { action: 'search_posts', status: 'error', error: 'captcha_detected', currentUrl: location.href }
      }
      const broadActivity = document.querySelectorAll('[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"]').length
      const noResultsSignals = ['no se encontraron resultados', 'no hay resultados', 'no results', 'try different keywords', 'prueba con otras palabras']
      if (broadActivity === 0 || noResultsSignals.some(s => bodyTxt.includes(s))) {
        return {
          action: 'search_posts', status: 'ok', posts: [], stopReason: 'no_results_found',
          scrapedAt: new Date().toISOString(), debugSample: { broadActivity },
        }
      }
      // Hay activities en el DOM pero el extractor sacó 0 → drift real.
      return {
        action: 'search_posts', status: 'error', error: 'no_posts_selector_may_have_changed',
        currentUrl: location.href, debugSample: { broadActivity, bodyTextSnippet: bodyTxt.slice(0, 400) },
      }
    }

    // Anti-loop: si 2 scrolls seguidos no agregan nada nuevo, paramos (feed agotado).
    if (collected.length === before) {
      noGrowthStreak++
      if (noGrowthStreak >= 2) { stopReason = 'no_growth'; break }
    } else {
      noGrowthStreak = 0
    }

    // Scroll humano hacia abajo para hidratar más posts (infinite scroll).
    window.scrollBy(0, randInt(700, 1100))
    await sleep(randInt(1500, 3200))
  }

  if (!stopReason) stopReason = 'max_scrolls'

  return {
    action: 'search_posts',
    status: 'ok',
    posts: collected,
    stopReason,
    totalFound: collected.length,
    scrapedAt: new Date().toISOString(),
  }
}

// Extrae posts del feed/content-search. CLAVE: la unidad es el POST (no la persona),
// seleccionada por activity URN; NO hay un anchor /in/ por-item como en people-search.
// El URL del autor sale del PRIMER /in/ del bloque actor (anti wrong-person).
function extractPostsFromPage() {
  const results = []
  const seen = new Set()
  const containers = Array.from(document.querySelectorAll(
    'div.feed-shared-update-v2[data-urn], div[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"]'
  ))

  for (const card of containers) {
    const urn = card.getAttribute('data-urn') || card.getAttribute('data-id') || ''
    if (!/urn:li:activity:/.test(urn)) continue
    if (seen.has(urn)) continue
    seen.add(urn)

    // Autor: PRIMER /in/ dentro del bloque actor (evita matchear comentaristas/menciones).
    const actorBlock = card.querySelector(
      '.update-components-actor, .update-components-actor__container, [class*="update-components-actor"]'
    ) || card
    const authorLink = actorBlock.querySelector('a[href*="/in/"]')
    let authorProfileUrl = null
    if (authorLink) {
      const href = authorLink.getAttribute('href') || ''
      const full = href.startsWith('http') ? href : `https://www.linkedin.com${href}`
      authorProfileUrl = full.split('?')[0].replace(/\/$/, '') + '/'
      if (!authorProfileUrl.includes('/in/')) authorProfileUrl = null
    }

    // Nombre del autor: título del actor o text del link.
    let authorName = null
    const titleEl = card.querySelector(
      '.update-components-actor__title, [class*="update-components-actor__title"]'
    )
    if (titleEl) authorName = (titleEl.textContent || '').replace(/\s+/g, ' ').trim()
    if (!authorName && authorLink) {
      authorName = Array.from(authorLink.childNodes).filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim()).filter(Boolean).join(' ').trim()
    }
    // El título suele venir duplicado ("Juan Pérez\nJuan Pérez • 2do"); quedarnos la 1ª línea.
    if (authorName) authorName = authorName.split('\n')[0].split('•')[0].trim().slice(0, 120)

    // Headline del autor.
    let authorHeadline = null
    const descEl = card.querySelector(
      '.update-components-actor__description, [class*="update-components-actor__description"]'
    )
    if (descEl) authorHeadline = (descEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300)

    // Texto del post.
    let postText = null
    const textEl = card.querySelector(
      '.update-components-text, .feed-shared-update-v2__description, [class*="update-components-update-v2__commentary"], [class*="feed-shared-inline-show-more-text"]'
    )
    if (textEl) postText = (textEl.textContent || '').replace(/\s+/g, ' ').trim()

    // Sin texto o sin autor no sirve (no calificable / no graduable).
    if (!postText || postText.length < 10) continue

    results.push({
      postUrn: urn,
      postPermalink: `https://www.linkedin.com/feed/update/${urn}/`,
      postText: postText.slice(0, 4000),
      authorName,
      authorProfileUrl,
      authorHeadline,
    })
  }
  return results
}

// publish_post (v0.9.2): publica un post en el FEED del propio usuario (texto).
// background ya navegó a /feed/. Abre el composer, teclea (reusa humanTypeContentEditable
// + el throttle-fix), y clickea "Publicar". Selectores semánticos (role=textbox + texto
// del botón) con debug en fallos. Imagen NO (se adjunta manual desde Orion).
async function publishPost(payload = {}) {
  const text = String(payload.postText ?? '').trim()
  if (!text) return { action: 'publish_post', status: 'error', error: 'empty_post_text' }

  // 1. Feed cargado
  const ok = await waitForSelector(['main', '.scaffold-layout', 'div[role="main"]'], 12000)
  if (!ok) return { action: 'publish_post', status: 'error', error: 'feed_not_loaded', currentUrl: location.href }
  await sleep(randInt(1500, 2800))

  // 2. Abrir el composer (clic en "Comienza una publicación")
  const startTrigger = Array.from(document.querySelectorAll('button, [role="button"], .share-box-feed-entry__trigger'))
    .find(el => {
      if (el.offsetParent === null) return false
      const t = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase()
      return /comienza una publicaci|empieza una publicaci|crear una publicaci|start a post|create a post|comparte ideas|de qué quieres hablar/.test(t)
    })
  if (startTrigger) {
    await humanClick(startTrigger)
    await sleep(randInt(1800, 3200))
  }

  // 3. Editor del composer (contenteditable dentro del dialog; el más grande visible)
  const editorSels = [
    'div[role="dialog"] div.ql-editor[contenteditable="true"]',
    'div[role="dialog"] [contenteditable="true"][role="textbox"]',
    'div[role="dialog"] [contenteditable="true"]',
    '.share-creation-state [contenteditable="true"]',
  ]
  let editor = await waitForSelector(editorSels, 8000)
  if (!editor || editor.offsetParent === null) {
    await sleep(1000)
    editor = Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .filter(e => e.offsetParent !== null)
      .sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
        return (rb.width * rb.height) - (ra.width * ra.height)
      })[0]
  }
  if (!editor) {
    return {
      action: 'publish_post', status: 'error', error: 'composer_editor_not_found', currentUrl: location.href,
      debug: Array.from(document.querySelectorAll('[contenteditable="true"]')).slice(0, 8).map(e => ({
        vis: e.offsetParent !== null, role: e.getAttribute('role'), aria: (e.getAttribute('aria-label') || '').slice(0, 40),
      })),
    }
  }

  // 4. Teclear el post
  await humanClick(editor)
  await sleep(randInt(300, 600))
  try {
    await humanTypeContentEditable(editor, text.slice(0, 2800))
  } catch (err) {
    return { action: 'publish_post', status: 'error', error: `typing_failed_${String(err.message ?? err).slice(0, 50)}` }
  }
  await sleep(randInt(900, 1600))

  // 5. Botón "Publicar" (en el dialog, habilitado tras teclear)
  const findPostBtn = () => {
    const scope = editor.closest('[role="dialog"]') || document
    return Array.from(scope.querySelectorAll('button')).find(b => {
      if (b.offsetParent === null || b.disabled) return false
      const t = (b.textContent || '').trim().toLowerCase()
      const a = (b.getAttribute('aria-label') || '').toLowerCase()
      return t === 'publicar' || t === 'post' || t === 'publish' || /^publicar( ahora)?$/.test(a)
    })
  }
  let postBtn = findPostBtn()
  if (!postBtn) { await sleep(1300); postBtn = findPostBtn() }
  if (!postBtn) {
    const scope = editor.closest('[role="dialog"]') || document
    return {
      action: 'publish_post', status: 'error', error: 'post_button_not_found', currentUrl: location.href,
      debug: Array.from(scope.querySelectorAll('button')).filter(b => b.offsetParent !== null).slice(-10).map(b => ({
        txt: (b.textContent || '').trim().slice(0, 24), disabled: b.disabled, aria: (b.getAttribute('aria-label') || '').slice(0, 30),
      })),
    }
  }

  // 6. Publicar
  await humanClick(postBtn)
  await sleep(randInt(2500, 4200))

  // 7. Captcha / security
  const bodyTxt = (document.body?.innerText ?? '').toLowerCase()
  if (['captcha', 'verify you are human', 'verifica que eres humano', 'security check', 'unusual activity'].some(s => bodyTxt.includes(s))) {
    return { action: 'publish_post', status: 'error', error: 'captcha_detected', currentUrl: location.href }
  }

  // 8. Verificar: el composer (dialog) se cerró tras publicar
  const dialogGone = !editor.isConnected || editor.offsetParent === null || !document.querySelector('div[role="dialog"]')
  if (!dialogGone) {
    return { action: 'publish_post', status: 'error', error: 'publish_unconfirmed', editorLen: (editor.textContent || '').length, currentUrl: location.href }
  }
  return { action: 'publish_post', status: 'published', postedAt: new Date().toISOString(), chars: text.length }
}

// comment_on_post: publica un comentario en el post (background ya navegó al permalink).
// Reusa humanClick + humanTypeContentEditable. Verifica que el editor se vacíe tras
// publicar (Quill limpia en éxito). Detecta captcha post-submit.
async function commentOnPost(payload = {}) {
  const comment = String(payload.comment ?? '').trim()
  if (!comment) {
    return { action: 'comment_on_post', status: 'error', error: 'empty_comment' }
  }

  // Asegurar que el post cargó.
  const ok = await waitForSelector(['.feed-shared-update-v2', 'main', 'div[data-urn^="urn:li:activity:"]'], 12000)
  if (!ok) {
    return { action: 'comment_on_post', status: 'error', error: 'post_not_loaded', currentUrl: location.href }
  }
  await sleep(randInt(1200, 2500))

  // Localizar el editor de comentarios. Si no está montado, click en "Comentar".
  const editorSels = [
    '.comments-comment-box .ql-editor[contenteditable="true"]',
    '.comments-comment-texteditor .ql-editor[contenteditable="true"]',
    'div.ql-editor[contenteditable="true"][data-placeholder]',
  ]
  let editor = await waitForSelector(editorSels, 4000)
  if (!editor) {
    // Revelar el composer: botón "Comentar"/"Comment".
    const commentBtn = Array.from(document.querySelectorAll('button')).find(b => {
      const al = (b.getAttribute('aria-label') || '').toLowerCase()
      const tx = (b.textContent || '').toLowerCase()
      return /coment|comment/.test(al) || /^\s*(comentar|comment)\s*$/.test(tx)
    })
    if (commentBtn) {
      await humanClick(commentBtn)
      await sleep(randInt(1000, 2000))
      editor = await waitForSelector(editorSels, 5000)
    }
  }
  if (!editor) {
    return { action: 'comment_on_post', status: 'error', error: 'comment_box_not_found', currentUrl: location.href }
  }

  // Escribir el comentario humanamente.
  await humanClick(editor)
  await sleep(randInt(300, 700))
  try {
    await humanTypeContentEditable(editor, comment)
  } catch (err) {
    return { action: 'comment_on_post', status: 'error', error: `typing_failed_${String(err.message ?? err).slice(0,60)}` }
  }
  await sleep(randInt(600, 1400))

  // Localizar el botón de publicar (se habilita cuando hay texto).
  const submitSels = [
    '.comments-comment-box__submit-button',
    'button.comments-comment-box__submit-button--cr',
    'button[class*="comments-comment-box__submit-button"]',
  ]
  let submitBtn = null
  for (const s of submitSels) {
    const b = document.querySelector(s)
    if (b && !b.disabled) { submitBtn = b; break }
  }
  // Fallback: botón con label Publicar/Comentar/Post dentro del comment box.
  if (!submitBtn) {
    const box = editor.closest('.comments-comment-box, .comments-comment-texteditor') || document
    submitBtn = Array.from(box.querySelectorAll('button')).find(b => {
      const al = (b.getAttribute('aria-label') || '').toLowerCase()
      const tx = (b.textContent || '').toLowerCase()
      return !b.disabled && (/publicar|^post$|comentar ahora/.test(al) || /^\s*(publicar|post|comentar)\s*$/.test(tx))
    })
  }
  if (!submitBtn) {
    return { action: 'comment_on_post', status: 'error', error: 'submit_button_not_found', currentUrl: location.href }
  }

  await humanClick(submitBtn)
  await sleep(randInt(1800, 3200))

  // Captcha/banner post-submit.
  const bodyTxt = (document.body?.innerText ?? '').toLowerCase()
  if (['captcha', 'verify you are human', 'verifica que eres humano', 'security check', 'unusual activity'].some(s => bodyTxt.includes(s))) {
    return { action: 'comment_on_post', status: 'error', error: 'captcha_detected', currentUrl: location.href }
  }

  // Verificación: Quill limpia el editor al publicar con éxito.
  const editorEmptied = !editor.isConnected || (editor.textContent || '').trim().length === 0
  if (!editorEmptied) {
    return { action: 'comment_on_post', status: 'error', error: 'submit_failed', currentUrl: location.href }
  }

  return { action: 'comment_on_post', status: 'posted', postUrn: payload.postUrn ?? null, postedAt: new Date().toISOString() }
}

async function searchLeads(payload = {}) {
  const targetCount = Math.min(payload.targetCount ?? 25, 200)
  const maxPages = Math.min(payload.maxPages ?? 10, 20)
  const companyNames = Array.isArray(payload.companyNames)
    ? payload.companyNames.filter(Boolean).map(_normForFilter)
    : []
  // Post-filter de location (fix 29-may-2026): si campaign tiene locations
  // configuradas, filtramos perfiles cuyo .location matcheen al menos una.
  // background.js ya mapea las ciudades conocidas a geoUrn (server-side).
  // Este filter es backup para ciudades NO mapeadas o cuando LinkedIn devuelve
  // perfiles de ubicaciones cercanas al geoUrn.
  const locationFilters = Array.isArray(payload.locations)
    ? payload.locations.filter(Boolean).map(_normForFilter)
    : []

  console.log(`[Orion content] searchLeads target=${targetCount} maxPages=${maxPages} url=${location.href}`)
  _searchPaginatorDebug = null  // v0.7.22 BUG-F: reset debug por-cmd

  // 1. Sanity check: debemos estar en /search/results/people/
  if (!/\/search\/results\/people/.test(location.pathname)) {
    return {
      action: 'search',
      status: 'error',
      error: 'not_on_search_page',
      currentUrl: location.href,
    }
  }

  // 2. Esperar al contenedor principal de resultados (lista de cards)
  const resultsSel = [
    'main ul[role="list"]',
    'main ul.reusable-search__entity-result-list',
    'main div.search-results-container',
    'main',
  ]
  const containerSel = await waitForSelector(resultsSel, 12000)
  if (!containerSel) {
    return {
      action: 'search',
      status: 'error',
      error: 'results_container_not_found',
      currentUrl: location.href,
    }
  }
  await sleep(1500)

  const collected = []
  const seenUrls = new Set()
  let page = 1
  let stopReason = null
  // v0.7.26 BUG company_names case-sensitivity: normalizar a minúsculas UNA vez.
  // Antes el filtro comparaba headline.toLowerCase().includes(c) con c en su case
  // original ("CEMEX","Softtek") → NUNCA matcheaba (minúscula no contiene mayúscula)
  // → TODOS los perfiles filtrados → cuenta Josh (27 empresas) scrapeó 0 por 6 días.
  const companyNamesLc = companyNames.filter(Boolean)  // ya normalizado (_normForFilter)

  while (page <= maxPages && collected.length < targetCount) {
    console.log(`[Orion content] Página ${page} — scrolling + extract`)

    // Scroll humano: 3-6 steps suaves para hidratar lazy-load
    await humanScrollSearch()

    // Extraer profile cards
    const pageProfiles = extractProfilesFromPage()
    console.log(`[Orion content] Page ${page} extrajo ${pageProfiles.length} perfiles`)

    let added = 0
    for (const p of pageProfiles) {
      if (seenUrls.has(p.profileUrl)) continue
      seenUrls.add(p.profileUrl)

      // Post-filter: si companyNames está set, headline debe matchear (case-insensitive v0.7.26).
      // NOTA: matchear company en headline es DÉBIL (los headlines de LinkedIn rara vez
      // incluyen el empleador). Si Josh necesita filtro estricto por empresa, mover a
      // filtro currentCompany en la URL de búsqueda (requiere company URN lookup).
      if (companyNamesLc.length > 0) {
        const h = _normForFilter(p.headline)
        const matched = companyNamesLc.some(c => h.includes(c))
        if (!matched) continue
      }
      // Post-filter de location: si campaign tiene locations, perfil debe
      // matchear al menos una por substring (case + accent-insensitive v0.7.28).
      if (locationFilters.length > 0) {
        const loc = _normForFilter(p.location)
        const locMatched = locationFilters.some(l => loc.includes(l))
        if (!locMatched) continue
      }
      collected.push(p)
      added++
      if (collected.length >= targetCount) break
    }
    console.log(`[Orion content] Page ${page}: +${added} (total ${collected.length}/${targetCount})`)

    if (collected.length >= targetCount) {
      stopReason = 'target_reached'
      break
    }
    if (pageProfiles.length === 0) {
      // C4 fix (2026-05-29): distinguir entre "no hay más resultados" (legítimo)
      // y "selector roto / captcha bloqueando" (problema). Si en página 1 hay 0
      // perfiles, revisar si el contenedor sigue ahí y si hay captcha visible.
      if (page === 1) {
        const containerStillThere = !!document.querySelector(resultsSel.join(','))
        const bodyTxt = (document.body?.innerText ?? '').toLowerCase()
        const captchaSignals = ['captcha', 'verify you are human', 'verifica que eres humano', 'security check', 'unusual activity']
        const captchaDetected = captchaSignals.some(s => bodyTxt.includes(s))
        if (captchaDetected) {
          return { action: 'search', status: 'error', error: 'captcha_detected', currentUrl: location.href }
        }
        if (!containerStillThere) {
          return { action: 'search', status: 'error', error: 'results_container_gone', currentUrl: location.href }
        }
        // v0.7.29 stress fix: ANTES de concluir "selector roto", distinguir el
        // empty-state legítimo (0 resultados) de un selector drift real. Un search
        // con 0 resultados NO es fallo de selector — reportarlo así disparaba
        // selector_tickets/L6 espurios y arrastraba el success-rate.
        // SEÑAL ESTRUCTURAL (independiente del idioma, más robusta que text-match):
        // contar links de perfil /in/ en el main. Si 0 → no hay personas en la
        // página → empty legítimo. Si hay /in/ pero el extractor sacó 0 → el
        // selector de card drifteó de verdad.
        const broadProfileLinks = document.querySelectorAll('main a[href*="/in/"]').length
        // Señal de texto secundaria (bilingüe) como respaldo.
        const noResultsSignals = [
          'no se encontraron resultados', 'no encontramos resultados', 'no hay resultados',
          'prueba con palabras clave', 'prueba con otras palabras',
          'no results', 'no results found', "couldn't find any results", 'try different keywords',
        ]
        const noResultsText = noResultsSignals.some(s => bodyTxt.includes(s))
        if (broadProfileLinks === 0 || noResultsText) {
          return {
            action: 'search', status: 'ok', profiles: [], pagesScraped: 1,
            totalFound: 0, stopReason: 'no_results_found',
            scrapedAt: new Date().toISOString(),
            debugSample: { broadProfileLinks, noResultsText },
          }
        }
        // Hay /in/ links pero el extractor sacó 0 → selector drift real.
        // Snippet del body + conteo para diagnóstico (observabilidad).
        return {
          action: 'search', status: 'error',
          error: 'no_profiles_in_page_1_selector_may_have_changed',
          currentUrl: location.href,
          debugSample: { broadProfileLinks, bodyTextSnippet: bodyTxt.slice(0, 400) },
        }
      }
      stopReason = 'empty_page'
      break
    }

    // Navegar a siguiente página — botón "Siguiente" o param &page=N
    const nextOk = await goToNextSearchPage(page + 1)
    if (!nextOk) {
      stopReason = 'no_next_page'
      break
    }
    page++
    // Delay humano entre páginas (no scrape rage)
    await sleep(randInt(4000, 9000))
  }

  if (!stopReason) stopReason = (page > maxPages) ? 'max_pages' : 'unknown'

  return {
    action: 'search',
    status: 'ok',
    profiles: collected,
    pagesScraped: page,
    stopReason,
    totalFound: collected.length,
    scrapedAt: new Date().toISOString(),
    // v0.7.22 BUG-F: incluir debug del paginador cuando paró por no_next_page
    ...(stopReason === 'no_next_page' && _searchPaginatorDebug ? { debugSample: _searchPaginatorDebug } : {}),
  }
}

// ── Fase 2 (SalesNav) — scrapea /sales/search/people/ ───────────────────────
// Se activa SOLO cuando payload.searchMode === 'sales_navigator' (cuentas Pro). El free
// path (Wal) queda 100% intacto. Iteración 2: SalesNav renderiza los resultados LENTO y en
// un contenedor con scroll PROPIO, así que (1) esperamos a que aparezcan filas reales
// (link /sales/lead/) hasta ~18s, (2) scrolleamos el contenedor interno (no la ventana),
// (3) en fallo devolvemos un probe DOM rico (conteos de selectores + outerHTML de la 1ª
// fila) para clavar selectores / resolución de /in/ en la siguiente pasada.
async function scrapeSalesNavPeople(payload = {}) {
  const targetCount = Math.min(payload.targetCount ?? 25, 50)
  const maxScrolls  = Math.min((payload.maxPages ?? 4) * 3, 18)
  console.log(`[Orion content] scrapeSalesNavPeople target=${targetCount} url=${location.href}`)

  if (!/\/sales\/search/.test(location.pathname)) {
    return { action: 'search', status: 'error', error: 'not_on_salesnav_search_page', currentUrl: location.href }
  }
  await waitForSelector(['#search-results-container', 'main'], 15000)

  // Espera activa: SalesNav puede tardar varios segundos en pintar las filas.
  for (let i = 0; i < 18; i++) {
    if (document.querySelectorAll('a[href*="/sales/lead/"]').length > 0) break
    await sleep(1000)
  }
  await sleep(1500)

  const locationFilters = Array.isArray(payload.locations)
    ? payload.locations.filter(Boolean).map(_normForFilter) : []

  const collected = []
  const seen = new Set()
  let noGrowth = 0, stopReason = null, droppedNoPublic = 0

  for (let s = 0; s < maxScrolls && collected.length < targetCount; s++) {
    const before = collected.length
    const { profiles, droppedNoPublic: dropped } = extractSalesNavProfiles()
    droppedNoPublic += dropped
    for (const p of profiles) {
      if (!p.profileUrl || seen.has(p.profileUrl)) continue
      // v5: SalesNav NO aplica post-filtro de ubicación — la extracción heurística de
      // location es poco confiable y descartaba leads válidos (scrapes daban 0 con
      // stop=no_growth). La keyword + el whitelist de título del scheduler ya targetean.
      // (Geo server-side en la URL de SalesNav = TODO futuro para precisión de país.)
      seen.add(p.profileUrl)
      collected.push(p)
      if (collected.length >= targetCount) break
    }
    console.log(`[Orion content] SalesNav scroll ${s + 1}: total ${collected.length}/${targetCount} (sin /in/: ${droppedNoPublic})`)

    if (collected.length >= targetCount) { stopReason = 'target_reached'; break }

    // Ninguna fila detectada en la 1ª pasada → captcha / 0-resultados / drift de selector.
    if (s === 0 && profiles.length === 0 && droppedNoPublic === 0) {
      const bodyTxt = (document.body?.innerText ?? '').toLowerCase()
      if (/captcha|verify you are human|verifica que eres humano|security check|unusual activity/.test(bodyTxt))
        return { action: 'search', status: 'error', error: 'captcha_detected', currentUrl: location.href }
      const dbg = salesNavDebugProbe()
      if (dbg.salesLeadLinks === 0 && /no se han encontrado resultados|no results found|sin resultados|0 resultados/.test(bodyTxt)) {
        return { action: 'search', status: 'ok', profiles: [], totalFound: 0, stopReason: 'no_results_found',
          scrapedAt: new Date().toISOString(), debugSample: dbg }
      }
      return { action: 'search', status: 'error', error: 'salesnav_no_rows_found',
        currentUrl: location.href, debugSample: dbg }
    }

    if (collected.length === before) { if (++noGrowth >= 2) { stopReason = 'no_growth'; break } }
    else noGrowth = 0
    scrollSalesNavResults()
    await sleep(randInt(2000, 3500))
  }
  if (!stopReason) stopReason = 'max_scrolls'

  const result = {
    action: 'search', status: 'ok', profiles: collected, totalFound: collected.length,
    stopReason, searchMode: 'sales_navigator', droppedNoPublic,
    scrapedAt: new Date().toISOString(),
  }
  // Filas SalesNav encontradas pero NINGUNA con /in/ público → necesito el DOM del card
  // para resolver el /in/ (fase 2b: vía data-attr, lead-page, o adaptar el invite).
  if (collected.length === 0 && droppedNoPublic > 0) result.debugSample = salesNavDebugProbe()
  return result
}

// Extractor SalesNav. Ancla en a[href*="/sales/lead/"] (el nombre del lead). Del card saca
// nombre + headline + location y RESUELVE el /in/ público (a[href*="/in/"] dentro del card),
// imprescindible para invitar. Sin /in/ → fuera + contado. Devuelve { profiles, droppedNoPublic }.
function extractSalesNavProfiles() {
  const NOISE_RE = /conectar|connect|mensaje|message|guardar|save|seguir|follow|grado|degree|premium|inmail|a[ñn]adir|selecci[óo]n|disponible|available|en l[íi]nea|online|est[áa] en l|a11y/i
  const seen = new Set()
  const profiles = []
  let droppedNoPublic = 0  // ahora = filas sin nombre extraíble (el /in/ ya no se exige)

  for (const link of Array.from(document.querySelectorAll('a[href*="/sales/lead/"]'))) {
    const href = link.getAttribute('href') || ''
    // URL estable del lead SalesNav (path token,NAME_SEARCH,hash) sin query params (?_ntb=…).
    const path = href.split('?')[0].replace(/^https?:\/\/[^/]+/, '')
    if (!path.includes('/sales/lead/')) continue
    const profileUrl = `https://www.linkedin.com${path}`
    if (seen.has(profileUrl)) continue

    const card = link.closest('li') || link.closest('[data-x-search-result]')
      || link.parentElement?.parentElement?.parentElement?.parentElement || null
    if (!card) continue

    // Nombre: SalesNav lo pone en <span data-anonymize="person-name">; fallback al alt del
    // avatar ("Ir al perfil de <Nombre>"). NO es text-node directo del <a> (por eso v2 sacó 0).
    let name = card.querySelector('[data-anonymize="person-name"]')?.textContent?.replace(/\s+/g, ' ').trim() || null
    if (!name) {
      const alt = card.querySelector('img[alt*="perfil de"]')?.getAttribute('alt') || ''
      name = alt.replace(/^.*perfil de\s*/i, '').trim() || null
    }
    if (!name || name.length > 80) { droppedNoPublic++; continue }
    seen.add(profileUrl)

    // Headline + location: heurística de texto del card (excluye ruido a11y).
    const texts = Array.from(card.querySelectorAll('span, div'))
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(t => t && t !== name && t.length < 120 && !NOISE_RE.test(t))
    const headline = texts.find(t => /director|gerente|ceo|cto|cfo|coo|cmo|vp|head|chief|manager|lead|founder|president|owner|due[nñ]|socio/i.test(t)) || texts[0] || null
    const locationStr = texts.find(t => /,|m[eé]xico|colombia|chile|per[uú]|espa[nñ]a|argentina|estados unidos|united states|panam|costa rica|uruguay|paraguay|bolivia|el salvador/i.test(t)) || null

    profiles.push({
      profileUrl,
      name,
      headline: headline ? headline.slice(0, 300) : null,
      location: locationStr ? locationStr.slice(0, 120) : null,
    })
  }
  return { profiles, droppedNoPublic }
}

// Scroll del contenedor INTERNO de resultados de SalesNav (no window — la lista tiene su
// propio overflow y window.scrollBy no lazy-loadea más filas).
function scrollSalesNavResults() {
  const container = document.querySelector('#search-results-container')
    || document.querySelector('ol.artdeco-list')?.parentElement
    || Array.from(document.querySelectorAll('div,section')).find(el =>
        el.scrollHeight > el.clientHeight + 200 && el.querySelector('a[href*="/sales/lead/"]'))
  if (container) container.scrollTop = container.scrollHeight
  else window.scrollBy(0, 900)
}

// Probe DOM rico: cuenta cada selector candidato + outerHTML de la 1ª fila candidata.
// Es lo que necesito para clavar selectores / resolución de /in/ sin ver el DOM en vivo.
function salesNavDebugProbe() {
  const q = sel => { try { return document.querySelectorAll(sel).length } catch { return -1 } }
  const firstRow =
    document.querySelector('a[href*="/sales/lead/"]')?.closest('li')
    || document.querySelector('[data-anonymize="person-name"]')?.closest('li')
    || document.querySelector('ol.artdeco-list > li, li[class*="result"], div[class*="entity-lockup"]')
    || document.querySelector('#search-results-container')
    || document.querySelector('main')
  return {
    url:               location.href.slice(0, 120),
    salesLeadLinks:    q('a[href*="/sales/lead/"]'),
    salesAnyLinks:     q('a[href*="/sales/"]'),
    inLinks:           q('a[href*="/in/"]'),
    anchorsTotal:      q('a'),
    listItems:         q('li'),
    dataAnonPerson:    q('[data-anonymize="person-name"]'),
    dataAnonHeadline:  q('[data-anonymize="headline"]'),
    entityLockups:     q('.artdeco-entity-lockup, [class*="entity-lockup"]'),
    resultsContainer:  q('#search-results-container'),
    iframes:           q('iframe'),
    firstRowHtml:      firstRow ? String(firstRow.outerHTML || firstRow.innerHTML || '').slice(0, 2200) : null,
    bodySnippet:       (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400),
  }
}

// Extrae profile cards del DOM en la página de search results.
// Port directo de search.js extractProfilesFromPage adaptado a content.js.
function extractProfilesFromPage() {
  const NOISE_RE = /^[•·]\s*\d|conectar|connect|mensaje|message|seguir|follow|pendiente|contactos? más en común|other mutual connections|mutual connection/i
  const seen = new Set()
  const results = []

  const allLinks = Array.from(document.querySelectorAll(
    'a[href*="/in/"], a[href*="linkedin.com/in/"]'
  ))

  for (const link of allLinks) {
    const href = link.getAttribute('href') || ''
    const fullHref = href.startsWith('http') ? href : `https://www.linkedin.com${href}`
    const profileUrl = fullHref.split('?')[0].replace(/\/$/, '') + '/'
    if (!profileUrl.includes('/in/')) continue
    if (seen.has(profileUrl)) continue

    // Name: solo text nodes directos del anchor (ignora child spans tipo badge)
    const nameFromNodes = Array.from(link.childNodes)
      .filter(n => n.nodeType === 3)
      .map(n => n.textContent.trim())
      .filter(Boolean)
      .join(' ')
      .trim()

    if (!nameFromNodes || nameFromNodes.length > 80) continue
    if (NOISE_RE.test(nameFromNodes)) continue

    seen.add(profileUrl)
    const name = nameFromNodes

    // Walk up 4 levels para encontrar card container
    let card = link.parentElement?.parentElement?.parentElement?.parentElement || null

    // Estrategia preferida: clases LinkedIn explícitas para primary/secondary subtitle
    // primary-subtitle = headline (Director, CTO, etc.)
    // secondary-subtitle = location (Ciudad, País)
    let headline = null
    let locationStr = null
    if (card) {
      const primaryEl = card.querySelector('[class*="primary-subtitle"], [class*="entity-result__primary-subtitle"]')
      const secondaryEl = card.querySelector('[class*="secondary-subtitle"], [class*="entity-result__secondary-subtitle"]')
      if (primaryEl)   headline    = (primaryEl.textContent || '').replace(/\s+/g, ' ').trim()
      if (secondaryEl) locationStr = (secondaryEl.textContent || '').replace(/\s+/g, ' ').trim()
    }

    // Fallback: parsing por <p> con heurísticas mejoradas
    if (!headline) {
      const paras = card
        ? Array.from(card.querySelectorAll('p'))
            .map(p => (p.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(t =>
              t &&
              t !== name &&
              t.length < 100 &&
              !NOISE_RE.test(t) &&
              !t.includes(name.split(' ')[0])
            )
        : []

      // Detector de "esto es location": 2+ comas, palabras de geografía, sin verbo/rol
      const looksLikeLocation = (t) => {
        if (!t) return false
        const lower = t.toLowerCase()
        // Frases que SIEMPRE son ubicación (no requieren comma)
        const strongGeoPhrases = [
          'área metropolitana', 'metropolitan area', 'greater ', ' area',
          'estado de', 'cdmx', 'ciudad de méxico', 'ciudad de mexico',
          'mexico city', 'buenos aires', 'são paulo', 'sao paulo',
        ]
        if (strongGeoPhrases.some(g => lower.includes(g))) return true
        // Estados/ciudades MX/LATAM frecuentes (suelen aparecer solos)
        const standalonePlaces = [
          'méxico', 'mexico', 'argentina', 'chile', 'colombia', 'peru', 'perú',
          'spain', 'españa', 'usa', 'united states', 'brasil', 'brazil',
          'monterrey', 'guadalajara', 'tijuana', 'puebla', 'querétaro', 'queretaro',
          'tabasco', 'jalisco', 'nuevo león', 'nuevo leon', 'tamaulipas',
          'sonora', 'sinaloa', 'chihuahua', 'veracruz', 'yucatán', 'yucatan',
          'nayarit', 'oaxaca', 'guerrero', 'michoacán', 'michoacan',
          'aguascalientes', 'morelos', 'coahuila', 'durango', 'zacatecas',
          'hidalgo', 'tlaxcala', 'campeche', 'quintana roo', 'baja california',
          'colima', 'nuevo laredo', 'mérida', 'merida', 'cancún', 'cancun',
          'cabo san lucas', 'tuxtla', 'culiacán', 'culiacan', 'mexicali',
          'león', 'leon', 'san luis potosí',
        ]
        const commas = (t.match(/,/g) || []).length
        // Si toda la string es una palabra/place geográfico standalone
        const trimmed = t.trim().toLowerCase()
        if (trimmed.length < 40 && standalonePlaces.some(p => trimmed === p || trimmed.startsWith(p + ',') || trimmed.endsWith(', ' + p))) return true
        if (commas >= 2) return true
        if (standalonePlaces.some(g => lower.includes(g)) && commas >= 1) return true
        // Si toda la string son palabras capitalizadas separadas por comas → ubicación
        if (/^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+([\s\-]+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*(,\s*[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+$/.test(t)) return true
        return false
      }
      // Detector de "X contactos más en común" / "X mutual connections"
      const looksLikeMutualConnections = (t) => {
        if (!t) return false
        return /contactos?\s+más\s+en\s+común|mutual connections?|contactos? en común/i.test(t)
      }

      const looksLikeTitle = (t) => {
        if (!t || t.length < 5) return false
        const lower = t.toLowerCase()
        const roleTerms = ['director', 'directora', 'gerente', 'manager', 'chief', 'ceo',
                           'cto', 'cio', 'cfo', 'cmo', 'cdo', 'coo', 'vp', 'vice president',
                           'founder', 'fundador', 'cofundador', 'head of', 'jefe', 'lead',
                           'consultor', 'consultant', 'analista', 'analyst', 'especialista',
                           'engineer', 'ingeniero', 'developer', 'designer', 'president',
                           'presidente', 'owner', 'partner', 'socio', 'profesional']
        return roleTerms.some(r => lower.includes(r))
      }

      // Filtrar paragraphs ruidosos (mutual connections, location) ANTES de elegir
      const cleanParas = paras.filter(p => !looksLikeMutualConnections(p))

      // Prioridad 1: el primer paragraph que parece un título de trabajo
      headline = cleanParas.find(p => looksLikeTitle(p) && !looksLikeLocation(p)) ?? null
      // Prioridad 2: el primer paragraph que NO es location ni mutual
      if (!headline) headline = cleanParas.find(p => !looksLikeLocation(p) && p.length > 5) ?? null
      // Prioridad 3: lo que venga (caso degradado) — pero rechazar si TODO el card es ruido
      if (!headline) headline = cleanParas[0] ?? null
      // Si headline sigue siendo location/mutual, mejor null que basura
      if (headline && (looksLikeLocation(headline) || looksLikeMutualConnections(headline))) {
        headline = null
      }

      // Location: el primer que parece location, no es el headline
      if (!locationStr) locationStr = paras.find(p => p !== headline && looksLikeLocation(p)) ?? null
    }

    results.push({ profileUrl, name, headline, location: locationStr })
  }
  return results
}

// Scroll humanizado para lazy-load de results page
async function humanScrollSearch() {
  const steps = randInt(3, 6)
  for (let i = 0; i < steps; i++) {
    window.scrollBy(0, randInt(250, 450))
    await sleep(randInt(300, 700))
  }
  await sleep(randInt(500, 1200))
  window.scrollTo({ top: 0, behavior: 'smooth' })
  await sleep(randInt(600, 1000))
}

// Navega a la siguiente página de resultados.
// Strategy: buscar botón "Siguiente" (aria-label), o fallback a URL param &page=N.
// v0.7.22 BUG-F: capturado para diagnóstico — searchLeads lo incluye en result.debugSample
let _searchPaginatorDebug = null

async function goToNextSearchPage(nextPageNum) {
  // v0.7.24 BUG-F (fix4 — REVERT de fix3): LinkedIn usa paginación numerada
  // (aria-label="Página N"), pero clickearla REINYECTA content.js (la página
  // navega/re-renderiza) → la promesa de search queda huérfana y el comando
  // se cuelga 15min (stuck dispatched, retorna 0 profiles). Esto es una
  // limitación ARQUITECTÓNICA: el scrape multi-página en un solo comando es
  // frágil porque cualquier navegación destruye el content script en ejecución.
  //
  // DECISIÓN: NO intentar paginar dentro del comando. Retornar limpio con
  // page 1 (10 profiles). El multi-page real requiere orquestación SW
  // (re-dispatch search con &page=N tras cada nav, acumular server-side) — un
  // rediseño fuera de scope. Mientras, la rotación de keywords del scheduler
  // da variedad de leads (13 keywords × 10 = 130 leads/ciclo).
  //
  // Capturamos los botones de página disponibles como evidencia para el rediseño.
  try {
    const pageButtons = Array.from(document.querySelectorAll('button[aria-label*="ágina" i], button[aria-label*="age" i]'))
      .map(b => b.getAttribute('aria-label')).filter(Boolean)
    _searchPaginatorDebug = {
      next_page_wanted: nextPageNum,
      page_buttons_found: pageButtons,
      note: 'multi-page scrape deshabilitado (content.js reinject en pagination) — requiere SW orchestration',
    }
  } catch {}
  return false  // siempre page-1 clean; no orfanar el comando
}

// ── check_connections — scrape /mynetwork/invite-connect/connections/ ─────────
// (2026-07-04) Accept-detection POSITIVA: si un lead invite_sent APARECE en nuestra lista de
// conexiones → aceptó DE VERDAD (presencia, no inferencia por ausencia como check_sent_invites).
// Cierra las zonas ciegas (ventana/boundary/timing) que dejaban accepts sin detectar. El bridge
// cruza con la DB por URL/nombre; content.js solo scrape.
async function checkConnections(payload = {}) {
  console.log(`[Orion content] checkConnections currentUrl=${location.href}`)
  if (!/\/mynetwork\/.*connections/.test(location.pathname)) {
    return { action: 'check_connections', status: 'error', error: 'not_on_connections_page', currentUrl: location.href }
  }
  const found = await waitForSelector(['main a[href*="/in/"]', 'main section', 'main'], 12000)
  if (!found) return { action: 'check_connections', status: 'error', error: 'container_not_found' }
  await sleep(1500)

  // (0.9.15) La lista de conexiones scrollea DENTRO de un contenedor (main con overflow), NO
  // la window → window.scroll no dispara el lazy-load (quedaba en 10 de 658). Detectamos el
  // contenedor scrollable y lo scrolleamos. Además ACUMULAMOS URLs por si la lista está
  // virtualizada (solo ~10 items en el DOM a la vez). Y preferimos el anchor CON nombre (cada
  // card tiene 2 anchors /in/: avatar sin texto + nombre con texto; antes nos quedábamos con el avatar).
  const findScrollEl = () => [...document.querySelectorAll('main, main *')]
    .find(el => el.scrollHeight > el.clientHeight + 300 && /auto|scroll/.test(getComputedStyle(el).overflowY))
    || document.scrollingElement || document.documentElement

  const byUrl = new Map()  // url → mejor nombre visto
  const collect = () => {
    for (const a of document.querySelectorAll('main a[href*="/in/"]')) {
      const href = a.getAttribute('href') || ''
      const full = href.startsWith('http') ? href : `https://www.linkedin.com${href}`
      const url = full.split('?')[0].replace(/\/$/, '') + '/'
      if (!url.includes('/in/')) continue
      let name = (a.textContent || '').trim()
      if (!name) name = (a.getAttribute('aria-label') || '').trim()
      if (name.length > 80) name = name.slice(0, 80)
      const prev = byUrl.get(url)
      if (prev === undefined || (!prev && name)) byUrl.set(url, name)  // prefiere el que tenga nombre
    }
  }

  collect()
  let prevSize = -1, stable = 0
  for (let i = 0; i < 80 && stable < 4; i++) {
    const sc = findScrollEl()
    if (sc.scrollBy) sc.scrollBy(0, Math.round((sc.clientHeight || window.innerHeight) * 0.85))
    else sc.scrollTop = sc.scrollHeight
    await sleep(randInt(450, 750))
    const moreBtn = [...document.querySelectorAll('main button, main [role="button"]')]
      .find(b => b.offsetParent !== null && /mostrar m[áa]s|ver m[áa]s|m[áa]s resultados|show more|load more/i.test((b.textContent || '').trim()))
    if (moreBtn) { moreBtn.click(); await sleep(randInt(800, 1300)) }
    collect()
    if (byUrl.size === prevSize && !moreBtn) stable++; else { stable = 0; prevSize = byUrl.size }
    if (byUrl.size >= 800) break  // cap de seguridad
  }

  const connections = [...byUrl.entries()].map(([profileUrl, name]) => ({ profileUrl, name }))
  return {
    action: 'check_connections', status: 'ok',
    connections, count: connections.length,
    scrapedAt: new Date().toISOString(),
  }
}

// ── 3.5 — check_sent_invites — scrape /mynetwork/invitation-manager/sent/ ────
//
// Detecta accepts sin nota: si nuestra DB tiene leads en status='invite_sent'
// pero NO aparecen en la lista de pending sent invitations, fueron aceptados
// (o withdrew, pero asumimos accept como caso común).
//
// El bridge cruza con DB. content.js solo scrape la lista.

async function checkSentInvites(payload = {}) {
  console.log(`[Orion content] checkSentInvites currentUrl=${location.href}`)

  if (!/\/mynetwork\/invitation-manager\/sent/.test(location.pathname)) {
    return {
      action: 'check_sent_invites',
      status: 'error',
      error: 'not_on_sent_invitations_page',
      currentUrl: location.href,
    }
  }

  // Esperar al contenedor principal
  const sels = [
    'main section',
    'main div[class*="invitation-card"]',
    'main',
  ]
  const found = await waitForSelector(sels, 12000)
  if (!found) {
    return { action: 'check_sent_invites', status: 'error', error: 'container_not_found' }
  }
  await sleep(1500)

  // v0.7.37: scroll hasta cargar TODAS las invitaciones (lazy-load). CRÍTICO para
  // no falsos-accepts: concluir "no está en pending = aceptado" solo es seguro si
  // la lista está COMPLETA. Antes 4×600px cargaba ~10 de 86 → leads viejos fuera
  // del batch se marcarían connected falsamente. Ahora scroll hasta que el conteo
  // de /in/ anchors se estabilice (3 rondas sin crecer) o tope de 40 iteraciones.
  // v0.7.38: cargar TODAS las invitaciones. LinkedIn /sent/ PAGINA (no scroll
  // infinito) — scroll solo da ~10. Combinamos scroll + click en botón "Mostrar
  // más resultados" (append in-page, SIN navegación → sin content.js reinject).
  const loadMoreDebug = []
  {
    const mainEl = document.querySelector('main') || document.body
    const moreRe = /mostrar m[áa]s|ver m[áa]s|cargar m[áa]s|m[áa]s resultados|show more|load more|see more/i
    let prevN = -1, stableRounds = 0
    for (let i = 0; i < 50 && stableRounds < 3; i++) {
      window.scrollTo(0, document.body.scrollHeight)
      await sleep(randInt(450, 800))
      // Buscar botón "mostrar más" visible y clickearlo
      const btns = Array.from(mainEl.querySelectorAll('button, [role="button"]'))
      const moreBtn = btns.find(b => b.offsetParent !== null && moreRe.test((b.textContent || '').trim()))
      if (moreBtn) {
        if (loadMoreDebug.length < 3) loadMoreDebug.push((moreBtn.textContent || '').trim().slice(0, 40))
        moreBtn.click()
        await sleep(randInt(900, 1500))
      }
      const n = mainEl.querySelectorAll('a[href*="/in/"]').length
      if (n === prevN && !moreBtn) stableRounds++
      else { stableRounds = 0; prevN = n }
    }
    window.scrollTo({ top: 0 })
    await sleep(800)
  }

  // Cada invitación pending tiene:
  // - <a href="/in/<vanity>/"> con el nombre del invitado
  // - Algún wrapper con "Pendiente" o "Pending" text
  // Estrategia: extraer todos los anchors a /in/<vanity> en main, dedupe.
  const main = document.querySelector('main') || document.body
  const links = Array.from(main.querySelectorAll('a[href*="/in/"]'))
  const pending = []
  const seenUrls = new Set()

  for (const link of links) {
    const href = link.getAttribute('href') || ''
    const full = href.startsWith('http') ? href : `https://www.linkedin.com${href}`
    const url = full.split('?')[0].replace(/\/$/, '') + '/'
    if (!url.includes('/in/')) continue
    if (seenUrls.has(url)) continue
    // v0.7.35 fix: estructura SDUI (componentkey) — el nombre YA NO es text node
    // directo del anchor (está en span anidado). Extracción robusta multi-fuente:
    //   1. text nodes directos (estructura vieja)
    //   2. textContent completo del anchor (span anidado)
    //   3. aria-label del anchor
    // Y CRÍTICO: NO descartar si el nombre queda vacío — la URL basta para el
    // match del ingest (matchea por URL O nombre). Antes el skip-on-empty-name
    // tiraba los 10 anchors → parser devolvía 0.
    let name = Array.from(link.childNodes)
      .filter(n => n.nodeType === 3).map(n => n.textContent.trim()).filter(Boolean).join(' ').trim()
    if (!name) name = (link.textContent || '').trim()
    if (!name) name = (link.getAttribute('aria-label') || '').trim()
    if (name.length > 80) name = name.slice(0, 80)
    seenUrls.add(url)
    pending.push({ profileUrl: url, name })
  }

  // v0.7.37: total declarado por LinkedIn ("personas (86)" / "people (86)") para
  // chequeo de completitud en el ingest (si capturamos < total → scrape incompleto
  // → NO marcar accepts, evita falsos por lazy-load/paginación).
  let statedTotal = null
  const mainTxt = (main.innerText || '')
  const tm = mainTxt.match(/personas?\s*\((\d+)\)/i) || mainTxt.match(/people\s*\((\d+)\)/i)
  if (tm) statedTotal = parseInt(tm[1], 10)

  const out = {
    action: 'check_sent_invites',
    status: 'ok',
    pending,
    count: pending.length,
    statedTotal,
    loadMoreClicked: loadMoreDebug,
    scrapedAt: new Date().toISOString(),
  }
  // Si quedó incompleto (count < statedTotal), capturar textos de botones visibles
  // para diagnosticar el mecanismo de paginación real.
  if (statedTotal && pending.length < statedTotal) {
    out.buttonTexts = Array.from(main.querySelectorAll('button, [role="button"]'))
      .filter(b => b.offsetParent !== null)
      .map(b => (b.textContent || '').trim())
      .filter(t => t && t.length < 40)
      .slice(0, 25)
  }
  // v0.7.35 instrumentación: si count=0, capturar diagnóstico para ver POR QUÉ
  // el parser /sent/ no encuentra invitaciones (gap conocido: drift de estructura).
  if (pending.length === 0) {
    const bodyTxt = (main.innerText || '').toLowerCase()
    out.debugSample = {
      allAnchors: main.querySelectorAll('a').length,
      inAnchors: main.querySelectorAll('a[href*="/in/"]').length,
      hasPendingText: /pendiente|pending|retirar|withdraw/.test(bodyTxt),
      cardHits: {
        invitationCard: main.querySelectorAll('[class*="invitation-card"]').length,
        li: main.querySelectorAll('li').length,
        componentkey: main.querySelectorAll('[componentkey]').length,
        artdecoEntity: main.querySelectorAll('[class*="entity-lockup"], [class*="artdeco-entity"]').length,
      },
      bodySnippet: bodyTxt.slice(0, 400),
    }
  }
  return out
}
