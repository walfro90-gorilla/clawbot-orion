"use client"

import { useState } from "react"

const FLAG: Record<string, string> = {
  MX: "🇲🇽", US: "🇺🇸", ES: "🇪🇸", AR: "🇦🇷", CO: "🇨🇴",
  BR: "🇧🇷", CL: "🇨🇱", PE: "🇵🇪", DE: "🇩🇪", GB: "🇬🇧",
  FR: "🇫🇷", CA: "🇨🇦", NL: "🇳🇱", IT: "🇮🇹", AU: "🇦🇺",
}

interface ProxyInfo {
  ip?: string | null
  countryCode?: string | null
  country?: string | null
  city?: string | null
  checkedAt?: string | null
}

interface Props {
  accountId: string
  initial: ProxyInfo
  hasProxy: boolean
}

export function ProxyChecker({ accountId, initial, hasProxy }: Props) {
  const [info, setInfo]       = useState<ProxyInfo>(initial)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  async function check() {
    setLoading(true)
    setError(null)
    try {
      const res  = await fetch("/api/accounts/check-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? "Error"); return }
      setInfo({ ip: data.ip, countryCode: data.countryCode, country: data.country, city: data.city, checkedAt: data.checkedAt })
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const flag    = info.countryCode ? (FLAG[info.countryCode] ?? "🌐") : null
  const lastCheck = info.checkedAt
    ? new Date(info.checkedAt).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : null

  return (
    <div className="space-y-2">
      {/* Proxy info display */}
      {info.ip ? (
        <div className="flex items-center gap-3 px-3 py-2 bg-gray-800 rounded-lg text-sm">
          <span className="text-xl">{flag}</span>
          <div className="flex-1 min-w-0">
            <p className="text-gray-50 font-mono text-xs">{info.ip}</p>
            <p className="text-gray-400 text-xs">{info.city ? `${info.city}, ` : ""}{info.country}</p>
          </div>
          <span className="text-green-400 text-xs shrink-0">✓ Activo</span>
        </div>
      ) : hasProxy ? (
        <div className="px-3 py-2 bg-gray-800 rounded-lg text-xs text-gray-500">
          Sin verificar — haz click en "Verificar"
        </div>
      ) : (
        <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
          ⚠️ Sin proxy configurado — riesgo de ban alto
        </div>
      )}

      {/* Actions */}
      {hasProxy && (
        <div className="flex items-center gap-2">
          <button
            onClick={check}
            disabled={loading}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded-lg transition-colors disabled:opacity-50"
          >
            {loading ? "Verificando..." : "🔍 Verificar proxy"}
          </button>
          {lastCheck && (
            <span className="text-gray-600 text-xs">Última: {lastCheck}</span>
          )}
        </div>
      )}

      {error && (
        <p className="text-red-400 text-xs">❌ {error}</p>
      )}
    </div>
  )
}
