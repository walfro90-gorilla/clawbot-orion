"use client"

import { useRouter } from "next/navigation"
import { useEffect, useRef, useState, useTransition } from "react"

/**
 * Auto-refresca un server component (router.refresh re-fetchea los datos) cada
 * `intervalMs`. Toggleable. Indicador "en vivo" con cuenta regresiva al próximo
 * refresh. Hace que el dashboard sea la fuente de verdad en tiempo real.
 */
export function AutoRefresh({ intervalMs = 15000, label = "En vivo" }: { intervalMs?: number; label?: string }) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [on, setOn] = useState(true)
  const [secs, setSecs] = useState(Math.round(intervalMs / 1000))
  const tick = useRef(Math.round(intervalMs / 1000))

  useEffect(() => {
    if (!on) return
    tick.current = Math.round(intervalMs / 1000)
    setSecs(tick.current)
    const id = setInterval(() => {
      // (06-jul-2026) Egress: si la pestaña está en BACKGROUND, no cuentes ni refresques →
      // cero fetches en pestañas olvidadas abiertas (el mayor drenaje de egress del Free tier).
      if (typeof document !== "undefined" && document.hidden) return
      tick.current -= 1
      if (tick.current <= 0) {
        startTransition(() => router.refresh())
        tick.current = Math.round(intervalMs / 1000)
      }
      setSecs(tick.current)
    }, 1000)
    // Al volver a foco: un refresh inmediato + reinicia la cuenta (datos frescos al regresar).
    const onVis = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        startTransition(() => router.refresh())
        tick.current = Math.round(intervalMs / 1000)
        setSecs(tick.current)
      }
    }
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis)
    return () => {
      clearInterval(id)
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis)
    }
  }, [on, intervalMs, router])

  return (
    <button
      onClick={() => setOn((v) => !v)}
      title={on ? "Pausar auto-actualización" : "Reanudar auto-actualización en tiempo real"}
      className={`inline-flex items-center gap-2 px-3 py-2 rounded-xl border text-sm font-medium transition-all ${
        on
          ? "bg-green-500/10 border-green-500/30 text-green-400 hover:bg-green-500/20"
          : "bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200"
      }`}
    >
      <span className={`w-2 h-2 rounded-full ${on ? "bg-green-400 animate-pulse" : "bg-gray-500"}`} />
      {on ? `${label} · ${secs}s` : "Pausado"}
    </button>
  )
}
