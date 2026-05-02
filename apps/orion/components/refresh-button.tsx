"use client"

import { useRouter } from "next/navigation"
import { useTransition, useState } from "react"

export function RefreshButton() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [justRefreshed, setJustRefreshed] = useState(false)

  function handleRefresh() {
    startTransition(() => {
      router.refresh()
    })
    setJustRefreshed(true)
    setTimeout(() => setJustRefreshed(false), 2000)
  }

  return (
    <button
      onClick={handleRefresh}
      disabled={isPending}
      title="Actualizar datos"
      className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border font-medium transition-all ${
        justRefreshed && !isPending
          ? "bg-green-600/20 border-green-500/40 text-green-400"
          : "bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-50 hover:bg-gray-700"
      } disabled:opacity-50`}
    >
      <svg
        className={`w-3.5 h-3.5 ${isPending ? "animate-spin" : ""}`}
        fill="none" stroke="currentColor" viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      {isPending ? "Actualizando…" : justRefreshed ? "✓ Actualizado" : "Actualizar"}
    </button>
  )
}
