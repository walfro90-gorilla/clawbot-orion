import { createAdminClient } from "@/lib/supabase/admin"
import { requireRole } from "@/lib/auth/role"

export const dynamic = "force-dynamic"

const WARMUP: Record<string, { icon: string; label: string }> = {
  cold: { icon: "❄️", label: "Fría" }, warming: { icon: "🌡️", label: "Tibia" },
  warm: { icon: "☀️", label: "Cálida" }, hot: { icon: "🔥", label: "Caliente" },
}

export default async function ControlHubPage() {
  await requireRole("god_admin")
  const admin = createAdminClient() as any

  const { data: accounts } = await admin
    .from("linkedin_accounts")
    .select("id, label, status, warmup_status, daily_connection_limit, extension_paused, ext_version, extension_last_seen_at")
    .order("label")

  // conteo de campañas por cuenta
  const { data: camps } = await admin.from("campaigns").select("id, linkedin_account_id, is_active")
  const campCount: Record<string, { total: number; active: number }> = {}
  for (const c of camps ?? []) {
    const k = c.linkedin_account_id
    if (!k) continue
    campCount[k] = campCount[k] ?? { total: 0, active: 0 }
    campCount[k].total++
    if (c.is_active) campCount[k].active++
  }

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-50">⚙️ Centro de Control</h1>
        <p className="text-gray-400 text-sm mt-0.5">Configuración integral por cuenta: operación, anti-ban, presets y campañas. Elige una cuenta.</p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {(accounts ?? []).map((a: any) => {
          const stale = a.extension_last_seen_at ? Math.round((Date.now() - new Date(a.extension_last_seen_at).getTime()) / 1000) : null
          const conn = stale == null ? "⚪" : stale < 180 ? "🟢" : stale < 600 ? "🟡" : "🔴"
          const w = WARMUP[a.warmup_status] ?? { icon: "", label: a.warmup_status }
          const cc = campCount[a.id] ?? { total: 0, active: 0 }
          return (
            <a key={a.id} href={`/dashboard/accounts/${a.id}/config`}
              className="block bg-gray-900 border border-gray-800 hover:border-blue-700 rounded-xl p-5 transition-colors group">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-50">{a.label ?? "Sin etiqueta"}</h2>
                <span className="text-gray-500 group-hover:text-blue-400 text-sm transition-colors">abrir →</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
                <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300">{conn} ext {a.ext_version ?? "?"}</span>
                <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300">{w.icon} {w.label}</span>
                <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300">cap {a.daily_connection_limit}/día</span>
                <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300">🎯 {cc.active}/{cc.total} campañas</span>
                {a.extension_paused && <span className="px-2 py-0.5 rounded bg-red-500/15 text-red-400">⏸️ pausada</span>}
              </div>
            </a>
          )
        })}
      </div>
    </div>
  )
}
