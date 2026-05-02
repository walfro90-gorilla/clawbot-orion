"use client"

import { useState } from "react"
import Link from "next/link"

export interface AccountAlert {
  id: number
  alert_type: string
  severity: string
  message: string
  details: Record<string, unknown> | null
  auto_paused: boolean
  created_at: string
  linkedin_account_id: string | null
  campaign_id: string | null
}

interface AlertBannerProps {
  initialAlerts: AccountAlert[]
}

const SEVERITY_STYLES: Record<string, { bar: string; icon: string; badge: string; dismiss: string }> = {
  critical: {
    bar:     "bg-red-950/80 border-red-500/50",
    icon:    "text-red-400",
    badge:   "bg-red-500/20 text-red-300 border-red-500/40",
    dismiss: "text-red-400 hover:text-red-200 hover:bg-red-500/20",
  },
  warning: {
    bar:     "bg-yellow-950/80 border-yellow-500/40",
    icon:    "text-yellow-400",
    badge:   "bg-yellow-500/20 text-yellow-300 border-yellow-500/40",
    dismiss: "text-yellow-400 hover:text-yellow-200 hover:bg-yellow-500/20",
  },
  info: {
    bar:     "bg-blue-950/80 border-blue-500/30",
    icon:    "text-blue-400",
    badge:   "bg-blue-500/20 text-blue-300 border-blue-500/30",
    dismiss: "text-blue-400 hover:text-blue-200 hover:bg-blue-500/20",
  },
}

const TYPE_ICON: Record<string, string> = {
  captcha:      "🤖",
  rate_limited: "⚠️",
  banned:       "🚫",
  cookie_expiry:"🔑",
  error_spike:  "💥",
}

const TYPE_LABEL: Record<string, string> = {
  captcha:      "Captcha detectado",
  rate_limited: "Rate limit / Authwall",
  banned:       "Cuenta baneada",
  cookie_expiry:"Cookie expirada",
  error_spike:  "Error en automatización",
}

async function resolveAlert(id: number) {
  return fetch("/api/alerts", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ alertId: id }),
  })
}

// ── Emergency banner for critical cookie_expiry ───────────────────────────────
function CookieEmergencyBanner({ alerts, onResolve }: {
  alerts: AccountAlert[]
  onResolve: (id: number) => void
}) {
  const [resolving, setResolving] = useState<Set<number>>(new Set())

  async function handleResolve(id: number) {
    setResolving(p => new Set([...p, id]))
    const res = await resolveAlert(id)
    if (res.ok) onResolve(id)
    setResolving(p => { const s = new Set(p); s.delete(id); return s })
  }

  return (
    <div className="space-y-0.5">
      {alerts.map(alert => {
        const accountLabel = (alert.details?.account_label as string) ?? "LinkedIn"
        const daysOld      = alert.details?.days_old as number | undefined

        return (
          <div key={alert.id}
            className="relative flex items-center gap-4 px-5 py-3.5 bg-gradient-to-r from-red-950 via-red-900/90 to-red-950 border-b-2 border-red-500/60 shadow-lg shadow-red-900/30"
            style={{ animation: "cookiePulse 2.5s ease-in-out infinite" }}
          >
            {/* Animated left glow bar */}
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-red-500 animate-pulse" />

            {/* Icon */}
            <span className="text-2xl shrink-0 animate-bounce" style={{ animationDuration: "1.5s" }}>🔑</span>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-black uppercase tracking-wider text-red-300 bg-red-500/20 px-2 py-0.5 rounded-full border border-red-500/50">
                  ⚡ ACCIÓN URGENTE
                </span>
                <span className="text-xs text-red-400 font-medium">
                  Cuenta: <strong className="text-red-200">{accountLabel}</strong>
                  {daysOld !== undefined && ` · ${daysOld} días sin renovar`}
                </span>
              </div>
              <p className="text-red-100 text-sm font-semibold mt-0.5">
                Cookie de LinkedIn inválida — la automatización está detenida para esta cuenta.
              </p>
              <p className="text-red-300/80 text-xs mt-0.5">
                Sin cookie válida, no se envían invitaciones, seguimientos ni se revisa la bandeja. Renuévala en menos de 5 minutos.
              </p>
            </div>

            {/* CTA */}
            <div className="flex items-center gap-2 shrink-0">
              <Link
                href="/dashboard/accounts"
                className="flex items-center gap-1.5 bg-red-500 hover:bg-red-400 text-white text-xs font-bold px-4 py-2 rounded-lg transition-colors shadow-md shadow-red-900/50 whitespace-nowrap"
              >
                🔄 Renovar ahora
              </Link>
              <button
                onClick={() => handleResolve(alert.id)}
                disabled={resolving.has(alert.id)}
                title="Marcar como resuelto"
                className="text-red-400/60 hover:text-red-200 hover:bg-red-500/20 p-1.5 rounded-lg transition-colors text-xs disabled:opacity-40"
              >
                {resolving.has(alert.id) ? "..." : "✓"}
              </button>
            </div>
          </div>
        )
      })}
      <style>{`
        @keyframes cookiePulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.15); }
          50%       { box-shadow: 0 0 20px 4px rgba(239,68,68,0.25); }
        }
      `}</style>
    </div>
  )
}

