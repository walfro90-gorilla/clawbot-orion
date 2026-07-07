import { createAdminClient } from "@/lib/supabase/admin"
import { requireRole } from "@/lib/auth/role"
import { AutoRefresh } from "@/components/auto-refresh"

// Oficina IA — tiempo real, no cachear.
export const dynamic = "force-dynamic"

type AgentDef = {
  key: string
  icon: string
  name: string
  role: string
  actions: string[]
  did: string // qué hace en pasado (lo que "hizo")
}

// Cada agente operativo mapea a una o más `actions` de extension_commands.
const AGENTS: AgentDef[] = [
  { key: "search",  icon: "🔍", name: "Buscador",                  role: "Encuentra decisores nuevos por keyword/empresa", actions: ["search"], did: "Buscó leads" },
  { key: "invite",  icon: "🤝", name: "Invitador",                 role: "Selecciona lead válido y envía invitación",       actions: ["send_invite"], did: "Envió invitación" },
  { key: "message", icon: "💬", name: "Mensajero (IA)",            role: "Seguimientos + auto-respuestas con persona",      actions: ["send_followup"], did: "Envió mensaje" },
  { key: "inbox",   icon: "📥", name: "Lector de Inbox",           role: "Detecta respuestas entrantes",                    actions: ["check_inbox"], did: "Revisó el inbox" },
  { key: "accept",  icon: "✅", name: "Detector de Aceptaciones",  role: "Marca quién aceptó la conexión",                  actions: ["check_sent_invites", "check_connections"], did: "Verificó aceptaciones" },
  { key: "posts",   icon: "📝", name: "Prospector de Posts",       role: "Busca posts y comenta value-first",               actions: ["search_posts", "comment_on_post", "publish_post"], did: "Trabajó posts" },
]

type AgentState = "activo" | "idle" | "error" | "inactivo"

const STATE_STYLE: Record<AgentState, { dot: string; pill: string; label: string }> = {
  activo:    { dot: "bg-green-500 shadow-[0_0_8px_2px] shadow-green-500/40", pill: "bg-green-500/15 text-green-300 border-green-500/40", label: "Activo" },
  idle:      { dot: "bg-amber-400", pill: "bg-amber-500/15 text-amber-300 border-amber-500/40", label: "En espera" },
  error:     { dot: "bg-red-500 animate-pulse", pill: "bg-red-500/15 text-red-300 border-red-500/40", label: "Con error" },
  inactivo:  { dot: "bg-gray-600", pill: "bg-gray-500/15 text-gray-400 border-gray-600/40", label: "Sin actividad 24h" },
}

