import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/auth/role"
import { StatusBadge } from "@/components/ui/status-badge"
import Link from "next/link"
import type { LeadPipeline, LeadStatusConfig, Campaign } from "@clawbot/db-types"

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

  // Fetch conversations for leads on this page (to show reply preview)
  const leadIds = leadList.map(l => l.id).filter(Boolean) as string[]
  const { data: convos } = leadIds.length > 0
    ? await supabase
        .from("conversations")
        .select("lead_id, last_message_text, last_message_at, status")
        .in("lead_id", leadIds)
    : { data: [] }
  const convoMap = new Map((convos ?? []).map((c: any) => [c.lead_id, c]))

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Leads</h1>
          <p className="text-gray-400 text-sm mt-0.5">{count ?? leadList.length} leads en total</p>
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

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
              <th className="px-4 py-3 text-left font-medium">Nombre</th>
              <th className="px-4 py-3 text-left font-medium">Cargo</th>
              <th className="px-4 py-3 text-left font-medium">Estado</th>
              <th className="px-4 py-3 text-left font-medium">Campaña</th>
              <th className="px-4 py-3 text-left font-medium">Enviado</th>
              <th className="px-4 py-3 text-left font-medium">Último mensaje</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {leadList.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                  No hay leads con estos filtros.
                </td>
              </tr>
            ) : (
              leadList.map((lead) => {
                const convo = convoMap.get(lead.id as string)
                return (
                <tr key={lead.id} className="hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/dashboard/leads/${lead.id}`} className="text-white hover:text-blue-400 font-medium">
                      {lead.full_name ?? "Sin nombre"}
                    </Link>
                    <div className="text-gray-500 text-xs mt-0.5 truncate max-w-[200px]">
                      {lead.linkedin_url?.replace("https://www.linkedin.com/in/", "")}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-300 max-w-[200px]">
                    <div className="truncate text-xs">{(lead.profile_data as any)?.headline ?? "—"}</div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={lead.status} configs={statuses} size="sm" />
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{lead.campaign_name ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                    {lead.sent_at ? new Date(lead.sent_at).toLocaleDateString("es-MX") : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs max-w-[250px]">
                    {convo ? (
                      <Link href={`/dashboard/leads/${lead.id}`} className="block group">
                        <span className="text-green-400 font-medium">💬 Respondió</span>
                        {convo.last_message_text && (
                          <div className="text-gray-400 truncate mt-0.5 group-hover:text-gray-300">
                            "{convo.last_message_text.slice(0, 60)}{convo.last_message_text.length > 60 ? "…" : ""}"
                          </div>
                        )}
                        {convo.last_message_at && (
                          <div className="text-gray-600 mt-0.5">
                            {new Date(convo.last_message_at).toLocaleDateString("es-MX")}
                          </div>
                        )}
                      </Link>
                    ) : (
                      <span className="text-gray-600">—</span>
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
