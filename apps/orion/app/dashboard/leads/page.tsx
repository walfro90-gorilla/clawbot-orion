"use server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/auth/role"
import { StatusBadge } from "@/components/ui/status-badge"
import { BulkActionBar, BulkSelectRow } from "@/components/bulk-action-bar"
import Link from "next/link"
import type { LeadPipeline, LeadStatusConfig, Campaign } from "@clawbot/db-types"

async function bulkUpdateStatus(formData: FormData) {
  "use server"
  const admin   = createAdminClient()
  const ids     = formData.getAll("lead_ids") as string[]
  const newStatus = formData.get("new_status") as string
  if (!ids.length || !newStatus) return
  await admin.from("leads").update({ status: newStatus }).in("id", ids)
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; campaign?: string; q?: string; page?: string }>
}) {
  const sp = await searchParams
  const supabase = await createClient()
  const me = await getSessionUser()
  const page = parseInt(sp.page ?? "1")
  const PAGE_SIZE = 50

  const isRestricted = me?.role === "user" || me?.role === "viewer"

  // For restricted users, get only campaigns linked to their LinkedIn account
  let allowedCampaignIds: string[] | null = null
  if (isRestricted && me?.linkedin_account_id) {
    const admin = createAdminClient()
    const { data: accountCampaigns } = await admin
      .from("campaigns")
      .select("id")
      .eq("linkedin_account_id", me.linkedin_account_id)
    allowedCampaignIds = (accountCampaigns ?? []).map((c: any) => c.id)
  }

  const [{ data: configs }, { data: campaigns }] = await Promise.all([
    supabase.from("lead_status_config").select("*").eq("is_visible", true).order("stage_order"),
    isRestricted && me?.linkedin_account_id
      ? supabase.from("campaigns").select("id, name").in("linkedin_account_id", [me.linkedin_account_id])
      : supabase.from("campaigns").select("id, name"),
  ])

  let query = supabase
    .from("v_lead_pipeline")
    .select("*")
    .order("sent_at", { ascending: false, nullsFirst: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)

  // Restrict to linked account's campaigns for role=user
  if (allowedCampaignIds !== null) {
    if (allowedCampaignIds.length > 0) {
      query = query.in("campaign_id", allowedCampaignIds)
    } else {
      // No campaigns linked — return empty
      query = query.eq("campaign_id", "00000000-0000-0000-0000-000000000000")
    }
  }

  if (sp.status)   query = query.eq("status", sp.status)
  if (sp.campaign) query = query.eq("campaign_id", sp.campaign)
  if (sp.q)        query = query.ilike("full_name", `%${sp.q}%`)

  const { data: leads, count } = await query

  const statuses  = configs as LeadStatusConfig[] ?? []
  const campList  = campaigns as Campaign[] ?? []
  const leadList  = leads as LeadPipeline[] ?? []

  // Fetch conversations for leads on this page (to show reply preview + draft badge)
  const leadIds = leadList.map(l => l.id).filter(Boolean) as string[]
  const { data: convos } = leadIds.length > 0
    ? await supabase
        .from("conversations")
        .select("lead_id, last_message_text, last_message_at, status, ai_reply_draft")
        .in("lead_id", leadIds)
    : { data: [] }
  const convoMap = new Map((convos ?? []).map((c: any) => [c.lead_id, c]))

  // Helper: days elapsed since a date
  function daysAgo(dateStr: string | null | undefined): number | null {
    if (!dateStr) return null
    return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000)
  }

  // Message sequence steps per status (which automated messages have been sent)
  const SEQUENCE_STEPS = [
    { status: "invite_sent",     short: "Inv",  title: "Invitación enviada"   },
    { status: "connected",       short: "Cnx",  title: "Conexión aceptada"    },
    { status: "follow_up_sent",  short: "FU1",  title: "Follow-up 1 enviado"  },
    { status: "follow_up_sent_2",short: "FU2",  title: "Follow-up 2 enviado"  },
    { status: "replied",         short: "Rep",  title: "Respondió"            },
    { status: "meeting_booked",  short: "Mtg",  title: "Reunión agendada"     },
  ]

  const STATUS_ORDER: Record<string, number> = {
    scraped: 0, pending: 0, processing: 0, disqualified: 0,
    invite_sent: 1, connected: 2, follow_up_sent: 3, follow_up_sent_2: 4,
    replied: 5, meeting_booked: 6, dead: -1, failed: -1,
  }

  // "Alert" statuses where lead is stuck long enough to flag
  function stuckAlert(lead: LeadPipeline): { days: number; level: "warn" | "danger" } | null {
    const ord = STATUS_ORDER[lead.status ?? ""] ?? 0
    if (ord <= 0 || ord >= 5) return null // don't alert on terminal/replied stages
    const days = daysAgo(lead.sent_at)
    if (days === null) return null
    if (days > 20) return { days, level: "danger" }
    if (days > 10) return { days, level: "warn" }
    return null
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Leads</h1>
          <p className="text-gray-400 text-sm mt-0.5">{count ?? leadList.length} leads en total</p>
        </div>
        <div className="flex gap-2">
          <a
            href={`/api/leads/export?${sp.status ? `status=${sp.status}` : ""}${sp.campaign ? `&campaign=${sp.campaign}` : ""}`}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            ↓ Exportar CSV
          </a>
          {!isRestricted && (
            <Link
              href="/dashboard/leads/import"
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              ↑ Importar CSV
            </Link>
          )}
        </div>
      </div>

      {/* Filters */}
      <form method="GET" className="flex flex-wrap gap-3">
        <input
          name="q"
          defaultValue={sp.q}
          placeholder="Buscar por nombre..."
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-56"
        />
        <select
          name="status"
          defaultValue={sp.status ?? ""}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Todos los estados</option>
          {statuses.map((s) => (
            <option key={s.value} value={s.value}>{s.icon} {s.label_es}</option>
          ))}
        </select>
        <select
          name="campaign"
          defaultValue={sp.campaign ?? ""}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Todas las campañas</option>
          {campList.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button
          type="submit"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Filtrar
        </button>
        {(sp.status || sp.campaign || sp.q) && (
          <Link href="/dashboard/leads" className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors">
            Limpiar
          </Link>
        )}
      </form>

      {/* Status pills summary */}
      <div className="flex flex-wrap gap-2">
        {statuses.filter(s => s.is_visible).map((s) => {
          const cnt = leadList.filter(l => l.status === s.value).length
          return (
            <Link
              key={s.value}
              href={`/dashboard/leads?status=${s.value}`}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                sp.status === s.value ? "ring-2 ring-white/30" : "hover:opacity-80"
              }`}
              style={{ backgroundColor: `${s.color}20`, color: s.color, border: `1px solid ${s.color}40` }}
            >
              {s.icon} {s.label_es} <span className="font-bold">{cnt}</span>
            </Link>
          )
        })}
      </div>

      {/* Bulk action bar */}
      <BulkActionBar action={bulkUpdateStatus} />

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
              <th className="px-4 py-3 w-8"></th>
              <th className="px-4 py-3 text-left font-medium">Nombre</th>
              <th className="px-4 py-3 text-left font-medium">Estado</th>
              <th className="px-4 py-3 text-left font-medium">Secuencia</th>
              <th className="px-4 py-3 text-left font-medium">Campaña</th>
              <th className="px-4 py-3 text-left font-medium">Último mensaje</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {leadList.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-gray-500">
                  No hay leads con estos filtros.
                </td>
              </tr>
            ) : (
              leadList.map((lead) => {
                const convo   = convoMap.get(lead.id as string)
                const ord     = STATUS_ORDER[lead.status ?? ""] ?? 0
                const alert   = stuckAlert(lead)
                const days    = daysAgo(lead.sent_at)
                return (
                <tr key={lead.id} className={`hover:bg-gray-800/50 transition-colors ${
                  alert?.level === "danger" ? "bg-red-950/20" : alert?.level === "warn" ? "bg-yellow-950/20" : ""
                }`}>
                  <td className="px-4 py-3">
                    <BulkSelectRow leadId={lead.id as string} />
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/dashboard/leads/${lead.id}`} className="text-white hover:text-blue-400 font-medium text-sm">
                      {lead.full_name ?? "Sin nombre"}
                    </Link>
                    <div className="text-gray-500 text-xs mt-0.5 truncate max-w-[180px]">
                      {(lead.profile_data as any)?.headline ?? lead.linkedin_url?.replace("https://www.linkedin.com/in/", "")}
                    </div>
                    {alert && (
                      <div className={`text-[10px] mt-0.5 font-medium ${alert.level === "danger" ? "text-red-400" : "text-yellow-400"}`}>
                        ⚠ {alert.days}d sin respuesta
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={lead.status} configs={statuses} size="sm" />
                    {days !== null && ord > 0 && ord < 5 && (
                      <div className="text-gray-600 text-[10px] mt-1">hace {days}d</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {SEQUENCE_STEPS.map((step, i) => {
                        const reached = ord >= STATUS_ORDER[step.status]
                        const current = lead.status === step.status
                        return (
                          <span
                            key={step.status}
                            title={step.title}
                            className={`text-[9px] font-bold px-1 py-0.5 rounded ${
                              lead.status === "dead" && STATUS_ORDER[step.status] > ord
                                ? "bg-gray-800 text-gray-700"
                                : reached
                                  ? current
                                    ? "bg-blue-600 text-white"
                                    : "bg-gray-700 text-gray-300"
                                  : "bg-gray-800 text-gray-700"
                            }`}
                          >
                            {step.short}
                          </span>
                        )
                      })}
                    </div>
                    {convo?.ai_reply_draft && (
                      <div className="mt-1 text-[10px] text-yellow-400 font-medium">✨ Draft IA listo</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{lead.campaign_name ?? "—"}</td>
                  <td className="px-4 py-3 text-xs max-w-[240px]">
                    {convo ? (
                      <Link href={`/dashboard/conversations/${lead.id}`} className="block group">
                        <span className="text-green-400 font-medium text-[11px]">💬 Respondió</span>
                        {convo.last_message_text && (
                          <div className="text-gray-400 truncate mt-0.5 group-hover:text-gray-300 text-[11px]">
                            "{convo.last_message_text.slice(0, 60)}{convo.last_message_text.length > 60 ? "…" : ""}"
                          </div>
                        )}
                        {convo.last_message_at && (
                          <div className="text-gray-600 mt-0.5 text-[10px]">
                            {new Date(convo.last_message_at).toLocaleDateString("es-MX")}
                          </div>
                        )}
                      </Link>
                    ) : lead.sent_at ? (
                      <span className="text-gray-600 text-[11px]">
                        Enviado {new Date(lead.sent_at).toLocaleDateString("es-MX")}
                      </span>
                    ) : (
                      <span className="text-gray-700">—</span>
                    )}
                  </td>
                </tr>
                )
              })
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* Pagination */}
      {leadList.length === PAGE_SIZE && (
        <div className="flex justify-center gap-2">
          {page > 1 && (
            <Link href={`?page=${page - 1}&status=${sp.status ?? ""}&campaign=${sp.campaign ?? ""}&q=${sp.q ?? ""}`}
              className="px-4 py-2 bg-gray-800 text-white rounded-lg text-sm hover:bg-gray-700">
              ← Anterior
            </Link>
          )}
          <Link href={`?page=${page + 1}&status=${sp.status ?? ""}&campaign=${sp.campaign ?? ""}&q=${sp.q ?? ""}`}
            className="px-4 py-2 bg-gray-800 text-white rounded-lg text-sm hover:bg-gray-700">
            Siguiente →
          </Link>
        </div>
      )}
    </div>
  )
}
