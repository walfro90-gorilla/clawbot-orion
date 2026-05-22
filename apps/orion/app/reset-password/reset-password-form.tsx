"use client"

import { useState } from "react"

interface Props {
  action: (formData: FormData) => Promise<void>
  errorMessage?: string
}

export function ResetPasswordForm({ action, errorMessage }: Props) {
  const [showPwd,    setShowPwd]    = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [password,   setPassword]   = useState("")
  const [confirm,    setConfirm]    = useState("")
  const [pending,    setPending]    = useState(false)

  // Live validation
  const tooShort     = password.length > 0 && password.length < 8
  const noMatch      = confirm.length   > 0 && password !== confirm
  const valid        = password.length >= 8 && password === confirm

  // Password strength (rough heuristic — visual only)
  const strength = (() => {
    if (password.length === 0) return null
    let s = 0
    if (password.length >= 8)  s++
    if (password.length >= 12) s++
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) s++
    if (/\d/.test(password)) s++
    if (/[^A-Za-z0-9]/.test(password)) s++
    return s
  })()
  const strengthLabel = strength === null ? "" :
    strength <= 2 ? "Débil" :
    strength <= 3 ? "Aceptable" :
    strength <= 4 ? "Fuerte" : "Excelente"
  const strengthColor = strength === null ? "bg-gray-700" :
    strength <= 2 ? "bg-red-500" :
    strength <= 3 ? "bg-yellow-500" :
    strength <= 4 ? "bg-blue-500" : "bg-green-500"

  return (
    <form
      action={action}
      onSubmit={() => setPending(true)}
      className="space-y-4"
    >
      {errorMessage && (
        <div className="flex items-start gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-300">
          <span className="shrink-0 mt-0.5">⚠️</span>
          <span>{errorMessage}</span>
        </div>
      )}

      {/* New password */}
      <div className="space-y-1.5">
        <label htmlFor="password" className="block text-xs font-medium text-gray-400">
          Nueva contraseña
        </label>
        <div className="relative">
          <input
            id="password"
            name="password"
            type={showPwd ? "text" : "password"}
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            autoFocus
            className="w-full px-3 py-2.5 pr-10 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors"
            placeholder="Mínimo 8 caracteres"
          />
          <EyeButton onClick={() => setShowPwd(!showPwd)} visible={showPwd} />
        </div>
        {strength !== null && (
          <div className="flex items-center gap-2 mt-1.5">
            <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-1 rounded-full transition-all ${strengthColor}`}
                style={{ width: `${Math.min(100, (strength / 5) * 100)}%` }}
              />
            </div>
            <span className="text-[10px] text-gray-500">{strengthLabel}</span>
          </div>
        )}
        {tooShort && (
          <p className="text-[10px] text-red-400 mt-1">Mínimo 8 caracteres</p>
        )}
      </div>

      {/* Confirm */}
      <div className="space-y-1.5">
        <label htmlFor="confirm" className="block text-xs font-medium text-gray-400">
          Confirmar contraseña
        </label>
        <div className="relative">
          <input
            id="confirm"
            name="confirm"
            type={showConfirm ? "text" : "password"}
            required
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            className={`w-full px-3 py-2.5 pr-10 bg-gray-800 border rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:border-transparent transition-colors ${
              noMatch ? "border-red-500/50 focus:ring-red-500" : "border-gray-700 focus:ring-blue-500"
            }`}
            placeholder="Repite la contraseña"
          />
          <EyeButton onClick={() => setShowConfirm(!showConfirm)} visible={showConfirm} />
        </div>
        {noMatch && (
          <p className="text-[10px] text-red-400 mt-1">Las contraseñas no coinciden</p>
        )}
      </div>

      <button
        type="submit"
        disabled={!valid || pending}
        className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors text-sm flex items-center justify-center gap-2"
      >
        {pending ? (
          <>
            <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
            Actualizando…
          </>
        ) : (
          <>Actualizar contraseña</>
        )}
      </button>
    </form>
  )
}

function EyeButton({ onClick, visible }: { onClick: () => void; visible: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      tabIndex={-1}
      aria-label={visible ? "Ocultar contraseña" : "Mostrar contraseña"}
      className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-gray-500 hover:text-gray-300 transition-colors"
    >
      {visible ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
          <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
          <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
          <line x1="2" y1="2" x2="22" y2="22" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )}
    </button>
  )
}
