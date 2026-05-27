"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

export function InboxSweepBtn() {
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const router = useRouter()

  async function handleClick() {
    if (loading) return
    if (!confirm("¿Barrer inbox últimos 15 días? Esto puede tardar 1-2 min y consume 1 slot diario.")) return
    setLoading(true)
    setMsg(null)
    try {
      const res = await fetch("/api/inbox-sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (res.ok) {
        setMsg(`✅ Barrido dispatched (${data.dispatched} cuentas). Revisa orphans en ~2min.`)
        setTimeout(() => router.refresh(), 4000)
      } else {
        setMsg(`❌ Error: ${data.error ?? "desconocido"}`)
      }
    } catch (err) {
      setMsg(`❌ Network error`)
    } finally {
      setLoading(false)
      setTimeout(() => setMsg(null), 8000)
    }
  }

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <button
        onClick={handleClick}
        disabled={loading}
        className="text-xs px-3 py-1.5 rounded-md border bg-cyan-500/10 text-cyan-300 border-cyan-500/30 hover:bg-cyan-500/20 disabled:opacity-50"
      >
        {loading ? "🔍 Barriendo..." : "🔍 Barrer inbox 15 días"}
      </button>
      {msg && <span className="text-[10px] text-gray-400">{msg}</span>}
    </div>
  )
}
