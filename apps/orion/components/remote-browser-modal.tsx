"use client"

import { useState, useEffect, useRef, useCallback } from "react"

type Phase =
  | "form"                     // collecting email + password (default)
  | "paste"                    // manual cookie paste mode (fast path)
  | "pasting"                  // validating + saving the pasted cookie
  | "starting"                 // spawning browser
  | "navigating"               // loading /login
  | "filling"                  // typing creds
  | "authenticating"           // waiting for LinkedIn response
  | "verifying_2fa"            // submitted 2FA, waiting for response
  | "awaiting_2fa"             // PIN-based 2FA — show 6-digit input
  | "awaiting_device_approval" // push 2FA — wait for user to tap "Yes" in mobile app
  | "google_streaming"         // Google OAuth — user interacts in streaming view
  | "validating"               // running cookie validation in clean context
  | "success"
  | "validation_failed"
  | "error"

// Browser viewport for streaming (matches cookie-server)
const BROWSER_W = 1280
const BROWSER_H = 800
const STREAM_W  = 720
const STREAM_H  = 450

interface SessionStatus {
  status?:  string
  error?:   string | null
  reason?:  string
}

interface Props {
  accountId:    string
  accountLabel: string
  onClose:      () => void
  onSuccess:    () => void
}

const PHASE_PROGRESS: Record<string, { label: string; pct: number }> = {
  starting:       { label: "Iniciando browser remoto…",       pct: 15 },
  navigating:     { label: "Conectando con LinkedIn…",        pct: 35 },
  filling:        { label: "Llenando credenciales…",          pct: 55 },
  authenticating: { label: "Autenticando…",                   pct: 75 },
  validating:     { label: "Validando sesión…",               pct: 92 },
  verifying_2fa:  { label: "Verificando código de seguridad…", pct: 80 },
  pasting:        { label: "Validando cookie pegada…",         pct: 70 },
}

const PASTE_ERROR_LABEL: Record<string, string> = {
  invalid_format:    "El valor pegado no parece una cookie válida.",
  validation_failed: "LinkedIn rechazó la cookie. Verifica que copiaste el valor completo.",
  redirect_loop:     "LinkedIn rechazó la cookie con redirect loop. Cópiala de nuevo.",
  not_authenticated: "La cookie no permite acceder al feed.",
  cookie_too_short:  "La cookie pegada está incompleta — copia el valor completo.",
  validator_error:   "Error técnico validando la cookie. Reintenta.",
}

const ERROR_LABEL: Record<string, string> = {
  bad_credentials:           "Email o contraseña incorrectos.",
  invalid_2fa_code:          "Código incorrecto. Intenta de nuevo.",
  device_approval_timeout:   "No detectamos la aprobación en tu dispositivo después de 5 minutos. Intenta de nuevo.",
  no_cookie_after_success: "Login exitoso pero no se capturó la cookie. Intenta de nuevo.",
  no_cookie_after_2fa:    "Login con 2FA exitoso pero no se capturó la cookie. Intenta de nuevo.",
  proxy_error:            "No se pudo conectar al proxy. Verifica las credenciales del proxy.",
  timeout:                "LinkedIn tardó demasiado en responder. Intenta de nuevo.",
  browser_disconnected:   "El browser remoto se cerró. Intenta de nuevo.",
  unknown_state:          "LinkedIn pidió verificación adicional (captcha o teléfono). Pídele a un admin que use el modo manual.",
  auth_failed:            "Falló la autenticación. Intenta de nuevo.",
}

const VALIDATION_REASON_LABEL: Record<string, string> = {
  cookie_too_short:  "La cookie capturada está incompleta.",
  redirect_loop:     "LinkedIn rechazó la cookie con redirect loop. Vuelve a intentar.",
  not_authenticated: "La cookie no permite acceder al feed.",
  validator_error:   "Error en el validador interno.",
}

