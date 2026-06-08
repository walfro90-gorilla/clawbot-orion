// CRM Oracle — "Ojo de Dios"
// Server Component principal: stage tray + health tray + tabla + drawer (URL-state).
// Auto-refresh 30s, scope por rol.

import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/auth/role"
import { redirect } from "next/navigation"
import { CrmClientShell } from "./crm-client-shell"

type SP = { account?: string; status?: string; health?: string; q?: string; lead?: string; page?: string }

export default async function CrmPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const profile = await getSessionUser()
  if (!profile) redirect("/login")

  const admin = createAdminClient()
  const isAdmin = profile.role === "god_admin" || profile.role === "admin"
  const scopedAccountId = isAdmin ? (sp.account ?? null) : profile.linkedin_account_id

  // Cargar lista de cuentas si es admin (para selector)
  const accounts = isAdmin
    ? ((await admin.from("linkedin_accounts").select("id, label").order("label")).data ?? [])
    : []

  // Stage + health counts iniciales (server-rendered)
  let baseQ = (admin as any).from("v_crm_lead_list").select("status, health_flags, linkedin_account_id")
  if (scopedAccountId) baseQ = baseQ.eq("linkedin_account_id", scopedAccountId)
  const { data: allRows } = await baseQ

  const stageCounts: Record<string, number> = {}
  const healthCounts: Record<string, number> = { healthy: 0 }
  for (const r of allRows ?? []) {
    const s = (r as any).status
    if (s) stageCounts[s] = (stageCounts[s] ?? 0) + 1
    const flags = (r as any).health_flags as Record<string, boolean> | null
    if (!flags || Object.keys(flags).length === 0) {
      healthCounts.healthy++
    } else {
      for (const k of Object.keys(flags)) {
        healthCounts[k] = (healthCounts[k] ?? 0) + 1
      }
    }
  }

  // Tabla initial fetch (paginada)
  const page = Math.max(0, parseInt(sp.page ?? "0"))
  const limit = 100
  let leadsQ = (admin as any).from("v_crm_lead_list").select("*", { count: "exact" })
  if (scopedAccountId) leadsQ = leadsQ.eq("linkedin_account_id", scopedAccountId)
  if (sp.status) leadsQ = leadsQ.eq("status", sp.status)
  if (sp.health) leadsQ = leadsQ.contains("health_flags", { [sp.health]: true })
  if (sp.q) leadsQ = leadsQ.ilike("full_name", `%${sp.q}%`)

  const { data: leads, count: leadsTotal } = await leadsQ
    .order("health_priority", { ascending: true })
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .range(page * limit, page * limit + limit - 1)

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100">
      <div className="max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <header className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <span>👁️</span> CRM Oracle <span className="text-xs text-gray-500 font-normal">— Ojo de Dios</span>
            </h1>
            <p className="text-sm text-gray-400 mt-0.5">
              Pipeline visibility + debug per lead. {isAdmin && <span className="text-purple-400">[admin]</span>}
              {!isAdmin && profile.linkedin_account_id && <span className="text-blue-400 ml-1">[scope: tu cuenta]</span>}
            </p>
          </div>
          <div className="text-xs text-gray-500">
            {leadsTotal ?? 0} leads filtrados · refresca cada 30s
          </div>
        </header>

        <CrmClientShell
          leads={leads ?? []}
          total={leadsTotal ?? 0}
          stageCounts={stageCounts}
          healthCounts={healthCounts}
          page={page}
          limit={limit}
          accounts={accounts}
          isAdmin={isAdmin}
          scopedAccountId={scopedAccountId}
          currentParams={{ status: sp.status, health: sp.health, q: sp.q, lead: sp.lead, account: sp.account }}
        />
      </div>
    </main>
  )
}
