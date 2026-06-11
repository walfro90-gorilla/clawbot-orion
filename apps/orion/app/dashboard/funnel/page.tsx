import { createAdminClient } from "@/lib/supabase/admin"
import { requireRole } from "@/lib/auth/role"
import { AutoRefresh } from "@/components/auto-refresh"

export const dynamic = "force-dynamic"

type Stage = { key: string; label: string; icon: string; count: number; color: string }

// Funnel monotónico: una etapa "alcanzada" incluye todas las posteriores. Esto evita
// huecos cuando un lead saltó una marca de tiempo (p.ej. inbound-promoted sin connected_at).
function computeFunnel(leads: { sent_at: string | null; connected_at: string | null; replied_at: string | null; meeting_at: string | null }[]): Stage[] {
  let invited = 0, connected = 0, replied = 0, meeting = 0
  for (const l of leads) {
    const hasMeet = !!l.meeting_at
    const hasRep = hasMeet || !!l.replied_at
    const hasConn = hasRep || !!l.connected_at
    const hasInv = hasConn || !!l.sent_at
    if (hasInv) invited++
    if (hasConn) connected++
    if (hasRep) replied++
    if (hasMeet) meeting++
  }
  return [
    { key: "invited",   label: "Invitados",     icon: "🤝", count: invited,   color: "#6366f1" },
    { key: "connected", label: "Conectados",    icon: "🔗", count: connected, color: "#0ea5e9" },
    { key: "replied",   label: "Respondieron",  icon: "💬", count: replied,   color: "#10b981" },
    { key: "meeting",   label: "Citas",         icon: "📅", count: meeting,   color: "#f59e0b" },
  ]
}

function pct(a: number, b: number): string {
  if (!b) return "—"
  return Math.round((a / b) * 100) + "%"
}

