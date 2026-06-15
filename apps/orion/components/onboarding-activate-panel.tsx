"use client"

import { useState, useEffect, useCallback } from "react"

// Panel de activación de onboarding. Polla el checklist en vivo (GET) y permite activar
// (POST) solo cuando TODO está verde. Se muestra en la card de cuentas que aún no están
// activas (onboarding en progreso). Una vez activa, muestra el estado final.
type Checklist = Record<string, boolean>

export function OnboardingActivatePanel({ accountId, redirectTo }: { accountId: string; redirectTo?: string }) {
  const [state, setState]       = useState<any>(null)
  const [activating, setActive] = useState(false)
  const [msg, setMsg]           = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/onboarding/activate?accountId=${accountId}`, { cache: "no-store" })
      if (r.ok) setState(await r.json())
    } catch {}
  }, [accountId])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 6000)
    return () => clearInterval(t)
  }, [refresh])

  async function activate() {
    setActive(true); setMsg(null)
    try {
      const r = await fetch("/api/onboarding/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      })
      const j = await r.json()
      if (r.ok && j.ok) {
        setMsg("✅ Cuenta activada — el scheduler la procesará en el próximo tick.")
        if (redirectTo) { window.location.href = redirectTo; return }
      } else {
        setMsg("⚠️ " + (j.missing ? "Falta: " + j.missing.join(", ") : j.error ?? "No se pudo activar"))
      }
      await refresh()
    } catch (e: any) {
      setMsg("Error: " + (e?.message ?? "desconocido"))
    }
    setActive(false)
  }

  if (!state) return null

  // Estado final
  if (state.status === "active" && state.campaignActive) {
    return (
      <div className="mt-3 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-300">
        ✅ Onboarding completo — cuenta activa y campaña corriendo.
      </div>
    )
  }

  const cl: Checklist = state.checklist ?? {}
  const labels: Record<string, string> = state.labels ?? {}

  return (
    <div className="mt-3 rounded-xl border border-blue-500/30 bg-blue-500/5 p-3 space-y-2">
      <div className="flex items-center gap-1.5">
        <span>🚀</span>
        <h4 className="text-xs font-semibold text-gray-100">Activación de onboarding</h4>
      </div>
      <ul className="space-y-1">
        {Object.keys(labels).map(k => (
          <li key={k} className={`text-xs flex items-center gap-2 ${cl[k] ? "text-green-300" : "text-gray-400"}`}>
            <span>{cl[k] ? "✅" : "⬜"}</span> {labels[k]}
          </li>
        ))}
      </ul>
      <button
        onClick={activate}
        disabled={!state.ready || activating}
        className={`w-full py-2 text-xs font-semibold rounded-lg transition-colors ${
          state.ready && !activating
            ? "bg-green-600 hover:bg-green-500 text-white"
            : "bg-gray-700 text-gray-500 cursor-not-allowed"
        }`}>
        {activating ? "Activando…" : state.ready ? "Activar cuenta" : "Completa el checklist para activar"}
      </button>
      {msg && <p className="text-xs text-gray-300">{msg}</p>}
    </div>
  )
}
