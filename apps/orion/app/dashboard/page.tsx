import { createClient } from "@/lib/supabase/server"
import { getSessionUser } from "@/lib/auth/role"
import type { CampaignStats, AccountToday } from "@clawbot/db-types"

export default async function DashboardPage() {
  const supabase = await createClient()
  const me = await getSessionUser()

  const isRestricted = me?.role === "user" || me?.role === "viewer"
  const linkedAccountId = me?.linkedin_account_id ?? null

  let campaignsQuery = supabase.from("v_campaign_stats").select("*").order("created_at", { ascending: false })
  let accountsQuery  = supabase.from("v_account_today").select("*")

  if (isRestricted && linkedAccountId) {
    campaignsQuery = campaignsQuery.eq("linkedin_account_id", linkedAccountId)
    accountsQuery  = accountsQuery.eq("account_id", linkedAccountId)
  }

  const [{ data: campaigns }, { data: accounts }] = await Promise.all([
    campaignsQuery,
    accountsQuery,
  ])

  const stats = campaigns as CampaignStats[] ?? []
  const accs  = accounts  as AccountToday[] ?? []

  const totals = stats.reduce(
    (acc, c) => ({
      leads:    acc.leads    + (c.total_leads ?? 0),
      invited:  acc.invited  + (c.invited     ?? 0),
      replied:  acc.replied  + (c.replied     ?? 0),
      meetings: acc.meetings + (c.meetings    ?? 0),
    }),
    { leads: 0, invited: 0, replied: 0, meetings: 0 }
  )

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <p className="text-gray-400 text-sm mt-1">Vista general de todas tus campañas</p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Total Leads"     value={totals.leads}    color="blue"   icon="👥" />
        <KpiCard label="Invitados"        value={totals.invited}  color="indigo" icon="✉️" />
        <KpiCard label="Respondieron"     value={totals.replied}  color="orange" icon="📩" />
        <KpiCard label="Reuniones"        value={totals.meetings} color="green"  icon="📅" />
      </div>

      {/* Accounts quota */}
      {accs.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Cuentas LinkedIn — Hoy</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {accs.map((a) => (
              <AccountCard key={a.account_id} account={a} />
            ))}
          </div>
        </section>
      )}

      {/* Campaign list */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Campañas</h2>
        {stats.length === 0 ? (
          <p className="text-gray-500 text-sm">No hay campañas aún.</p>
        ) : (
          <div className="space-y-3">
            {stats.map((c) => <CampaignRow key={c.campaign_id} campaign={c} />)}
          </div>
        )}
      </section>
    </div>
  )
}

function KpiCard({ label, value, color, icon }: { label: string; value: number; color: string; icon: string }) {
  const colors: Record<string, string> = {
    blue:   "bg-blue-500/10 border-blue-500/20 text-blue-400",
    indigo: "bg-indigo-500/10 border-indigo-500/20 text-indigo-400",
    orange: "bg-orange-500/10 border-orange-500/20 text-orange-400",
    green:  "bg-green-500/10 border-green-500/20 text-green-400",
  }
  return (
    <div className={`rounded-xl border p-5 ${colors[color]}`}>
      <div className="flex items-center justify-between">
        <span className="text-2xl">{icon}</span>
        <span className="text-3xl font-bold text-white">{value}</span>
      </div>
      <p className="text-sm mt-2 font-medium">{label}</p>
    </div>
  )
}

function AccountCard({ account: a }: { account: AccountToday }) {
  const pct = a.daily_connection_limit
    ? Math.round(((a.invites_sent_today ?? 0) + (a.messages_sent_today ?? 0)) / a.daily_connection_limit * 100)
    : 0

  const statusColor: Record<string, string> = {
    active:       "text-green-400",
    rate_limited: "text-yellow-400",
    banned:       "text-red-400",
    disconnected: "text-gray-400",
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white">
          {a.label ?? a.linkedin_profile_url ?? "Cuenta sin nombre"}
        </span>
        <span className={`text-xs font-medium ${statusColor[a.status ?? ""] ?? "text-gray-400"}`}>
          {a.status}
        </span>
      </div>
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-gray-400">
          <span>{(a.invites_sent_today ?? 0) + (a.messages_sent_today ?? 0)} enviados</span>
          <span>{a.remaining_quota ?? 0} restantes</span>
        </div>
        <div className="w-full bg-gray-800 rounded-full h-1.5">
          <div
            className="bg-blue-500 h-1.5 rounded-full transition-all"
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
      </div>
    </div>
  )
}

function CampaignRow({ campaign: c }: { campaign: CampaignStats }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${c.is_active ? "bg-green-400" : "bg-gray-600"}`} />
            <span className="text-white font-medium text-sm">{c.campaign_name}</span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {c.account_label ?? "Sin cuenta asignada"}
          </p>
        </div>
        <div className="text-right text-xs text-gray-400">
          <div>{c.invite_rate_pct ?? 0}% inv. rate</div>
          <div>{c.acceptance_rate_pct ?? 0}% accept.</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-5 gap-2 text-center">
        {[
          { label: "En cola",   value: c.in_queue   ?? 0, color: "text-gray-300" },
          { label: "Invitados", value: c.invited    ?? 0, color: "text-blue-400"  },
          { label: "Conectados",value: c.connected  ?? 0, color: "text-green-400" },
          { label: "Replies",   value: c.replied    ?? 0, color: "text-orange-400"},
          { label: "Reuniones", value: c.meetings   ?? 0, color: "text-yellow-400"},
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-gray-800/50 rounded-lg py-2 px-1">
            <div className={`text-lg font-bold ${color}`}>{value}</div>
            <div className="text-gray-500 text-xs mt-0.5">{label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
