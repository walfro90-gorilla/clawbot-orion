"use client"

import { useState, useEffect, useCallback } from "react"

interface Account {
  id: string
  label: string | null
  last_inbox_check_at: string | null
}

interface Props {
  accounts: Account[]
}

function minutesAgo(iso: string | null): number | null {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
}

function formatAgo(iso: string | null): string {
  const min = minutesAgo(iso)
  if (min === null) return "Nunca"
  if (min < 1)  return "hace menos de 1 min"
  if (min < 60) return `hace ${min} min`
  const h = Math.floor(min / 60)
  return `hace ${h}h ${min % 60}min`
}

const COOLDOWN_MIN = 30 // minutos mínimos entre runs

export function RefreshInboxBtn({ accounts }: Props) {
  const [states, setStates] = useState<Record<string, "idle" | "running" | "done" | "cooldown">>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [countdowns, setCountdowns] = useState<Record<string, number>>({})  // segundos restantes para auto-refresh
  const [lastCheck, setLastCheck] = useState<Record<string, string | null>>(
    Object.fromEntries(accounts.map(a => [a.id, a.last_inbox_check_at]))
  )

  // Tick countdown and auto-refresh page when done
  useEffect(() => {
    const interval = setInterval(() => {
      setCountdowns(prev => {
        const next = { ...prev }
        let changed = false
        for (const [id, secs] of Object.entries(next)) {
          if (secs > 0) {
            next[id] = secs - 1
            changed = true
          } else if (secs === 0 && states[id] === "running") {
            // Done — refresh page to show new conversations
            window.location.reload()
          }
        }
        return changed ? next : prev
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [states])

  const trigger = useCallback(async (accountId: string, label: string) => {
    setStates(p => ({ ...p, [accountId]: "running" }))
    setErrors(p => ({ ...p, [accountId]: "" }))

    try {
      const res = await fetch("/api/run-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobType: "inbox", accountId }),
      })
      const data = await res.json()

      if (!res.ok) {
        setStates(p => ({ ...p, [accountId]: "cooldown" }))
        setErrors(p => ({ ...p, [accountId]: data.error ?? "Error al iniciar inbox" }))
        return
      }

      // Started — show countdown and auto-refresh after ~2 min
      const estimatedSecs = data.estimatedSeconds ?? 120
      setCountdowns(p => ({ ...p, [accountId]: estimatedSecs }))
      setLastCheck(p => ({ ...p, [accountId]: new Date().toISOString() }))
    } catch {
      setStates(p => ({ ...p, [accountId]: "idle" }))
      setErrors(p => ({ ...p, [accountId]: "Error de red" }))
    }
  }, [])

  if (accounts.length === 0) return null

  return (
    <div className="flex flex-wrap gap-3">
      {accounts.map(a => {
        const state     = states[a.id] ?? "idle"
        const err       = errors[a.id]
        const secs      = countdowns[a.id] ?? 0
        const ago       = minutesAgo(lastCheck[a.id])
        const inCooldown = ago !== null && ago < COOLDOWN_MIN && state !== "running"
        const pct       = state === "running" && secs > 0
          ? Math.round(((120 - secs) / 120) * 100)
          : 0

        return (
          <div key={a.id} className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex items-center gap-4 min-w-[280px]">
            <div className="flex-1 min-w-0">
              <p className="text-gray-50 text-sm font-medium">{a.label ?? "Cuenta LinkedIn"}</p>
              <p className="text-gray-500 text-xs mt-0.5">
                Última revisión: <span className="text-gray-400">{formatAgo(lastCheck[a.id])}</span>
              </p>
              {state === "running" && secs > 0 && (
                <div className="mt-1.5">
                  <div className="w-full bg-gray-800 rounded-full h-1">
                    <div
                      className="bg-blue-500 h-1 rounded-full transition-all duration-1000"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="text-blue-400 text-xs mt-1">
                    Revisando inbox… recargando en {secs}s
                  </p>
                </div>
              )}
              {err && <p className="text-yellow-400 text-xs mt-1">{err}</p>}
              {inCooldown && !err && (
                <p className="text-gray-600 text-xs mt-0.5">
                  Disponible en ~{COOLDOWN_MIN - (ago ?? 0)} min
                </p>
              )}
            </div>
            <button
              onClick={() => trigger(a.id, a.label ?? "cuenta")}
              disabled={state === "running" || inCooldown}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 ${
                state === "running"
                  ? "bg-blue-600/30 text-blue-400 cursor-wait"
                  : inCooldown
                  ? "bg-gray-800 text-gray-600 cursor-not-allowed"
                  : "bg-blue-600 hover:bg-blue-500 text-white  cursor-pointer"
              }`}
            >
              {state === "running" ? (
                <>
                  <span className="animate-spin">⟳</span> Revisando…
                </>
              ) : inCooldown ? (
                <>⏳ Cooldown</>
              ) : (
                <>⟳ Actualizar</>
              )}
            </button>
          </div>
        )
      })}
    </div>
  )
}
