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

console.log('[Orion content] v0.5.1 loaded on', window.location.href)

// ── Keep-alive port para que el service worker no se duerma ─────────────────
// MV3 mata el SW después de 30s idle. Mientras esta página de LinkedIn esté
// abierta, mantenemos un Port conectado que evita que el SW muera. Cuando
// cierres la tab, el SW puede dormir (sin actividad).
let keepAlivePort = null
function startKeepAlive() {
  try {
    keepAlivePort = chrome.runtime.connect({ name: 'keep-alive' })
    keepAlivePort.onDisconnect.addListener(() => {
      console.log('[Orion content] keep-alive port disconnected — reconnecting in 1s')
      keepAlivePort = null
      setTimeout(startKeepAlive, 1000)
    })
    // Ping periódico para mantener actividad
    setInterval(() => {
      try { keepAlivePort?.postMessage({ type: 'ping', ts: Date.now() }) } catch {}
    }, 10_000)
    console.log('[Orion content] keep-alive port activo')
  } catch (err) {
    console.warn('[Orion content] keep-alive failed:', err.message)
    setTimeout(startKeepAlive, 2000)
  }
}
startKeepAlive()

// ── Listener de comandos del background ─────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'orion_command') return false

  const { commandId, action, payload } = msg
  console.log(`[Orion content] Command ${action} (${commandId})`, payload)

  // Ejecutar de forma asíncrona y responder
  executeAction(action, payload)
    .then(result => sendResponse({ ok: true, ...result }))
    .catch(err => sendResponse({ ok: false, error: err.message ?? String(err) }))

  return true  // mantener canal abierto para sendResponse asíncrono
})

// ── Acciones disponibles ────────────────────────────────────────────────────

