"use client"

import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { useEffect, useState, useCallback } from "react"
import { LeadDrawer } from "./lead-drawer"

type Lead = {
  id: string
  full_name: string | null
  status: string
  account_label: string | null
  health_flags: Record<string, boolean> | null
  outbound_count: number
  inbound_count: number
  last_outbound_at: string | null
  last_message_at: string | null
  last_cmd_phase: string | null
  last_cmd_status: string | null
  last_cmd_error: string | null
  last_cmd_at: string | null
  recent_error_count_7d: number
  is_overdue: boolean
  lockout_skip_count: number
  inmail_revert_count: number
}

const STAGE_LABELS: Record<string, { label: string; icon: string; color: string }> = {
  scraped:              { label: "Scraped",      icon: "🔍", color: "text-gray-400" },
  pending:              { label: "Pending",      icon: "⏳", color: "text-gray-400" },
  qualified:            { label: "Qualified",    icon: "⭐", color: "text-amber-400" },
  invite_sent:          { label: "Invitado",     icon: "✉️", color: "text-blue-400" },
  connected:            { label: "Conectado",    icon: "🤝", color: "text-emerald-400" },
  follow_up_sent:       { label: "Seguimiento",  icon: "📨", color: "text-cyan-400" },
  awaiting_response:    { label: "Esperando",    icon: "⏳", color: "text-yellow-400" },
  replied:              { label: "Respondió",    icon: "📩", color: "text-green-400" },
  dead:                 { label: "Dead",         icon: "💀", color: "text-gray-500" },
  disqualified:         { label: "Descartado",   icon: "🚫", color: "text-gray-500" },
  failed:               { label: "Failed",       icon: "❌", color: "text-red-400" },
}

const HEALTH_LABELS: Record<string, { label: string; icon: string; color: string; bg: string }> = {
  healthy:              { label: "Healthy",         icon: "✅", color: "text-emerald-400", bg: "bg-emerald-900/30" },
  cooldown:             { label: "Cooldown",        icon: "🟡", color: "text-yellow-400", bg: "bg-yellow-900/30" },
  quarantined:          { label: "Quarantine",      icon: "🔒", color: "text-red-400", bg: "bg-red-900/30" },
  db_linkedin_drift:    { label: "DB↔LinkedIn drift", icon: "🟣", color: "text-purple-400", bg: "bg-purple-900/30" },
  inbound_unprocessed:  { label: "Reply sin procesar", icon: "🔵", color: "text-blue-400", bg: "bg-blue-900/30" },
  reply_pending_sync:   { label: "Replied sin sync", icon: "🟢", color: "text-green-400", bg: "bg-green-900/30" },
  skip_lockout:         { label: "Skip lockout",    icon: "🟠", color: "text-orange-400", bg: "bg-orange-900/30" },
  inmail_blocked:       { label: "InMail blocked",  icon: "🔐", color: "text-pink-400", bg: "bg-pink-900/30" },
  selector_suspect:     { label: "Selector?",       icon: "🔴", color: "text-red-400", bg: "bg-red-900/30" },
  stale_no_reply:       { label: "Sin reply >14d",  icon: "⏰", color: "text-gray-400", bg: "bg-gray-800/50" },
  orphan_no_campaign:   { label: "Huérfano",        icon: "🏝️", color: "text-amber-400", bg: "bg-amber-900/30" },
  terminal:             { label: "Terminal",        icon: "⚫", color: "text-gray-500", bg: "bg-gray-800" },
}