function hace(iso: string | null): string {
  if (!iso) return "sin actividad"
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1) return "hace segundos"
  if (m < 60) return `hace ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `hace ${h} h`
  return `hace ${Math.floor(h / 24)} d`
}

export default async function OfficePage() {
  await requireRole("admin")
  const db = createAdminClient()
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()

  const [cmdsRes, junkRes] = await Promise.all([
    db.from("extension_commands").select("action, status, created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(3000),
    db.from("leads").select("id", { count: "exact", head: true }).eq("dead_reason", "not_whitelist_junk"),
  ])
  const rows = (cmdsRes.data ?? []) as { action: string | null; status: string | null; created_at: string }[]
  const junkTotal = junkRes.count ?? 0

  const lastOverall = rows[0]?.created_at ?? null
  const schedulerLive = lastOverall ? Date.now() - new Date(lastOverall).getTime() < 15 * 60 * 1000 : false

  const agents = AGENTS.map(a => {
    const mine = rows.filter(r => r.action && a.actions.includes(r.action))
    const last = mine[0] ?? null
    const ok = mine.filter(r => r.status === "completed").length
    const err = mine.filter(r => r.status === "error").length
    const lastAt = last?.created_at ?? null
    const recent = lastAt ? Date.now() - new Date(lastAt).getTime() < 60 * 60 * 1000 : false
    let state: AgentState = "inactivo"
    if (lastAt) {
      if (last?.status === "error") state = "error"
      else if (recent) state = "activo"
      else state = "idle"
    }
    const didLabel = last?.status === "error" ? `${a.did} — falló` : last?.status === "pending" ? `${a.did} — en curso` : a.did
    return { ...a, lastAt, total: mine.length, ok, err, state, didLabel }
  })

  return (
    <div className="p-4 sm:p-8 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-50 flex items-center gap-2">🏢 Oficina IA</h1>
          <p className="text-gray-400 text-sm mt-0.5">Cada agente, su estado y su última acción — en vivo desde <code className="text-gray-500">extension_commands</code> (24h).</p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border ${schedulerLive ? "bg-green-500/15 text-green-300 border-green-500/40" : "bg-red-500/15 text-red-300 border-red-500/40"}`}>
            <span className={`w-2 h-2 rounded-full ${schedulerLive ? "bg-green-500" : "bg-red-500 animate-pulse"}`} />
            Scheduler {schedulerLive ? "activo" : "inactivo"}
          </span>
          <AutoRefresh intervalMs={20000} />
        </div>
      </div>

      {/* Grid de agentes */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map(a => {
          const st = STATE_STYLE[a.state]
          return (
            <div key={a.key} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-3 hover:border-gray-700 transition-colors">
              <div className="flex items-start gap-3">
                <div className="relative shrink-0">
                  <div className="w-12 h-12 rounded-xl bg-gray-800 flex items-center justify-center text-2xl">{a.icon}</div>
                  <span className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-gray-900 ${st.dot}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-gray-50 font-semibold text-sm truncate">{a.name}</h3>
                  <p className="text-gray-500 text-xs leading-snug mt-0.5">{a.role}</p>
                </div>
                <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${st.pill}`}>{st.label}</span>
              </div>

              <div className="bg-gray-800/50 rounded-lg px-3 py-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-gray-300 font-medium">{a.didLabel}</span>
                  <span className="text-gray-500">{hace(a.lastAt)}</span>
                </div>
              </div>

              <div className="flex items-center gap-3 text-[11px] text-gray-500">
                <span>24h: <b className="text-gray-300">{a.total}</b></span>
                {a.ok > 0 && <span className="text-green-400">✓ {a.ok}</span>}
                {a.err > 0 && <span className="text-red-400">✕ {a.err}</span>}
              </div>
            </div>
          )
        })}

        {/* Reaper — agente de fondo (op DB, no despacha comando) */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <div className="relative shrink-0">
              <div className="w-12 h-12 rounded-xl bg-gray-800 flex items-center justify-center text-2xl">🧹</div>
              <span className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-gray-900 ${schedulerLive ? STATE_STYLE.activo.dot : STATE_STYLE.inactivo.dot}`} />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-gray-50 font-semibold text-sm truncate">Reaper</h3>
              <p className="text-gray-500 text-xs leading-snug mt-0.5">Barre junk no-whitelist de <code className="text-gray-600">scraped</code> cada tick</p>
            </div>
            <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${schedulerLive ? STATE_STYLE.activo.pill : STATE_STYLE.inactivo.pill}`}>{schedulerLive ? "Activo" : "Inactivo"}</span>
          </div>
          <div className="bg-gray-800/50 rounded-lg px-3 py-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-gray-300 font-medium">Descalificó junk</span>
              <span className="text-gray-500">acumulado</span>
            </div>
          </div>
          <div className="text-[11px] text-gray-500">Total barrido: <b className="text-gray-300">{junkTotal}</b> leads</div>
        </div>
      </div>

      {/* Leyenda */}
      <div className="flex flex-wrap gap-4 text-[11px] text-gray-500 pt-2">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-green-500" /> Activo (&lt;1h)</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-400" /> En espera</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-500" /> Con error</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-gray-600" /> Sin actividad 24h</span>
      </div>
    </div>
  )
}