async function executeAction(action, payload) {
  switch (action) {
    case 'check_inbox':
      return await checkInbox(payload)
    case 'send_invite':
      return await sendInvite(payload)
    case 'send_followup':
      return await sendFollowup(payload)
    case 'search':
      return await searchLeads(payload)
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
  const limit = Math.min(payload.limit ?? 30, 50)
  console.log(`[Orion content] checkInbox: limit=${limit}, currentUrl=${location.href}`)

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
  const containerSel = [
    '.msg-conversations-container__conversations-list',
    '.msg-conversations-container',
    '[class*="msg-conversations-container"]',
    'ul[class*="conversations-list"]',
  ]
  const containerFound = await waitForSelector(containerSel, 15000)
  if (!containerFound) {
    return { action: 'check_inbox', status: 'error', error: 'conversations_container_not_found', url: location.href }
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
  let items = []
  for (const sel of itemSelectors) {
    items = Array.from(document.querySelectorAll(sel))
    if (items.length > 0) break
  }
  if (items.length === 0) {
    return { action: 'check_inbox', status: 'empty', conversations: [], url: location.href, note: 'No conversation items found in DOM' }
  }

  console.log(`[Orion content] ${items.length} conversation items detectados`)

  // 4. Normalizar cada item
  const conversations = []
  for (const el of items.slice(0, limit)) {
    const parsed = parseConversationItem(el)
    if (parsed) conversations.push(parsed)
  }

  // 5. Debug: si todos los threadId están null, incluir muestra del primer item
  // para iterar selectores en próxima ronda
  const allThreadIdsNull = conversations.length > 0 && conversations.every(c => !c.threadId)
  const debugSample = allThreadIdsNull && items[0] ? {
    outerHTML: items[0].outerHTML.slice(0, 800),
    attrs: Array.from(items[0].attributes).map(a => ({ name: a.name, value: a.value.slice(0, 80) })),
    linkHrefs: Array.from(items[0].querySelectorAll('a[href]')).map(a => a.href).slice(0, 5),
  } : null

  return {
    action: 'check_inbox',
    status: 'ok',
    conversations,
    scrapedAt: new Date().toISOString(),
    url: location.href,
    ...(debugSample ? { debugSample } : {}),
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

    // (1) data attributes en el item o sus hijos
    const dataAttrs = [
      'data-conversation-urn',
      'data-urn',
      'data-conversation-id',
      'data-thread-id',
    ]
    for (const attr of dataAttrs) {
      const found = el.getAttribute(attr) ?? el.querySelector(`[${attr}]`)?.getAttribute(attr)
      if (found) {
        // URN format: urn:li:msg_conversation:(...,2-<base64>) o solo 2-<base64>
        const m = found.match(/2-[A-Za-z0-9_=-]{16,}/)
        if (m) threadId = m[0]
        break
      }
    }

    // (2) href de links que matchean /messaging/thread/<id>/
    if (!threadId) {
      const linkEls = el.querySelectorAll('a[href]')
      for (const linkEl of linkEls) {
        const href = linkEl.getAttribute('href') ?? ''
        const m = href.match(/\/messaging\/thread\/([^/?#]+)/)
        if (m) {
          threadId = decodeURIComponent(m[1])
          threadUrl = linkEl.href
          break
        }
      }
    }
    // Construir threadUrl si tenemos threadId pero no URL
    if (threadId && !threadUrl) {
      threadUrl = `https://www.linkedin.com/messaging/thread/${threadId}/`
    }

    // ── Profile URL del otro participante ────────────────────────────────
    // En el listing puede no aparecer (LinkedIn solo lo muestra al abrir el thread).
    // Buscamos en: <a href*="/in/"> dentro del item.
    let profileUrl = null
    const profileLinks = el.querySelectorAll('a[href*="/in/"]')
    for (const pl of profileLinks) {
      const href = pl.getAttribute('href') ?? ''
      if (href.includes('/in/')) {
        profileUrl = pl.href
        break
      }
    }

    return {
      name,
      snippet:    snippet ? snippet.slice(0, 250) : null,
      unread,
      time,           // texto crudo: "1 min", "Yesterday", "20 may"
      threadId,
      threadUrl,
      profileUrl,
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

async function sendInvite(payload = {}) {
  const { profileUrl, message, leadName, dryRun } = payload
  console.log(`[Orion content] sendInvite: profile=${profileUrl}, dryRun=${dryRun}, currentUrl=${location.href}`)

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
async function sendInviteFromCustomInvite(payload) {
  const { message, dryRun } = payload
  const withNote = !!message  // Si message es null/empty/undefined → sin nota
  console.log(`[Orion content] PATH A — Modal SPA route, withNote=${withNote}`)

  // 1. Esperar modal (¿Añadir una nota?)
  const modalSel = '[role="dialog"], .artdeco-modal'
  const found = await waitForSelector([modalSel], 8000)
  if (!found) {
    return { action: 'send_invite', status: 'error', error: 'preload_modal_not_rendered', url: location.href }
  }
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
  await humanClick(addNoteBtn)
  await sleep(randInt(1500, 2500))  // espera a que textarea aparezca

  // 4. Buscar textarea
  const textarea = await findNoteTextarea({ timeoutMs: 5000 })
  if (!textarea) {
    return {
      action: 'send_invite',
      status: 'error',
      error:  'textarea_not_appeared_after_add_note_click',
      modalDebug: dumpModalContent(),
    }
  }

  // 5. Tipear mensaje (humanType)
  console.log(`[Orion content] Typing message (${message.length} chars)`)
  await humanType(textarea, message.slice(0, 290))
  await sleep(randInt(500, 1000))

  // 6. dryRun: cancelar (click X o ESC) sin enviar
  if (dryRun) {
    console.log('[Orion content] DRY RUN — cerrando modal sin enviar')
    // Intentar X primero
    const closeBtn = document.querySelector('[role="dialog"] button[aria-label*="cerrar" i], [role="dialog"] button[aria-label*="close" i], .artdeco-modal__dismiss')
    if (closeBtn) {
      await humanClick(closeBtn)
    } else {
      // Fallback: ESC keypress
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }
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
    let delay = randInt(55, 130)
    if ('.,!?¡¿'.includes(ch)) delay += randInt(80, 200)
    if (Math.random() < 0.06) delay += randInt(250, 500)
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

async function sendFollowup(payload = {}) {
  const { threadUrl, message, leadName, dryRun } = payload
  console.log(`[Orion content] sendFollowup: thread=${threadUrl?.slice(0, 60)}, dryRun=${dryRun}`)

  // 1. Verificar URL
  if (!location.href.includes('/messaging/thread/')) {
    return {
      action: 'send_followup',
      status: 'error',
      error:  'not_on_thread_page',
      currentUrl: location.href,
    }
  }

  // 2. Captcha/checkpoint check
  if (/\/checkpoint|\/challenge|\/authwall/.test(location.href)) {
    return { action: 'send_followup', status: 'error', error: 'captcha_or_checkpoint' }
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
      }))
    return {
      action: 'send_followup',
      status: 'error',
      error:  'thread_editor_not_found',
      url:    location.href,
      debugEditables: allEditables,
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

  // 5. humanType en contenteditable
  console.log(`[Orion content] Typing FU (${message.length} chars) en thread de ${headerName || '?'}`)
  editor.focus()
  await sleep(randInt(300, 600))
  await humanTypeContentEditable(editor, message.slice(0, 8000))  // LinkedIn permite mensajes largos
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

  // 7. Click Send button (botón regular del thread footer)
  const sendBtn = findThreadSendButton()
  if (!sendBtn) {
    return {
      action: 'send_followup',
      status: 'error',
      error:  'send_button_not_found',
      visibleBtns: listVisibleButtons(),
    }
  }
  await humanClick(sendBtn)
  await sleep(randInt(2000, 3000))

  // 8. Verificar que el mensaje aparece en el thread (último mensaje)
  const confirmed = await verifyFollowupSent(message)

  return {
    action: 'send_followup',
    status: confirmed ? 'sent' : 'sent_unconfirmed',
    editorUsed: true,
    headerName,
    sentAt: new Date().toISOString(),
  }
}

// ── Helpers thread page ──────────────────────────────────────────────────────

function readThreadHeader() {
  const sels = [
    '.msg-entity-lockup__entity-title',
    '.msg-thread-top-bar-contact-info .t-bold',
    '.msg-thread-detail__header .t-bold',
    'h2[class*="msg-thread"]',
  ]
  for (const sel of sels) {
    const el = document.querySelector(sel)
    if (el?.offsetParent !== null) {
      return (el.textContent ?? '').trim()
    }
  }
  return ''
}

function findThreadSendButton() {
  // El botón Enviar del thread editor — en el msg-form footer
  const formContainer = document.querySelector('.msg-form, [class*="msg-form"]')
  const root = formContainer ?? document
  const buttons = Array.from(root.querySelectorAll('button, [role="button"]'))
  return buttons.find(b => {
    if (b.offsetParent === null) return false
    const t = (b.textContent ?? '').trim().toLowerCase()
    const aria = (b.getAttribute('aria-label') ?? '').toLowerCase()
    return (
      t === 'enviar' || t === 'send' ||
      /^enviar mensaje|send message/i.test(aria) ||
      b.classList.contains('msg-form__send-button') ||
      b.getAttribute('data-control-name') === 'send'
    )
  })
}

async function verifyFollowupSent(message) {
  // El mensaje recién enviado debe aparecer al final del thread (msg-s-event-list)
  const messages = document.querySelectorAll('.msg-s-message-list__event, [class*="msg-s-event"]')
  const last = messages[messages.length - 1]
  if (!last) return false
  const snippet = message.slice(0, 50).toLowerCase()
  return (last.textContent ?? '').toLowerCase().includes(snippet)
}

// ── humanTypeContentEditable: para divs contenteditable (no textareas) ──
async function humanTypeContentEditable(el, text) {
  el.focus()
  // Posicionar caret al final
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)

  for (const ch of text) {
    // execCommand insertText es la forma estándar de inyectar en contenteditable
    // que Slack/LinkedIn/Discord aceptan + dispara los eventos React internos
    document.execCommand('insertText', false, ch)
    let delay = randInt(55, 130)
    if ('.?,!¡¿\n'.includes(ch)) delay += randInt(80, 200)
    if (Math.random() < 0.05) delay += randInt(300, 500)
    await sleep(delay)
  }
  // Trigger input event final para que React detecte el cambio
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

async function searchLeads(payload = {}) {
  const targetCount = Math.min(payload.targetCount ?? 25, 200)
  const maxPages = Math.min(payload.maxPages ?? 10, 20)
  const companyNames = Array.isArray(payload.companyNames)
    ? payload.companyNames.filter(Boolean).map(s => s.toLowerCase())
    : []

  console.log(`[Orion content] searchLeads target=${targetCount} maxPages=${maxPages} url=${location.href}`)

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

      // Post-filter: si companyNames está set, headline debe matchear
      if (companyNames.length > 0) {
        const h = (p.headline || '').toLowerCase()
        const matched = companyNames.some(c => h.includes(c))
        if (!matched) continue
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
  }
}

// Extrae profile cards del DOM en la página de search results.
// Port directo de search.js extractProfilesFromPage adaptado a content.js.
function extractProfilesFromPage() {
  const NOISE_RE = /^[•·]\s*\d|conectar|connect|mensaje|message|seguir|follow|pendiente/i
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

    const headline = paras.find(t => !/^[•·\-]\s/.test(t) && t.length > 5) || null
    const locationStr = paras.find(t =>
      t !== headline && (t.includes(',') || (t.length < 60 && t.length > 3))
    ) || null

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
async function goToNextSearchPage(nextPageNum) {
  // 1. Intentar click en botón "Siguiente"
  const nextSels = [
    'button[aria-label="Siguiente"]',
    'button[aria-label="Next"]',
    'button.artdeco-pagination__button--next',
  ]
  for (const sel of nextSels) {
    const btn = document.querySelector(sel)
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
      console.log(`[Orion content] Click Next button (${sel})`)
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' })
      await sleep(randInt(500, 1000))
      await humanClick(btn)
      // Esperar a que la URL cambie o results se re-render
      await sleep(randInt(3000, 5000))
      return true
    }
  }

  // 2. Fallback: navegar via URL param &page=N (LinkedIn lo soporta)
  const url = new URL(location.href)
  url.searchParams.set('page', String(nextPageNum))
  console.log(`[Orion content] Fallback: navegar a ${url.toString()}`)
  location.href = url.toString()
  // Después del navigation el content.js se reinyecta — el comando current finaliza aquí
  // El bridge tendrá que considerar paginación por URL como un solo-page scrape
  return false
}
