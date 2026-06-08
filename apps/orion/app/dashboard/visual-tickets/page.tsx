"use client"

import { useEffect, useState } from "react"
import Link from "next/link"

type Ticket = {
  id: number
  created_at: string
  phase_name: string
  trigger_source: string
  account_label: string | null
  screenshot_url: string | null
  url_at_capture: string | null
  pinned_count: number
  status: string
  age_minutes: number
  dom_elements_count: number
}

export default function VisualTicketsPage() {
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch("/api/visual-learning/tickets?status=open&limit=50")
      .then(r => r.json())
      .then(d => setTickets(d.tickets ?? []))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">🎯 Visual Selector Learning — Tickets</h1>
        <button
          onClick={() => location.reload()}
          className="px-3 py-1 bg-blue-600 text-white rounded text-sm">
          🔄 Refresh
        </button>
      </div>

      <p className="text-gray-400 text-sm mb-6">
        Cuando Orion detecta que un selector falla repetidamente (3× en 1h), captura un screenshot
        del viewport + DOM snapshot. Aquí los abres, hacés pins sobre los componentes (botón Enviar,
        editor, lista de mensajes) y Orion aprende los nuevos selectores estables.
      </p>

      {loading && <div className="text-gray-500">Cargando tickets…</div>}

      {!loading && tickets.length === 0 && (
        <div className="p-8 bg-gray-800 rounded text-center text-gray-400">
          ✨ No hay tickets abiertos — Orion está funcionando bien.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {tickets.map(t => (
          <Link key={t.id} href={`/dashboard/visual-tickets/${t.id}`}
                className="block p-4 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 transition">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs px-2 py-1 bg-orange-900 text-orange-200 rounded">
                {t.phase_name}
              </span>
              <span className="text-xs text-gray-400">#{t.id}</span>
            </div>
            {t.screenshot_url && (
              <img src={t.screenshot_url} alt={`Ticket ${t.id}`}
                   className="w-full h-32 object-cover object-top rounded mb-2 border border-gray-600" />
            )}
            <div className="text-sm space-y-1">
              <div><span className="text-gray-400">Cuenta:</span> {t.account_label ?? "—"}</div>
              <div><span className="text-gray-400">Trigger:</span> {t.trigger_source}</div>
              <div><span className="text-gray-400">Pins:</span> {t.pinned_count} · <span className="text-gray-400">DOM:</span> {t.dom_elements_count}</div>
              <div><span className="text-gray-400">Edad:</span> {t.age_minutes}min</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