function FunnelBars({ stages }: { stages: Stage[] }) {
  const max = Math.max(1, stages[0].count)
  return (
    <div className="space-y-2">
      {stages.map((s, i) => {
        const widthPct = Math.max(4, Math.round((s.count / max) * 100))
        const prev = i > 0 ? stages[i - 1] : null
        const conv = prev ? pct(s.count, prev.count) : null
        return (
          <div key={s.key} className="flex items-center gap-3">
            <div className="w-32 shrink-0 text-sm text-gray-300 flex items-center gap-1.5">
              <span>{s.icon}</span> {s.label}
            </div>
            <div className="flex-1 bg-gray-800/50 rounded-lg overflow-hidden h-9 relative">
              <div className="h-full rounded-lg flex items-center px-3 transition-all"
                style={{ width: `${widthPct}%`, backgroundColor: s.color + "33", borderRight: `2px solid ${s.color}` }}>
                <span className="text-sm font-semibold text-gray-50">{s.count}</span>
              </div>
            </div>
            <div className="w-24 shrink-0 text-right text-xs">
              {conv !== null && (
                <span className={`${conv === "—" ? "text-gray-600" : "text-gray-400"}`}>
                  ↓ {conv} <span className="text-gray-600">conv.</span>
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default async function FunnelPage() {
  await requireRole("admin")
  const db = createAdminClient() as any

  const { data: accounts } = await db
    .from("linkedin_accounts")
    .select("id, label")
    .order("label")

  const perAccount: { label: string; stages: Stage[] }[] = []
  const totals = { invited: 0, connected: 0, replied: 0, meeting: 0 }
  const allCampIds: string[] = []

  for (const acc of accounts ?? []) {
    const { data: camps } = await db.from("campaigns").select("id").eq("linkedin_account_id", acc.id)
    const campIds = (camps ?? []).map((c: any) => c.id)
    campIds.forEach((id: string) => allCampIds.push(id))
    let leads: any[] = []
    if (campIds.length) {
      const { data } = await db
        .from("leads")
        .select("sent_at, connected_at, replied_at, meeting_at")
        .in("campaign_id", campIds)
      leads = data ?? []
    }
    const stages = computeFunnel(leads)
    perAccount.push({ label: acc.label, stages })
    totals.invited += stages[0].count
    totals.connected += stages[1].count
    totals.replied += stages[2].count
    totals.meeting += stages[3].count
  }

  // ⚡ Leads calientes: respondieron pero SIN cita agendada → necesitan acción manual
  // para convertir respuesta→reunión (el cuello del funnel). Surface el último mensaje.
  let hotLeads: any[] = []
  if (allCampIds.length) {
    const { data: hl } = await db
      .from("leads")
      .select("id, full_name, linkedin_url, replied_at")
      .in("campaign_id", allCampIds)
      .eq("status", "replied")
      .is("meeting_at", null)
      .order("replied_at", { ascending: false })
      .limit(25)
    hotLeads = hl ?? []
    if (hotLeads.length) {
      const leadIds = hotLeads.map((l: any) => l.id)
      const { data: convs } = await db
        .from("conversations")
        .select("lead_id, last_message_text")
        .in("lead_id", leadIds)
      const msgByLead: Record<string, string> = {}
      for (const c of convs ?? []) msgByLead[c.lead_id] = c.last_message_text
      hotLeads = hotLeads.map((l: any) => ({ ...l, lastMsg: msgByLead[l.id] ?? null }))
    }
  }

  const totalStages: Stage[] = [
    { key: "invited",   label: "Invitados",    icon: "🤝", count: totals.invited,   color: "#6366f1" },
    { key: "connected", label: "Conectados",   icon: "🔗", count: totals.connected, color: "#0ea5e9" },
    { key: "replied",   label: "Respondieron", icon: "💬", count: totals.replied,   color: "#10b981" },
    { key: "meeting",   label: "Citas",        icon: "📅", count: totals.meeting,   color: "#f59e0b" },
  ]

  return (
    <div className="p-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-50">Funnel de Conversión</h1>
          <p className="text-gray-400 text-sm mt-0.5">Invite → Conexión → Respuesta → Cita · histórico acumulado</p>
        </div>
        <AutoRefresh intervalMs={30000} />
      </div>

      {/* KPIs principales */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Tasa de aceptación", value: pct(totals.connected, totals.invited), sub: `${totals.connected}/${totals.invited} invites`, color: "text-sky-400" },
          { label: "Tasa de respuesta",  value: pct(totals.replied, totals.connected), sub: `${totals.replied}/${totals.connected} conectados`, color: "text-emerald-400" },
          { label: "Respuesta → Cita",   value: pct(totals.meeting, totals.replied), sub: `${totals.meeting}/${totals.replied} respuestas`, color: "text-amber-400" },
          { label: "Invite → Cita",      value: pct(totals.meeting, totals.invited), sub: "conversión total", color: "text-purple-400" },
        ].map((k) => (
          <div key={k.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-gray-400 text-xs">{k.label}</p>
            <p className={`text-2xl font-bold mt-1 ${k.color}`}>{k.value}</p>
            <p className="text-gray-600 text-xs mt-0.5">{k.sub}</p>
          </div>
        ))}
      </div>

      {/* Funnel global */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-50 mb-4">Funnel global (todas las cuentas)</h2>
        <FunnelBars stages={totalStages} />
        {totals.meeting === 0 && totals.replied > 0 && (
          <div className="mt-4 flex items-start gap-2 px-4 py-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm">
            <span className="text-amber-400">⚠️</span>
            <p className="text-amber-300/90">
              <strong>{totals.replied} respuestas pero 0 citas agendadas.</strong> El cuello de botella está en convertir
              la conversación a reunión. Revisa que el link de cal.com se esté enviando y que el copy mueva a agendar.
            </p>
          </div>
        )}
      </div>

      {/* ⚡ Acción requerida — leads calientes que respondieron sin cita */}
      {hotLeads.length > 0 && (
        <div className="bg-gray-900 border border-emerald-800/50 rounded-xl p-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-semibold text-gray-50">⚡ Acción requerida — {hotLeads.length} leads calientes</h2>
            <span className="text-xs text-emerald-400/80">respondieron · sin cita aún → agéndalos</span>
          </div>
          <p className="text-gray-500 text-xs mb-4">Estos contactos ya respondieron. Convertir respuesta→reunión es el mayor ROI ahora.</p>
          <div className="space-y-1.5">
            {hotLeads.map((l: any) => (
              <a
                key={l.id}
                href={`/dashboard/conversations/${l.id}`}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-gray-800/40 hover:bg-gray-800 border border-transparent hover:border-emerald-800/50 transition-colors group"
              >
                <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                <span className="text-sm text-gray-200 font-medium w-44 shrink-0 truncate">{l.full_name ?? "—"}</span>
                <span className="text-xs text-gray-500 flex-1 truncate italic">
                  {l.lastMsg ? `“${l.lastMsg.slice(0, 90)}”` : "(sin último mensaje capturado)"}
                </span>
                <span className="text-xs text-emerald-400/0 group-hover:text-emerald-400/90 shrink-0 transition-colors">abrir →</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Por cuenta */}
      <div className="grid md:grid-cols-2 gap-6">
        {perAccount.map((a) => (
          <div key={a.label} className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-50">{a.label}</h2>
              <span className="text-xs text-gray-500">
                acept. {pct(a.stages[1].count, a.stages[0].count)} · resp. {pct(a.stages[2].count, a.stages[1].count)}
              </span>
            </div>
            <FunnelBars stages={a.stages} />
          </div>
        ))}
      </div>
    </div>
  )
}
