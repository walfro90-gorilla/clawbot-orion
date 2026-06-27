"use server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser, ROLE_LEVEL } from "@/lib/auth/role"
import { explainReason, normalizeReason } from "@/lib/quarantine-reasons"
import { revalidatePath } from "next/cache"
import Link from "next/link"
import type { LeadPipeline } from "@clawbot/db-types"

// ── Server actions ──────────────────────────────────────────────────────────

async function releaseLead(formData: FormData) {
  "use server"
  const me = await getSessionUser()
  if (!me || (ROLE_LEVEL[me.role as keyof typeof ROLE_LEVEL] ?? 0) < 2) return
  const id = formData.get("lead_id") as string
  if (!id) return
  const admin = createAdminClient()
  await admin.from("leads").update({
    consecutive_failures: 0,
    cooldown_until:       null,
    quarantined_at:       null,
    last_failure_at:      null,
    last_failure_reason:  null,
  }).eq("id", id)
  revalidatePath("/dashboard/quarantine")
}

async function markLeadDead(formData: FormData) {
  "use server"
  const me = await getSessionUser()
  if (!me || (ROLE_LEVEL[me.role as keyof typeof ROLE_LEVEL] ?? 0) < 2) return
  const id = formData.get("lead_id") as string
  if (!id) return
  const admin = createAdminClient()
  await admin.from("leads").update({
    status:         "dead",
    dead_reason:    "quarantine_manual",
    quarantined_at: null,
  }).eq("id", id)
  revalidatePath("/dashboard/quarantine")
}

async function releaseAll(formData: FormData) {
  "use server"
  const me = await getSessionUser()
  if (!me || (ROLE_LEVEL[me.role as keyof typeof ROLE_LEVEL] ?? 0) < 2) return
  const ids = (formData.getAll("lead_ids") as string[]).filter(Boolean)
  if (!ids.length) return
  const admin = createAdminClient()
  await admin.from("leads").update({
    consecutive_failures: 0,
    cooldown_until:       null,
    quarantined_at:       null,
    last_failure_at:      null,
    last_failure_reason:  null,
  }).in("id", ids)
  revalidatePath("/dashboard/quarantine")
}

// ── Page ────────────────────────────────────────────────────────────────────

const SEV_STYLE = {
  danger: "bg-red-500/15 text-red-300 border-red-500/40",
  warn:   "bg-amber-500/15 text-amber-300 border-amber-500/40",
  info:   "bg-gray-500/15 text-gray-300 border-gray-500/40",
} as const

