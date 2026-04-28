"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"

interface CountdownTimerProps {
  scheduledAt: string  // ISO timestamp
  leadId: string
  draft: string
  leadName?: string
}

export function CountdownTimer({ scheduledAt, leadId, draft, leadName }: CountdownTimerProps) {
  const router = useRouter()
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.round((new Date(scheduledAt).getTime() - Date.now()) / 1000))
  )
  const [loadingAction, setLoadingAction] = useState<"send" | "cancel" | null>(null)
  const [result, setResult] = useState<"sent" | "cancelled" | "error" | null>(null)

  useEffect(() => {
    if (secondsLeft <= 0) return
    const id = setInterval(() => {
      setSecondsLeft(s => Math.max(0, s - 1))
    }, 1000)
    return () => clearInterval(id)
  }, [secondsLeft])

  function formatTime(s: number) {
    if (s <= 0) return "enviando..."
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    if (h > 0) return `${h}h ${m}min`
    if (m > 0) return `${m}min ${sec}s`
    return `${sec}s`
  }

  async function handleSendNow() {
    setLoadingAction("send")
    try {
      const res = await fetch("/api/leads/approve-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId, message: draft }),
      })
      if (!res.ok) throw new Error("Error al enviar")
      setResult("sent")
      router.refresh()
    } catch {
      setResult("error")
    } finally {
      setLoadingAction(null)
    }
  }

  async function handleCancel() {
    setLoadingAction("cancel")
    try {
      const res = await fetch("/api/leads/cancel-auto-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId }),
      })
      if (!res.ok) throw new Error("Error al cancelar")
      setResult("cancelled")
      router.refresh()
    } catch {
      setResult("error")
    } finally {
      setLoadingAction(null)
    }
  }

  if (result === "sent") return (
    <span className="text-xs text-green-400">✓ Enviado</span>
  )
  if (result === "cancelled") return (
    <span className="text-xs text-gray-400">Cancelado — en espera de aprobación</span>
  )
  if (result === "error") return (
    <span className="text-xs text-red-400">Error — recarga la página</span>
  )

  return (
    <div className="flex flex-col gap-2 bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3 text-sm min-w-[220px]">
      <div className="flex items-center gap-1.5 text-yellow-300 font-medium">
        <span>🤖</span>
        <span>
          {secondsLeft > 60
            ? `Envío auto en ${formatTime(secondsLeft)}`
            : secondsLeft > 0
            ? `Enviando en ${formatTime(secondsLeft)}...`
            : "Enviando..."}
        </span>
      </div>
      {draft && (
        <p className="text-xs text-gray-400 line-clamp-2 italic">
          &ldquo;{draft.slice(0, 120)}{draft.length > 120 ? "…" : ""}&rdquo;
        </p>
      )}
      <div className="flex gap-2">
        <button
          onClick={handleSendNow}
          disabled={!!loadingAction}
          className="flex-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-gray-50  px-2 py-1.5 rounded-lg transition-colors"
        >
          {loadingAction === "send" ? "Enviando..." : "Enviar ahora"}
        </button>
        <button
          onClick={handleCancel}
          disabled={!!loadingAction}
          className="flex-1 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 px-2 py-1.5 rounded-lg transition-colors"
        >
          {loadingAction === "cancel" ? "..." : "Cancelar"}
        </button>
      </div>
    </div>
  )
}
