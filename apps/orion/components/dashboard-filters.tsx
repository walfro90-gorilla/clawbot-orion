"use client"

import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { useState } from "react"

type Range = "" | "today" | "yesterday" | "7d" | "custom"

const BTNS: { value: Range; label: string }[] = [
  { value: "",          label: "Todo" },
  { value: "today",     label: "Hoy" },
  { value: "yesterday", label: "Ayer" },
  { value: "7d",        label: "7 días" },
  { value: "custom",    label: "Personalizado" },
]

export function DashboardFiltersBar({ initialRange, initialFrom, initialTo }: {
  initialRange: Range
  initialFrom: string
  initialTo: string
}) {
  const router      = useRouter()
  const pathname    = usePathname()
  const searchParams = useSearchParams()

  const [customFrom, setCustomFrom] = useState(initialFrom)
  const [customTo,   setCustomTo]   = useState(initialTo)
  const [showCustom, setShowCustom] = useState(initialRange === "custom")

  function push(range: Range, from?: string, to?: string) {
    const p = new URLSearchParams(searchParams.toString())
    if (!range) {
      p.delete("range"); p.delete("from"); p.delete("to")
    } else {
      p.set("range", range)
      if (from) p.set("from", from); else p.delete("from")
      if (to)   p.set("to",   to);   else p.delete("to")
    }
    router.push(`${pathname}?${p.toString()}`)
  }

  function selectRange(v: Range) {
    setShowCustom(v === "custom")
    if (v !== "custom") push(v)
  }

  function applyCustom() {
    if (customFrom && customTo) push("custom", customFrom, customTo)
  }

  const current = initialRange

  return (
    <div className="flex flex-wrap items-center gap-2">
      {BTNS.map(b => (
        <button
          key={b.value}
          onClick={() => selectRange(b.value)}
          className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors border ${
            current === b.value
              ? "bg-blue-600 border-blue-600 text-white"
              : "bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-50 hover:bg-gray-700"
          }`}
        >
          {b.label}
        </button>
      ))}

      {showCustom && (
        <div className="flex flex-wrap items-center gap-2 mt-1 sm:mt-0">
          <input
            type="date"
            value={customFrom}
            onChange={e => setCustomFrom(e.target.value)}
            className="text-xs bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-300 focus:outline-none focus:border-blue-500"
          />
          <span className="text-gray-600 text-xs">→</span>
          <input
            type="date"
            value={customTo}
            onChange={e => setCustomTo(e.target.value)}
            className="text-xs bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-300 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={applyCustom}
            disabled={!customFrom || !customTo}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Aplicar
          </button>
        </div>
      )}
    </div>
  )
}