export function CrmClientShell({
  leads, total, stageCounts, healthCounts, page, limit, accounts, isAdmin,
  scopedAccountId, currentParams,
}: {
  leads: Lead[]; total: number
  stageCounts: Record<string, number>; healthCounts: Record<string, number>
  page: number; limit: number
  accounts: Array<{ id: string; label: string | null }>
  isAdmin: boolean
  scopedAccountId: string | null
  currentParams: { status?: string; health?: string; q?: string; lead?: string; account?: string }
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [searchInput, setSearchInput] = useState(currentParams.q ?? "")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Auto-refresh 30s
  useEffect(() => {
    const interval = setInterval(() => router.refresh(), 30_000)
    return () => clearInterval(interval)
  }, [router])

  const updateQuery = useCallback((patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") sp.delete(k); else sp.set(k, v)
    }
    // Reset page when filters change
    if (patch.status !== undefined || patch.health !== undefined || patch.q !== undefined || patch.account !== undefined) {
      sp.delete("page")
    }
    router.push(`${pathname}?${sp.toString()}`)
  }, [router, pathname, searchParams])

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const toggleSelectAll = () => {
    if (selectedIds.size === leads.length) setSelectedIds(new Set())
    else setSelectedIds(new Set(leads.map(l => l.id)))
  }

  const runBulk = async (action: "smart_sync" | "reset_skip" | "mark_dead") => {
    if (selectedIds.size === 0) return alert("Selecciona leads primero")
    if (!confirm(`Aplicar "${action}" a ${selectedIds.size} leads?`)) return
    const r = await fetch("/api/crm/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_ids: [...selectedIds], action }),
    })
    const j = await r.json()
    alert(`Bulk ${action}: ${j.success}/${j.total} success`)
    setSelectedIds(new Set())
    router.refresh()
  }

  return (
    <div>
      {/* Admin account selector */}
      {isAdmin && accounts.length > 0 && (
        <div className="mb-4 flex items-center gap-2">
          <label className="text-xs text-gray-400">Cuenta:</label>
          <select
            value={currentParams.account ?? ""}
            onChange={e => updateQuery({ account: e.target.value || null })}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm"
          >
            <option value="">Todas</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </div>
      )}

      {/* STAGE TRAY */}
      <section className="mb-4">
        <div className="text-xs uppercase text-gray-500 mb-2 tracking-wide">Pipeline Stage</div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(STAGE_LABELS).map(([key, def]) => {
            const count = stageCounts[key] ?? 0
            if (count === 0 && currentParams.status !== key) return null
            const active = currentParams.status === key
            return (
              <button
                key={key}
                onClick={() => updateQuery({ status: active ? null : key })}
                className={`px-3 py-2 rounded-lg border text-xs flex items-center gap-1.5 transition-colors ${
                  active
                    ? "bg-gray-700 border-gray-500 ring-1 ring-blue-500"
                    : "bg-gray-900 border-gray-800 hover:bg-gray-850 hover:border-gray-700"
                }`}
              >
                <span>{def.icon}</span>
                <span className={def.color}>{def.label}</span>
                <span className="font-bold text-gray-100 tabular-nums">{count}</span>
              </button>
            )
          })}
        </div>
      </section>

      {/* HEALTH TRAY */}
      <section className="mb-4">
        <div className="text-xs uppercase text-gray-500 mb-2 tracking-wide">Health Diagnosis</div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(HEALTH_LABELS).map(([key, def]) => {
            const count = healthCounts[key] ?? 0
            if (count === 0 && currentParams.health !== key) return null
            const active = currentParams.health === key
            return (
              <button
                key={key}
                onClick={() => updateQuery({ health: active ? null : key })}
                className={`px-3 py-2 rounded-lg border text-xs flex items-center gap-1.5 transition-colors ${
                  active
                    ? `${def.bg} border-gray-500 ring-1 ring-blue-500`
                    : `${def.bg} border-gray-800 hover:border-gray-700`
                }`}
              >
                <span>{def.icon}</span>
                <span className={def.color}>{def.label}</span>
                <span className="font-bold text-gray-100 tabular-nums">{count}</span>
              </button>
            )
          })}
        </div>
      </section>

      {/* SEARCH + CLEAR */}
      <section className="mb-3 flex gap-2 items-center">
        <input
          type="text"
          placeholder="Buscar nombre…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") updateQuery({ q: searchInput || null }) }}
          className="bg-gray-900 border border-gray-800 rounded px-3 py-1.5 text-sm flex-1 max-w-xs"
        />
        <button
          onClick={() => updateQuery({ q: searchInput || null })}
          className="px-3 py-1.5 bg-blue-700 hover:bg-blue-600 rounded text-sm"
        >Buscar</button>
        <button
          onClick={() => { setSearchInput(""); updateQuery({ status: null, health: null, q: null }) }}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-sm"
        >Clear</button>

        {/* BULK ACTIONS */}
        {selectedIds.size > 0 && isAdmin && (
          <div className="ml-auto flex gap-2 items-center text-xs">
            <span className="text-gray-400">{selectedIds.size} seleccionados</span>
            <button onClick={() => runBulk("smart_sync")} className="px-2 py-1.5 bg-purple-700 hover:bg-purple-600 rounded">Smart-sync</button>
            <button onClick={() => runBulk("reset_skip")} className="px-2 py-1.5 bg-orange-700 hover:bg-orange-600 rounded">Reset skip</button>
            <button onClick={() => runBulk("mark_dead")} className="px-2 py-1.5 bg-red-800 hover:bg-red-700 rounded">Mark dead</button>
          </div>
        )}
      </section>

      {/* TABLE */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-850 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-2 py-2 w-8">
                <input type="checkbox" checked={selectedIds.size === leads.length && leads.length > 0} onChange={toggleSelectAll} />
              </th>
              <th className="px-3 py-2 text-left">Nombre</th>
              <th className="px-3 py-2 text-left">Cuenta</th>
              <th className="px-3 py-2 text-left">Stage</th>
              <th className="px-3 py-2 text-left">Health</th>
              <th className="px-3 py-2 text-left">Outbound·Inbound</th>
              <th className="px-3 py-2 text-left">Last cmd</th>
              <th className="px-3 py-2 text-left">Errors 7d</th>
              <th className="px-3 py-2 text-right">Last msg</th>
            </tr>
          </thead>
          <tbody>
            {leads.map(lead => {
              const stage = STAGE_LABELS[lead.status] ?? { label: lead.status, icon: "?", color: "text-gray-400" }
              const flags = Object.keys(lead.health_flags ?? {})
              return (
                <tr
                  key={lead.id}
                  className="border-t border-gray-800 hover:bg-gray-850 cursor-pointer"
                  onClick={e => {
                    if ((e.target as HTMLElement).tagName === "INPUT") return
                    updateQuery({ lead: lead.id })
                  }}
                >
                  <td className="px-2 py-2" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selectedIds.has(lead.id)} onChange={() => toggleSelect(lead.id)} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-100">{lead.full_name ?? "—"}</div>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-400">{lead.account_label ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`text-xs ${stage.color}`}>{stage.icon} {stage.label}</span>
                    {lead.is_overdue && <span className="ml-1 text-[10px] text-red-400">overdue</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {flags.length === 0 && <span className="text-xs text-emerald-400">✅ healthy</span>}
                      {flags.map(f => {
                        const h = HEALTH_LABELS[f] ?? { icon: "?", label: f, color: "text-gray-400", bg: "" }
                        return <span key={f} className={`text-[10px] ${h.color}`} title={h.label}>{h.icon}</span>
                      })}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums">
                    <span className="text-cyan-400">{lead.outbound_count}</span>
                    <span className="text-gray-500">·</span>
                    <span className="text-green-400">{lead.inbound_count}</span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {lead.last_cmd_phase && (
                      <div>
                        <span className="text-gray-400">{lead.last_cmd_phase}</span>
                        {lead.last_cmd_status === "error" && (
                          <span className="ml-1 text-red-400" title={lead.last_cmd_error ?? ""}>err</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {lead.recent_error_count_7d > 0
                      ? <span className={lead.recent_error_count_7d >= 5 ? "text-red-400 font-bold" : "text-orange-400"}>{lead.recent_error_count_7d}</span>
                      : <span className="text-gray-600">0</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500 text-right">
                    {lead.last_message_at ? new Date(lead.last_message_at).toLocaleDateString("es-MX", { month: "short", day: "numeric" }) : "—"}
                  </td>
                </tr>
              )
            })}
            {leads.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-gray-500 text-sm">No hay leads con estos filtros</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* PAGINATION */}
      {total > limit && (
        <div className="mt-3 flex justify-between items-center text-xs text-gray-500">
          <span>Mostrando {page * limit + 1}–{Math.min((page + 1) * limit, total)} de {total}</span>
          <div className="flex gap-2">
            <button onClick={() => updateQuery({ page: String(Math.max(0, page - 1)) })} disabled={page === 0}
              className="px-2 py-1 bg-gray-800 rounded disabled:opacity-50">← Prev</button>
            <button onClick={() => updateQuery({ page: String(page + 1) })} disabled={(page + 1) * limit >= total}
              className="px-2 py-1 bg-gray-800 rounded disabled:opacity-50">Next →</button>
          </div>
        </div>
      )}

      {/* DRAWER */}
      {currentParams.lead && (
        <LeadDrawer
          leadId={currentParams.lead}
          isAdmin={isAdmin}
          onClose={() => updateQuery({ lead: null })}
        />
      )}
    </div>
  )
}