// ── Main AlertBanner ──────────────────────────────────────────────────────────
export function AlertBanner({ initialAlerts }: AlertBannerProps) {
  const [alerts, setAlerts] = useState<AccountAlert[]>(initialAlerts)
  const [dismissing, setDismissing] = useState<Set<number>>(new Set())

  function removeAlert(id: number) {
    setAlerts(prev => prev.filter(a => a.id !== id))
  }

  async function dismiss(id: number) {
    setDismissing(prev => new Set([...prev, id]))
    try {
      const res = await resolveAlert(id)
      if (res.ok) removeAlert(id)
    } finally {
      setDismissing(prev => { const s = new Set(prev); s.delete(id); return s })
    }
  }

  if (alerts.length === 0) return null

  // Separate emergency (critical cookie_expiry) from normal alerts
  const emergencyAlerts = alerts.filter(a =>
    a.alert_type === "cookie_expiry" && a.severity === "critical"
  )
  const normalAlerts = alerts.filter(a =>
    !(a.alert_type === "cookie_expiry" && a.severity === "critical")
  )

  const sortedNormal = [...normalAlerts].sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 }
    const so = (order[a.severity as keyof typeof order] ?? 9) - (order[b.severity as keyof typeof order] ?? 9)
    return so !== 0 ? so : new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })

  return (
    <div>
      {/* Emergency cookie banner — full width, pulsing, above everything */}
      {emergencyAlerts.length > 0 && (
        <CookieEmergencyBanner alerts={emergencyAlerts} onResolve={removeAlert} />
      )}

      {/* Normal alerts */}
      {sortedNormal.length > 0 && (
        <div className="space-y-1 px-4 pt-3">
          {sortedNormal.map(alert => {
            const styles  = SEVERITY_STYLES[alert.severity] ?? SEVERITY_STYLES.warning
            const icon    = TYPE_ICON[alert.alert_type]    ?? "⚠️"
            const label   = TYPE_LABEL[alert.alert_type]   ?? alert.alert_type
            const timeAgo = formatTimeAgo(alert.created_at)

            return (
              <div key={alert.id}
                className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm ${styles.bar}`}>
                <div className="flex items-center gap-2 shrink-0 mt-0.5">
                  <span className="text-lg leading-none">{icon}</span>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${styles.badge}`}>
                    {label}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-gray-100 leading-snug">{alert.message}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
                    <span className="text-gray-500 text-xs">{timeAgo}</span>
                    {alert.auto_paused && (
                      <span className="text-orange-400 text-xs font-medium">
                        ⏸ Campaña pausada automáticamente
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => dismiss(alert.id)}
                  disabled={dismissing.has(alert.id)}
                  title="Marcar como resuelto"
                  className={`shrink-0 p-1.5 rounded-lg transition-colors disabled:opacity-50 ${styles.dismiss}`}
                >
                  {dismissing.has(alert.id) ? (
                    <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin inline-block" />
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function formatTimeAgo(iso: string): string {
  const diff  = Date.now() - new Date(iso).getTime()
  const mins  = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days  = Math.floor(diff / 86_400_000)
  if (mins < 2)   return "Hace un momento"
  if (mins < 60)  return `Hace ${mins} min`
  if (hours < 24) return `Hace ${hours}h`
  return `Hace ${days}d`
}
