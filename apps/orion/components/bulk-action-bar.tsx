"use client"

import { useState, useEffect } from "react"

const STATUS_OPTIONS = [
  { value: "pending",          label: "Pendiente" },
  { value: "scraped",          label: "Scraped" },
  { value: "disqualified",     label: "Descalificado" },
  { value: "invite_sent",      label: "Invitación enviada" },
  { value: "connected",        label: "Conectado" },
  { value: "follow_up_sent",   label: "FU1 enviado" },
  { value: "follow_up_sent_2", label: "FU2 enviado" },
  { value: "replied",          label: "Respondió" },
  { value: "meeting_booked",   label: "Reunión agendada" },
  { value: "dead",             label: "Muerto" },
]

export function BulkSelectRow({ leadId }: { leadId: string }) {
  return (
    <input
      type="checkbox"
      name="lead_ids"
      value={leadId}
      className="bulk-checkbox w-4 h-4 accent-blue-500 cursor-pointer"
      onChange={() => document.dispatchEvent(new Event("bulk-change"))}
    />
  )
}

export function BulkActionBar({ action }: { action: (fd: FormData) => Promise<void> }) {
  const [count, setCount] = useState(0)
  const [status, setStatus] = useState("dead")

  useEffect(() => {
    function update() {
      const boxes = document.querySelectorAll<HTMLInputElement>(".bulk-checkbox:checked")
      setCount(boxes.length)
    }
    document.addEventListener("bulk-change", update)
    return () => document.removeEventListener("bulk-change", update)
  }, [])

  function selectAll() {
    const boxes = document.querySelectorAll<HTMLInputElement>(".bulk-checkbox")
    boxes.forEach(b => { b.checked = true })
    document.dispatchEvent(new Event("bulk-change"))
  }
  function clearAll() {
    const boxes = document.querySelectorAll<HTMLInputElement>(".bulk-checkbox")
    boxes.forEach(b => { b.checked = false })
    document.dispatchEvent(new Event("bulk-change"))
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData()
    const boxes = document.querySelectorAll<HTMLInputElement>(".bulk-checkbox:checked")
    boxes.forEach(b => fd.append("lead_ids", b.value))
    fd.set("new_status", status)
    await action(fd)
  }

  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border transition-all ${
      count > 0
        ? "bg-blue-500/10 border-blue-500/30 opacity-100"
        : "bg-gray-900 border-gray-800 opacity-60"
    }`}>
      <button type="button" onClick={selectAll} className="text-xs text-gray-400 hover:text-white transition-colors">
        Sel. todos
      </button>
      <button type="button" onClick={clearAll} className="text-xs text-gray-400 hover:text-white transition-colors">
        Limpiar
      </button>
      {count > 0 && (
        <>
          <span className="text-blue-400 text-xs font-medium">{count} seleccionados</span>
          <form onSubmit={handleSubmit} className="flex items-center gap-2 ml-auto">
            <select
              value={status}
              onChange={e => setStatus(e.target.value)}
              className="px-2 py-1 bg-gray-800 border border-gray-700 rounded-lg text-gray-200 text-xs focus:outline-none"
            >
              {STATUS_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <button
              type="submit"
              className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
            >
              Cambiar estado
            </button>
          </form>
        </>
      )}
      {count === 0 && (
        <span className="text-gray-600 text-xs ml-auto">Selecciona leads para acciones masivas</span>
      )}
    </div>
  )
}
