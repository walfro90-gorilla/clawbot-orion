"use client"

import { useEffect, useRef, useState } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"

type Pin = {
  id: number
  pin_x: number
  pin_y: number
  label: string
  extracted_selector: string | null
  confidence: number | null
  applied_to_runtime: boolean
}

type Ticket = {
  id: number
  phase_name: string
  account_id: string
  screenshot_url: string | null
  viewport_width: number | null
  viewport_height: number | null
  url_at_capture: string | null
  status: string
  dom_snapshot: any[]
  pinned_count: number
}

const PIN_LABELS = [
  "message_editor",
  "send_button",
  "thread_list_item",
  "thread_header",
  "conversations_filter",
  "message_event",
  "recipient_typeahead",
  "message_overlay",
  "compose_modal",
  "other",
]

export default function TicketDetailPage() {
  const params = useParams() as { id: string }
  const ticketId = parseInt(params.id)
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [pins, setPins] = useState<Pin[]>([])
  const [pendingClick, setPendingClick] = useState<{ x: number; y: number } | null>(null)
  const [selectedLabel, setSelectedLabel] = useState("send_button")
  const [promote, setPromote] = useState(true)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState("")
  const imgRef = useRef<HTMLImageElement>(null)

  const load = async () => {
    const r = await fetch(`/api/visual-learning/tickets/${ticketId}`)
    const d = await r.json()
    setTicket(d.ticket ?? null)
    setPins(d.pins ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [ticketId])

  if (loading) return <div className="p-8 text-gray-400">Cargando…</div>
  if (!ticket) return <div className="p-8 text-red-400">Ticket no encontrado</div>

  // Click handler en la imagen — convierte click a coords del viewport original
  const onImgClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!imgRef.current) return
    const rect = imgRef.current.getBoundingClientRect()
    const imgX = e.clientX - rect.left
    const imgY = e.clientY - rect.top
    // Scale a coords del viewport ORIGINAL (cuando se capturó)
    const scaleX = (ticket.viewport_width ?? imgRef.current.naturalWidth) / imgRef.current.naturalWidth
    const scaleY = (ticket.viewport_height ?? imgRef.current.naturalHeight) / imgRef.current.naturalHeight
    const viewportX = Math.round(imgX * (imgRef.current.naturalWidth / rect.width) * scaleX)
    const viewportY = Math.round(imgY * (imgRef.current.naturalHeight / rect.height) * scaleY)
    setPendingClick({ x: viewportX, y: viewportY })
    setMsg(`Click en viewport coords (${viewportX}, ${viewportY}). Elige label + Save.`)
  }

  const submitPin = async () => {
    if (!pendingClick) return
    setMsg("Resolviendo…")
    const r = await fetch("/api/visual-learning/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticketId,
        pinX: pendingClick.x,
        pinY: pendingClick.y,
        label: selectedLabel,
        promoteToLearned: promote,
      }),
    })
    const d = await r.json()
    if (r.ok) {
      setMsg(`✅ Pin saved. Selector: ${d.selector} (confidence ${Math.round(d.confidence*100)}%)`)
      setPendingClick(null)
      await load()
    } else {
      setMsg(`❌ ${d.error}`)
    }
  }

  const resolveTicket = async (status: "resolved" | "dismissed") => {
    if (!confirm(`Marcar como ${status}?`)) return
    await fetch(`/api/visual-learning/tickets/${ticketId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, resolved_by: "dashboard" }),
    })
    location.href = "/dashboard/visual-tickets"
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <Link href="/dashboard/visual-tickets" className="text-blue-400 text-sm">← Volver a tickets</Link>
      <div className="flex items-center justify-between mt-2 mb-4">
        <h1 className="text-2xl font-bold">
          🎯 Ticket #{ticket.id} — <span className="text-orange-400">{ticket.phase_name}</span>
        </h1>
        <div className="space-x-2">
          <button onClick={() => resolveTicket("resolved")}
                  className="px-3 py-1 bg-green-700 text-white rounded text-sm">✓ Resolved</button>
          <button onClick={() => resolveTicket("dismissed")}
                  className="px-3 py-1 bg-gray-700 text-white rounded text-sm">Dismiss</button>
        </div>
      </div>

      <div className="text-sm text-gray-400 mb-4">
        URL al capturar: <code className="bg-gray-800 px-1 rounded">{ticket.url_at_capture}</code>
        <br />Viewport: {ticket.viewport_width}×{ticket.viewport_height} ·
        DOM elements: {ticket.dom_snapshot?.length ?? 0} · Pins: {ticket.pinned_count}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Imagen con pins */}
        <div className="lg:col-span-2">
          <div className="relative inline-block bg-gray-900 rounded border border-gray-700 max-w-full">
            {ticket.screenshot_url && (
              <img
                ref={imgRef}
                src={ticket.screenshot_url}
                alt={`Ticket ${ticket.id}`}
                onClick={onImgClick}
                className="max-w-full cursor-crosshair"
                style={{ display: "block" }}
              />
            )}
            {/* Render existing pins */}
            {pins.map(p => {
              if (!imgRef.current) return null
              const rect = imgRef.current.getBoundingClientRect()
              const scaleX = rect.width / (ticket.viewport_width ?? imgRef.current.naturalWidth)
              const scaleY = rect.height / (ticket.viewport_height ?? imgRef.current.naturalHeight)
              return (
                <div key={p.id}
                     className="absolute w-6 h-6 -mt-3 -ml-3 rounded-full border-2 border-yellow-300 bg-yellow-500/40 text-xs font-bold text-yellow-100 flex items-center justify-center"
                     style={{
                       left: p.pin_x * scaleX,
                       top: p.pin_y * scaleY,
                     }}
                     title={`${p.label} → ${p.extracted_selector}`}>
                  {p.id}
                </div>
              )
            })}
            {/* Pending click marker */}
            {pendingClick && imgRef.current && (
              <div
                className="absolute w-6 h-6 -mt-3 -ml-3 rounded-full border-2 border-red-400 bg-red-500/50 animate-pulse"
                style={{
                  left: pendingClick.x * (imgRef.current.getBoundingClientRect().width / (ticket.viewport_width ?? imgRef.current.naturalWidth)),
                  top: pendingClick.y * (imgRef.current.getBoundingClientRect().height / (ticket.viewport_height ?? imgRef.current.naturalHeight)),
                }}
              />
            )}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            👆 Click sobre el componente que Orion debe aprender a encontrar.
          </p>
        </div>

        {/* Sidebar: pin form + pins list */}
        <div className="space-y-4">
          <div className="bg-gray-800 p-4 rounded">
            <h3 className="font-bold mb-2">Nuevo Pin</h3>
            <div className="text-sm space-y-2">
              <label className="block">
                <span className="text-gray-400">Label:</span>
                <select value={selectedLabel} onChange={e => setSelectedLabel(e.target.value)}
                        className="w-full mt-1 bg-gray-700 p-1 rounded">
                  {PIN_LABELS.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
              <label className="block">
                <input type="checkbox" checked={promote} onChange={e => setPromote(e.target.checked)}
                       className="mr-2" />
                <span className="text-gray-300">Promover a learned_selectors (Orion lo usa al instante)</span>
              </label>
              <button onClick={submitPin} disabled={!pendingClick}
                      className="w-full px-3 py-2 bg-blue-600 disabled:bg-gray-700 text-white rounded">
                {pendingClick ? "Guardar Pin" : "Click en imagen primero"}
              </button>
            </div>
            {msg && <p className="mt-3 text-xs text-yellow-300">{msg}</p>}
          </div>

          {/* Pins existentes */}
          <div className="bg-gray-800 p-4 rounded">
            <h3 className="font-bold mb-2">Pins ({pins.length})</h3>
            {pins.length === 0 && <p className="text-sm text-gray-500">No pins yet.</p>}
            <ul className="space-y-2 text-xs">
              {pins.map(p => (
                <li key={p.id} className="border border-gray-700 rounded p-2">
                  <div className="flex justify-between">
                    <span className="text-yellow-300 font-bold">{p.label}</span>
                    <span className="text-gray-500">
                      {p.applied_to_runtime ? "✅ live" : "draft"} · {Math.round((p.confidence ?? 0)*100)}%
                    </span>
                  </div>
                  <code className="block text-gray-400 mt-1 break-all">{p.extracted_selector}</code>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