export function RemoteBrowserModal({ accountId, accountLabel, onClose, onSuccess }: Props) {
  const [phase,     setPhase]     = useState<Phase>("form")
  const [email,     setEmail]     = useState("")
  const [password,  setPassword]  = useState("")
  const [twoFa,     setTwoFa]     = useState("")
  const [pasteValue, setPasteValue] = useState("")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [errorMsg,  setErrorMsg]  = useState<string | null>(null)
  const [frameTs,   setFrameTs]   = useState(0)  // forces img reload during streaming
  const sessionRef     = useRef<string | null>(null)
  const streamOverlay  = useRef<HTMLDivElement>(null)
  const typeBufferRef  = useRef<string>("")
  const typeTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Cleanup on unmount: kill the session server-side ────────────────────────
  useEffect(() => {
    const handler = () => {
      const sid = sessionRef.current
      if (!sid) return
      try {
        navigator.sendBeacon?.(`/api/accounts/${accountId}/login-session?sid=${sid}`,
          new Blob([], { type: "application/json" }))
      } catch {}
    }
    window.addEventListener("beforeunload", handler)
    return () => {
      window.removeEventListener("beforeunload", handler)
      const sid = sessionRef.current
      if (sid) {
        fetch(`/api/accounts/${accountId}/login-session?sid=${sid}`, { method: "DELETE" }).catch(() => {})
      }
    }
  }, [accountId])

  // ── Status polling — only after a session is started ────────────────────────
  useEffect(() => {
    if (!sessionId) return
    // Stop polling in terminal/input-required states. We DO keep polling during
    // awaiting_device_approval since the server detects approval automatically.
    if (["form", "success", "error", "validation_failed", "awaiting_2fa"].includes(phase)) return
    // For google_streaming and awaiting_device_approval we poll — server detects success

    let stopped = false
    const tick = async () => {
      if (stopped) return
      try {
        const res  = await fetch(`/api/accounts/${accountId}/login-session/status?sid=${sessionId}`)
        const data = await res.json() as SessionStatus

        switch (data.status) {
          case "navigating":
          case "filling":
          case "authenticating":
          case "verifying_2fa":
            setPhase(data.status as Phase)
            break
          case "awaiting_2fa":
            setPhase("awaiting_2fa")
            break
          case "awaiting_device_approval":
            setPhase("awaiting_device_approval")
            break
          case "cookie_pending":
            // From streaming flow: li_at appeared, awaiting stability window
            // Don't switch off google_streaming yet — keep showing the stream so the
            // user sees LinkedIn finishing its redirect.
            break
          case "cookie_stable":
            // cookie-server detected cookie; status route will trigger validation+save next tick
            setPhase("validating")
            break
          case "saved":
            setPhase("success")
            onSuccess()
            stopped = true
            return
          case "validation_failed":
            setPhase("validation_failed")
            setErrorMsg(VALIDATION_REASON_LABEL[data.reason ?? ""] ?? data.reason ?? "Validación falló")
            stopped = true
            return
          case "error":
            setPhase("error")
            setErrorMsg(ERROR_LABEL[data.error ?? ""] ?? data.error ?? "Error desconocido")
            stopped = true
            return
        }
      } catch {
        // Transient — keep polling
      }
    }

    tick()
    const id = setInterval(tick, 1_000)
    return () => { stopped = true; clearInterval(id) }
  }, [sessionId, phase, accountId, onSuccess])

  // ── Submit credentials ──────────────────────────────────────────────────────
  const handleSubmitCreds = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password.trim()) return

    setPhase("starting")
    try {
      const res = await fetch(`/api/accounts/${accountId}/auto-login`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ email: email.trim(), password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setPhase("error")
        setErrorMsg(ERROR_LABEL[data.error] ?? data.error ?? `HTTP ${res.status}`)
        return
      }
      setSessionId(data.sessionId)
      sessionRef.current = data.sessionId
      // Phase will advance via status polling once cookie-server starts driving the flow
    } catch (err: any) {
      setPhase("error")
      setErrorMsg(err.message)
    }
  }, [email, password, accountId])

  // ── Submit 2FA code ─────────────────────────────────────────────────────────
  const handleSubmit2FA = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!sessionId || !/^\d{4,8}$/.test(twoFa)) return
    setPhase("verifying_2fa")
    try {
      const res = await fetch(`/api/accounts/${accountId}/auto-login/2fa?sid=${sessionId}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ code: twoFa }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setPhase("error")
        setErrorMsg(data.error ?? "No se pudo enviar el código")
      }
    } catch (err: any) {
      setPhase("error")
      setErrorMsg(err.message)
    }
  }, [sessionId, twoFa, accountId])

  // ── Google OAuth: streaming-mode session with pre-clicked Google button ────
  const handleGoogleLogin = useCallback(async () => {
    setPhase("starting")
    try {
      const res = await fetch(`/api/accounts/${accountId}/login-session`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ flow: "google" }),
      })
      const data = await res.json()
      if (!res.ok) {
        setPhase("error")
        setErrorMsg(data.error ?? `HTTP ${res.status}`)
        return
      }
      setSessionId(data.sessionId)
      sessionRef.current = data.sessionId
      setPhase("google_streaming")
      setTimeout(() => streamOverlay.current?.focus(), 200)
    } catch (err: any) {
      setPhase("error")
      setErrorMsg(err.message)
    }
  }, [accountId])

  // ── Manual paste flow — fast path for users who can extract their cookie ──
  // Architecture note: this bypasses the remote browser entirely. The cookie
  // is validated server-side against the account's proxy+fingerprint, so the
  // session is still bound to the right egress IP at write time. After the
  // first request from a worker (also via the proxy), LinkedIn re-anchors the
  // session to that proxy IP and the original capture IP becomes irrelevant.
  const handlePasteSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const v = pasteValue.trim()
    if (!v) return
    setPhase("pasting")
    setErrorMsg(null)
    try {
      const res = await fetch(`/api/accounts/${accountId}/cookie/paste`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ li_at: v }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setPhase("success")
        onSuccess()
        return
      }
      const reasonKey = data.reason ?? data.error ?? "validator_error"
      setPhase("validation_failed")
      setErrorMsg(PASTE_ERROR_LABEL[reasonKey] ?? data.error ?? "Error validando")
    } catch (err: any) {
      setPhase("error")
      setErrorMsg(err.message ?? "Error de red")
    }
  }, [pasteValue, accountId, onSuccess])

  // ── Streaming: frame refresh ────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "google_streaming") return
    const id = setInterval(() => setFrameTs(Date.now()), 150)
    return () => clearInterval(id)
  }, [phase])

  // ── Streaming: input forwarding ─────────────────────────────────────────────
  const sendInput = useCallback((body: object) => {
    if (!sessionId) return
    void fetch(`/api/accounts/${accountId}/login-session/input?sid=${sessionId}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      keepalive: true,
    }).catch(() => {})
  }, [sessionId, accountId])

  const flushTypeBuffer = useCallback(() => {
    if (typeTimerRef.current) {
      clearTimeout(typeTimerRef.current)
      typeTimerRef.current = null
    }
    const text = typeBufferRef.current
    if (!text) return
    typeBufferRef.current = ""
    sendInput({ type: "type", text })
  }, [sendInput])

  const handleStreamClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!sessionId) return
    flushTypeBuffer()
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.round((e.clientX - rect.left) * (BROWSER_W / STREAM_W))
    const y = Math.round((e.clientY - rect.top)  * (BROWSER_H / STREAM_H))
    sendInput({ type: "click", x, y })
    streamOverlay.current?.focus()
  }, [sessionId, sendInput, flushTypeBuffer])

  const handleStreamKey = useCallback((e: React.KeyboardEvent) => {
    if (!sessionId) return
    e.preventDefault()
    const specialKeys = ["Enter", "Tab", "Backspace", "Delete", "Escape",
      "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]
    if (specialKeys.includes(e.key)) {
      flushTypeBuffer()
      sendInput({ type: "key", key: e.key })
    } else if (e.key.length === 1) {
      typeBufferRef.current += e.key
      if (typeTimerRef.current) clearTimeout(typeTimerRef.current)
      typeTimerRef.current = setTimeout(flushTypeBuffer, 80)
    }
  }, [sessionId, sendInput, flushTypeBuffer])

  const reset = useCallback(() => {
    setPhase("form")
    setSessionId(null)
    sessionRef.current = null
    setErrorMsg(null)
    setTwoFa("")
    setPasteValue("")
  }, [])

  const progress = PHASE_PROGRESS[phase]

  // LinkedIn blue: #0a66c2 (primary), #004182 (hover)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-gray-950 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header — LinkedIn-style: logomark + label */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 bg-gray-900/50">
          <div className="flex items-center gap-3">
            <LinkedInLogo />
            <div>
              <p className="text-sm font-semibold text-gray-100">Inicia sesión</p>
              <p className="text-xs text-gray-500">Cuenta: <span className="text-[#70b5f9]">{accountLabel}</span></p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-full text-gray-500 hover:text-gray-200 hover:bg-gray-800 text-lg leading-none"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>

        <div className="p-6 min-h-[280px] flex flex-col justify-center">
          {/* ── Form: LinkedIn-style ─────────────────────────────────── */}
          {phase === "form" && (
            <form onSubmit={handleSubmitCreds} className="space-y-4">
              <label className="block">
                <span className="block text-xs text-gray-300 mb-1.5 font-medium">Correo electrónico</span>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoFocus
                  className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-md text-gray-50 text-sm focus:outline-none focus:border-[#70b5f9] focus:ring-1 focus:ring-[#70b5f9] transition-colors"
                />
              </label>
              <label className="block">
                <span className="block text-xs text-gray-300 mb-1.5 font-medium">Contraseña</span>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-md text-gray-50 text-sm focus:outline-none focus:border-[#70b5f9] focus:ring-1 focus:ring-[#70b5f9] transition-colors"
                />
              </label>
              <button
                type="submit"
                className="w-full py-2.5 bg-[#0a66c2] hover:bg-[#004182] text-white text-sm font-semibold rounded-full transition-colors"
              >
                Iniciar sesión
              </button>

              {/* Divider */}
              <div className="relative py-1">
                <div className="absolute inset-x-0 top-1/2 h-px bg-gray-800" />
                <span className="relative bg-gray-950 px-3 text-xs text-gray-500 left-1/2 -translate-x-1/2 inline-block">o</span>
              </div>

              {/* Google login button — triggers streaming flow */}
              <button
                type="button"
                onClick={handleGoogleLogin}
                className="w-full py-2.5 bg-transparent hover:bg-gray-900 border border-gray-700 hover:border-gray-600 text-gray-100 text-sm font-medium rounded-full transition-colors flex items-center justify-center gap-2.5"
              >
                <GoogleLogo />
                Continuar con Google
              </button>

              <div className="pt-2 space-y-1.5 border-t border-gray-800/60">
                <p className="text-xs text-gray-500 text-center pt-3">
                  🔒 Tus credenciales solo se usan en este login y nunca se almacenan.
                </p>
                <p className="text-[10px] text-gray-600 text-center leading-relaxed px-2">
                  El servidor inicia sesión por ti usando el proxy de tu cuenta para que LinkedIn
                  emita la cookie ligada a la IP correcta.
                </p>
              </div>

              {/* Fast-path: paste cookie manually */}
              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={() => { setErrorMsg(null); setPhase("paste") }}
                  className="text-xs text-[#70b5f9] hover:text-[#9dcaff] hover:underline transition-colors"
                >
                  ⚡ Ya tengo la cookie — pegarla directamente
                </button>
              </div>
            </form>
          )}

          {/* ── Manual paste view ───────────────────────────────────── */}
          {phase === "paste" && (
            <form onSubmit={handlePasteSubmit} className="space-y-4">
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-gray-100">⚡ Pegar cookie</h3>
                <p className="text-xs text-gray-400 leading-relaxed">
                  Si ya estás logueado en LinkedIn en tu browser, este es el camino más rápido.
                </p>
              </div>

              <details className="bg-gray-900/60 border border-gray-800 rounded-md text-xs">
                <summary className="cursor-pointer px-3 py-2 text-gray-300 hover:text-gray-100 font-medium">
                  ¿Cómo encuentro mi cookie <code className="bg-gray-800 px-1 rounded">li_at</code>?
                </summary>
                <ol className="px-3 pb-3 pt-1 space-y-1 text-gray-400 list-decimal list-inside leading-relaxed">
                  <li>Abre <code className="bg-gray-800 px-1 rounded">linkedin.com</code> en tu browser (logueado).</li>
                  <li>Presiona <kbd className="bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">F12</kbd> → tab <strong>Application</strong>.</li>
                  <li>En la izquierda: <strong>Cookies</strong> → <strong>linkedin.com</strong>.</li>
                  <li>Busca la fila <code className="bg-gray-800 px-1 rounded">li_at</code>, doble-click en <strong>Value</strong>, copia.</li>
                  <li>Pégalo abajo. Empieza con <code className="bg-gray-800 px-1 rounded">AQED</code>.</li>
                </ol>
              </details>

              <label className="block">
                <span className="block text-xs text-gray-300 mb-1.5 font-medium">Valor de la cookie</span>
                <textarea
                  value={pasteValue}
                  onChange={e => setPasteValue(e.target.value)}
                  required
                  rows={4}
                  autoFocus
                  spellCheck={false}
                  placeholder="AQEDARxtQb8De-KDAAABnidItHgAAA..."
                  className="w-full px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-md text-gray-50 text-xs font-mono break-all focus:outline-none focus:border-[#70b5f9] focus:ring-1 focus:ring-[#70b5f9] transition-colors resize-none"
                />
                <span className="block mt-1 text-[10px] text-gray-600">
                  Acepta el valor crudo o el formato <code className="bg-gray-800 px-1 rounded">li_at=...</code>
                </span>
              </label>

              <button
                type="submit"
                disabled={!pasteValue.trim()}
                className="w-full py-2.5 bg-[#0a66c2] hover:bg-[#004182] disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-full transition-colors"
              >
                Validar y guardar
              </button>

              <button
                type="button"
                onClick={() => { setPasteValue(""); setPhase("form") }}
                className="w-full text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                ← Volver al login con credenciales
              </button>

              <div className="pt-2 border-t border-gray-800/60">
                <p className="text-[10px] text-gray-600 text-center leading-relaxed px-2">
                  La cookie se valida pasando por el proxy de <span className="text-[#70b5f9]">{accountLabel}</span>.
                  Si LinkedIn la acepta ahí, queda guardada y el bot la usa.
                </p>
              </div>
            </form>
          )}

          {/* ── Google streaming: user interacts with Google's login page ────── */}
          {phase === "google_streaming" && sessionId && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-3 py-2 bg-blue-500/10 border border-blue-500/30 rounded-lg">
                <GoogleLogo />
                <p className="text-xs text-gray-300">
                  Inicia sesión con Google. Detectaremos cuando LinkedIn te emita la cookie.
                </p>
              </div>
              <div
                className="relative bg-gray-900 rounded-lg overflow-hidden mx-auto"
                style={{ width: STREAM_W, height: STREAM_H }}
              >
                <img
                  src={`/api/accounts/${accountId}/login-session/frame?sid=${sessionId}&t=${frameTs}`}
                  alt="Google login"
                  className="absolute inset-0 w-full h-full object-fill select-none pointer-events-none"
                  draggable={false}
                />
                <div
                  ref={streamOverlay}
                  tabIndex={0}
                  className="absolute inset-0 cursor-pointer outline-none"
                  onClick={handleStreamClick}
                  onKeyDown={handleStreamKey}
                />
              </div>
              <div className="flex items-center justify-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                <span className="text-[10px] text-gray-600">Live · proxy de {accountLabel}</span>
              </div>
            </div>
          )}

          {/* ── Loading states with spinner + progress ─────────────── */}
          {progress && (
            <div className="text-center space-y-5">
              <Spinner />
              <div>
                <p className="text-gray-100 text-sm font-medium">{progress.label}</p>
                <p className="text-gray-500 text-xs mt-1">No cierres esta ventana</p>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-1.5 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-blue-500 to-blue-400 transition-all duration-500 ease-out"
                  style={{ width: `${progress.pct}%` }}
                />
              </div>
            </div>
          )}

          {/* ── Device approval (push 2FA) ─────────────────────────── */}
          {phase === "awaiting_device_approval" && (
            <div className="text-center space-y-5">
              <div className="relative w-16 h-16 mx-auto">
                <div className="absolute inset-0 rounded-full bg-blue-500/10 animate-ping" />
                <div className="absolute inset-0 flex items-center justify-center text-4xl">📱</div>
              </div>
              <div className="space-y-1">
                <p className="text-gray-100 font-semibold text-sm">Aprueba en tu dispositivo</p>
                <p className="text-gray-400 text-xs leading-relaxed px-4">
                  LinkedIn envió una notificación a tu app móvil. Toca <span className="text-[#70b5f9] font-medium">"Sí, soy yo"</span> para continuar.
                </p>
              </div>
              <div className="flex items-center justify-center gap-2 text-xs text-gray-500">
                <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                <span>Esperando aprobación…</span>
              </div>
              <p className="text-[10px] text-gray-600 px-4">
                Detectaremos automáticamente la cookie cuando apruebes — no cierres esta ventana.
              </p>
            </div>
          )}

          {/* ── 2FA prompt ─────────────────────────────────────────── */}
          {phase === "awaiting_2fa" && (
            <form onSubmit={handleSubmit2FA} className="space-y-3 text-center">
              <p className="text-2xl">🔐</p>
              <div>
                <p className="text-gray-100 font-semibold text-sm">Verificación en dos pasos</p>
                <p className="text-gray-500 text-xs mt-1">
                  LinkedIn envió un código a tu email/SMS/app autenticadora. Ingrésalo aquí:
                </p>
              </div>
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{4,8}"
                maxLength={8}
                value={twoFa}
                onChange={e => setTwoFa(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
                autoFocus
                className="w-full text-center px-3 py-3 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 text-2xl font-mono tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="submit"
                disabled={!/^\d{4,8}$/.test(twoFa)}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors"
              >
                Verificar
              </button>
            </form>
          )}

          {/* ── Success ─────────────────────────────────────────────── */}
          {phase === "success" && (
            <div className="text-center space-y-3">
              <p className="text-5xl">✅</p>
              <p className="text-green-400 font-semibold">Cookie capturada y validada</p>
              <p className="text-gray-400 text-sm">Cuenta reactivada — automatización lista</p>
              <button
                onClick={onClose}
                className="mt-2 px-5 py-2 bg-green-600 hover:bg-green-500 rounded-lg text-sm text-white font-medium"
              >
                Cerrar
              </button>
            </div>
          )}

          {/* ── Validation failed (recoverable) ─────────────────────── */}
          {phase === "validation_failed" && (
            <div className="text-center space-y-3">
              <p className="text-3xl">🔁</p>
              <p className="text-yellow-400 font-semibold text-sm">La cookie no es estable</p>
              <p className="text-gray-400 text-xs">{errorMsg}</p>
              <button onClick={reset} className="mt-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm text-white">
                Volver a intentar
              </button>
            </div>
          )}

          {/* ── Error ───────────────────────────────────────────────── */}
          {phase === "error" && (
            <div className="text-center space-y-3">
              <p className="text-3xl">⚠️</p>
              <p className="text-red-400 font-semibold text-sm">Error</p>
              <p className="text-gray-400 text-xs">{errorMsg}</p>
              <button onClick={reset} className="mt-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm text-white">
                Volver a intentar
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <div className="relative w-14 h-14 mx-auto">
      <div className="absolute inset-0 border-[3px] border-gray-800 rounded-full" />
      <div className="absolute inset-0 border-[3px] border-[#0a66c2] border-t-transparent border-r-transparent rounded-full animate-spin" />
    </div>
  )
}

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-label="Google">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.79 2.72v2.26h2.9c1.7-1.57 2.69-3.88 2.69-6.62Z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.81.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18Z"/>
      <path fill="#FBBC05" d="M3.95 10.7a5.4 5.4 0 0 1 0-3.4V4.97H.96a9 9 0 0 0 0 8.07l3-2.34Z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.45 1.35l2.58-2.58A8.99 8.99 0 0 0 .96 4.97l3 2.33C4.66 5.17 6.65 3.58 9 3.58Z"/>
    </svg>
  )
}

function LinkedInLogo() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" fill="none" aria-label="LinkedIn">
      <rect width="32" height="32" rx="4" fill="#0a66c2" />
      <path
        fill="white"
        d="M11.05 13.6h-3v9.7h3V13.6Zm-1.5-4.3a1.74 1.74 0 1 0 0 3.48 1.74 1.74 0 0 0 0-3.48ZM23.3 18.36c0-2.78-1.46-4.07-3.42-4.07a2.95 2.95 0 0 0-2.65 1.46v-1.15h-3v9.7h3v-5.13c0-1.36.26-2.68 1.95-2.68 1.66 0 1.7 1.55 1.7 2.77v5.04h2.42v-5.94Z"
      />
    </svg>
  )
}
