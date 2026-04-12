"use client"

import { useState } from "react"

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
  cookie_expiry:"Cookie expirando",
  error_spike:  "Error en automatización",
}

export function AlertBanner({ initialAlerts }: AlertBannerProps) {
  const [alerts, setAlerts] = useState<AccountAlert[]>(initialAlerts)
  const [dismissing, setDismissing] = useState<Set<number>>(new Set())

  if (alerts.length === 0) return null

  async function dismiss(id: number) {
    setDismissing(prev => new Set([...prev, id]))
    try {
      const res = await fetch("/api/alerts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alertId: id }),
      })
      if (res.ok) {
        setAlerts(prev => prev.filter(a => a.id !== id))
      }
    } finally {
      setDismissing(prev => { const s = new Set(prev); s.delete(id); return s })
    }
  }

  // Sort: critical first, then warning, then info; newest within each group
  const sorted = [...alerts].sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 }
    const so = (order[a.severity as keyof typeof order] ?? 9) - (order[b.severity as keyof typeof order] ?? 9)
    if (so !== 0) return so
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })

  return (
    <div className="space-y-1 px-4 pt-3">
      {sorted.map(alert => {
        const styles = SEVERITY_STYLES[alert.severity] ?? SEVERITY_STYLES.warning
        const icon   = TYPE_ICON[alert.alert_type] ?? "⚠️"
        const label  = TYPE_LABEL[alert.alert_type] ?? alert.alert_type
        const timeAgo = formatTimeAgo(alert.created_at)

        return (
          <div
            key={alert.id}
            className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm ${styles.bar}`}
          >
            {/* Icon + badge */}
            <div className="flex items-center gap-2 shrink-0 mt-0.5">
              <span className="text-lg leading-none">{icon}</span>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${styles.badge}`}>
                {label}
              </span>
            </div>

            {/* Message */}
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

            {/* Dismiss */}
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
  )
}

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins  = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days  = Math.floor(diff / 86_400_000)
  if (mins < 2)   return "Hace un momento"
  if (mins < 60)  return `Hace ${mins} min`
  if (hours < 24) return `Hace ${hours}h`
  return `Hace ${days}d`
}