export default async function QuarantinePage() {
  const supabase = await createClient()
  const me = await getSessionUser()
  const isRestricted = me?.role === "user" || me?.role === "viewer"

  // Para usuarios restringidos: solo campañas de su cuenta LinkedIn
  let allowedCampaignIds: string[] | null = null
  if (isRestricted && me?.linkedin_account_id) {
    const admin = createAdminClient()
    const { data: accountCampaigns } = await admin
      .from("campaigns")
      .select("id")
      .eq("linkedin_account_id", me.linkedin_account_id)
    allowedCampaignIds = (accountCampaigns ?? []).map((c: { id: string }) => c.id)
  }

  let query = supabase
    .from("v_lead_pipeline")
    .select("*")
    .not("quarantined_at", "is", null)
    .order("quarantined_at", { ascending: false })

  if (allowedCampaignIds !== null) {
    query = allowedCampaignIds.length > 0
      ? query.in("campaign_id", allowedCampaignIds)
      : query.eq("campaign_id", "00000000-0000-0000-0000-000000000000")
  }

  const { data } = await query
  const leads = (data as LeadPipeline[]) ?? []

  // Resumen por razón normalizada
  const byReason = new Map<string, number>()
  for (const l of leads) {
    const k = normalizeReason(l.last_failure_reason)
    byReason.set(k, (byReason.get(k) ?? 0) + 1)
  }
  const reasonChips = [...byReason.entries()].sort((a, b) => b[1] - a[1])

  function daysAgo(d: string | null | undefined): number | null {
    if (!d) return null
    return Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000)
  }

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-50">🔒 Cuarentena</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            {leads.length} lead{leads.length === 1 ? "" : "s"} aislado{leads.length === 1 ? "" : "s"} tras 5 fallos consecutivos (3 si es estructural).
          </p>
        </div>
        {leads.length > 0 && (
          <form action={releaseAll}>
            {leads.map((l) => (
              <input key={l.id} type="hidden" name="lead_ids" value={l.id as string} />
            ))}
            <button
              type="submit"
              className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Liberar todos ({leads.length})
            </button>
          </form>
        )}
      </div>

      {/* Qué es la cuarentena */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-sm text-gray-400 leading-relaxed">
        Un lead entra a <b className="text-gray-300">cuarentena</b> cuando una acción (invitar, seguir, etc.)
        falla 5 veces seguidas — así un lead problemático nunca bloquea la cola.
        Mientras esté en cuarentena, el scheduler <b className="text-gray-300">lo ignora</b>.
        <span className="text-amber-300"> “Liberar”</span> resetea los contadores y lo devuelve a la cola;
        <span className="text-red-300"> “Marcar muerto”</span> lo saca del pipeline.
        Si la causa raíz no está resuelta, liberar puede volver a fallar (lo verás marcado abajo).
      </div>

      {/* Resumen por razón */}
      {reasonChips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {reasonChips.map(([reason, cnt]) => {
            const ex = explainReason(reason)
            return (
              <span
                key={reason}
                title={ex.detail}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border ${SEV_STYLE[ex.severity]}`}
              >
                {ex.title} <span className="font-bold">{cnt}</span>
              </span>
            )
          })}
        </div>
      )}

      {/* Tabla */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
                <th className="px-4 py-3 text-left font-medium">Lead</th>
                <th className="px-4 py-3 text-left font-medium">Campaña</th>
                <th className="px-4 py-3 text-left font-medium">En cuarentena</th>
                <th className="px-4 py-3 text-left font-medium">Fallos</th>
                <th className="px-4 py-3 text-left font-medium">Por qué</th>
                <th className="px-4 py-3 text-right font-medium">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {leads.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-500">
                    🎉 No hay leads en cuarentena.
                  </td>
                </tr>
              ) : (
                leads.map((lead) => {
                  const ex = explainReason(lead.last_failure_reason)
                  const d = daysAgo(lead.quarantined_at)
                  return (
                    <tr key={lead.id} className="hover:bg-gray-800/50 transition-colors align-top">
                      <td className="px-4 py-3">
                        <Link href={`/dashboard/leads/${lead.id}`} className="text-gray-50 hover:text-blue-400 font-medium">
                          {lead.full_name ?? "Sin nombre"}
                        </Link>
                        <div className="text-gray-500 text-xs mt-0.5 truncate max-w-[180px]">
                          {(lead.profile_data as { headline?: string } | null)?.headline
                            ?? lead.linkedin_url?.replace("https://www.linkedin.com/in/", "")}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">{lead.campaign_name ?? "—"}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                        {lead.quarantined_at ? new Date(lead.quarantined_at).toLocaleDateString("es-MX", { day: "2-digit", month: "short" }) : "—"}
                        {d !== null && <div className="text-gray-600 text-[10px]">hace {d}d</div>}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-red-300 font-bold">{lead.consecutive_failures ?? 0}</span>
                      </td>
                      <td className="px-4 py-3 max-w-[340px]">
                        <div className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded border ${SEV_STYLE[ex.severity]}`}>
                          {ex.title}
                        </div>
                        <div className="text-gray-400 text-xs mt-1 leading-snug">{ex.detail}</div>
                        <div className="text-gray-500 text-xs mt-1">
                          💡 {ex.suggestion}
                          {ex.retryLikelyFails && (
                            <span className="ml-1 text-amber-400">(liberar puede re-fallar)</span>
                          )}
                        </div>
                        {lead.last_failure_reason && (
                          <code className="text-gray-600 text-[10px] mt-1 block break-all">{lead.last_failure_reason}</code>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col items-end gap-1.5">
                          <form action={releaseLead}>
                            <input type="hidden" name="lead_id" value={lead.id as string} />
                            <button type="submit" className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap">
                              Liberar
                            </button>
                          </form>
                          <form action={markLeadDead}>
                            <input type="hidden" name="lead_id" value={lead.id as string} />
                            <button type="submit" className="px-3 py-1.5 bg-gray-800 hover:bg-red-900/50 border border-gray-700 hover:border-red-500/40 text-gray-300 hover:text-red-300 text-xs font-medium rounded-lg transition-colors whitespace-nowrap">
                              Marcar muerto
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
