import { createAdminClient } from "@/lib/supabase/admin"
import { requireRole } from "@/lib/auth/role"
import { AutoRefresh } from "@/components/auto-refresh"
import { classifyCommandError } from "@/lib/error-class"

// Oficina IA — tiempo real, no cachear.
export const dynamic = "force-dynamic"

type AgentDef = {
  key: string
  icon: string
  name: string
  role: string
  actions: string[]
  did: string
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

// Etiqueta amigable + icono por acción, para el mini-feed.
const ACTION_META: Record<string, { icon: string; label: string }> = {
  search:             { icon: "🔍", label: "Buscó leads" },
  send_invite:        { icon: "🤝", label: "Envió invitación" },
  send_followup:      { icon: "💬", label: "Envió mensaje / FU" },
  check_inbox:        { icon: "📥", label: "Revisó el inbox" },
  check_sent_invites: { icon: "✅", label: "Verificó invites enviados" },
  check_connections:  { icon: "✅", label: "Verificó conexiones" },
  comment_on_post:    { icon: "📝", label: "Comentó un post" },
  search_posts:       { icon: "📝", label: "Buscó posts" },
  publish_post:       { icon: "📝", label: "Publicó un post" },
}

type AgentState = "activo" | "idle" | "falla" | "esperado" | "inactivo"

const STATE_STYLE: Record<AgentState, { dot: string; pill: string; label: string }> = {
  activo:    { dot: "bg-green-500 shadow-[0_0_8px_2px] shadow-green-500/40", pill: "bg-green-500/15 text-green-300 border-green-500/40", label: "Activo" },
  idle:      { dot: "bg-amber-400", pill: "bg-amber-500/15 text-amber-300 border-amber-500/40", label: "En espera" },
  falla:     { dot: "bg-red-500 animate-pulse", pill: "bg-red-500/15 text-red-300 border-red-500/40", label: "Falla — revisar" },
  esperado:  { dot: "bg-blue-400", pill: "bg-blue-500/15 text-blue-300 border-blue-500/40", label: "OK (regla LinkedIn)" },
  inactivo:  { dot: "bg-gray-600", pill: "bg-gray-500/15 text-gray-400 border-gray-600/40", label: "Sin actividad" },
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

type Row = { action: string | null; status: string | null; created_at: string; error: string | null; reason: string | null }

export default async function OfficePage() {
  await requireRole("admin")
  const db = createAdminClient()
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()

  const [cmdsRes, junkRes] = await Promise.all([
    db.from("extension_commands")
      .select("action, status, created_at, error:result->>error, reason:result->>reason")
      .gte("created_at", since).order("created_at", { ascending: false }).limit(150),
    db.from("leads").select("id", { count: "exact", head: true }).eq("dead_reason", "not_whitelist_junk"),
  ])
  const rows = (cmdsRes.data ?? []) as Row[]
  const junkTotal = junkRes.count ?? 0

  const lastOverall = rows[0]?.created_at ?? null
  const schedulerLive = lastOverall ? Date.now() - new Date(lastOverall).getTime() < 15 * 60 * 1000 : false

  const agents = AGENTS.map(a => {
    const mine = rows.filter(r => r.action && a.actions.includes(r.action))
    const last = mine[0] ?? null
    const ok = mine.filter(r => r.status === "completed").length
    const errs = mine.filter(r => r.status === "error")
    const lastAt = last?.created_at ?? null
    const recent = lastAt ? Date.now() - new Date(lastAt).getTime() < 60 * 60 * 1000 : false

    // Errores: clasificar el más reciente (fault real vs resultado esperado de LinkedIn).
    const lastErr = errs[0] ?? null
    const errClass = lastErr ? classifyCommandError(lastErr.error, "error") : null
    const realFaults = errs.filter(r => classifyCommandError(r.error, "error").isFault).length
    const errInfo = lastErr
      ? {
          code: lastErr.error ?? "desconocido",
          reason: lastErr.reason ?? null,
          fault: !!errClass?.isFault,
          klass: errClass?.label ?? "Otro",
          hint: errClass?.hint ?? "",
          when: lastErr.created_at,
          count24h: errs.length,
        }
      : null

    let state: AgentState = "inactivo"
    if (lastAt) {
      if (last?.status === "error") state = errInfo?.fault ? "falla" : "esperado"
      else if (recent) state = "activo"
      else state = "idle"
    }
    return { ...a, lastAt, total: mine.length, ok, errCount: errs.length, realFaults, state, lastStatus: last?.status ?? null, errInfo }
  })

  const totalFaults = agents.filter(a => a.state === "falla").length
  const feed = rows.slice(0, 24)

  return (
    <div className="p-4 sm:p-8 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-50 flex items-center gap-2">🏢 Oficina IA</h1>
          <p className="text-gray-400 text-sm mt-0.5">Cada agente, su estado y su última acción — en vivo desde <code className="text-gray-500">extension_commands</code> (últimas 150 acciones).</p>
        </div>
        <div className="flex items-center gap-3">
          {totalFaults > 0 && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border bg-red-500/15 text-red-300 border-red-500/40">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /> {totalFaults} agente{totalFaults > 1 ? "s" : ""} con falla
            </span>
          )}
          <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border ${schedulerLive ? "bg-green-500/15 text-green-300 border-green-500/40" : "bg-red-500/15 text-red-300 border-red-500/40"}`}>
            <span className={`w-2 h-2 rounded-full ${schedulerLive ? "bg-green-500" : "bg-red-500 animate-pulse"}`} />
            Scheduler {schedulerLive ? "activo" : "inactivo"}
          </span>
          <AutoRefresh intervalMs={60000} />
        </div>
      </div>

      {/* Grid de agentes */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map(a => {
          const st = STATE_STYLE[a.state]
          const didLabel = a.lastStatus === "error"
            ? (a.errInfo?.fault ? `${a.did} — falló` : `${a.did} — resultado esperado`)
            : a.lastStatus === "pending" ? `${a.did} — en curso` : a.did
          return (
            <div key={a.key} className={`bg-gray-900 border rounded-xl p-4 flex flex-col gap-3 transition-colors ${a.state === "falla" ? "border-red-500/40" : "border-gray-800 hover:border-gray-700"}`}>
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
                  <span className="text-gray-300 font-medium">{didLabel}</span>
                  <span className="text-gray-500">{hace(a.lastAt)}</span>
                </div>
              </div>

              {/* Panel de error — descripción accionable (rojo=fallo, azul=esperado) */}
              {a.errInfo && (
                <div className={`rounded-lg px-3 py-2 text-xs border ${a.errInfo.fault ? "bg-red-500/10 border-red-500/30" : "bg-blue-500/10 border-blue-500/25"}`}>
                  <div className={`flex items-center gap-1.5 font-semibold ${a.errInfo.fault ? "text-red-300" : "text-blue-300"}`}>
                    <span>{a.errInfo.fault ? "🔴" : "ℹ️"}</span>
                    <span>{a.errInfo.klass}</span>
                    <code className="text-[10px] font-normal opacity-80 truncate">{a.errInfo.code}</code>
                    {a.errInfo.count24h > 1 && <span className="ml-auto text-[10px] opacity-70 shrink-0">×{a.errInfo.count24h}</span>}
                  </div>
                  <p className="text-gray-400 leading-snug mt-1">{a.errInfo.hint}</p>
                  {a.errInfo.reason && <p className="text-gray-600 text-[10px] mt-0.5 truncate">detalle: {a.errInfo.reason}</p>}
                </div>
              )}

              <div className="flex items-center gap-3 text-[11px] text-gray-500">
                <span>reciente: <b className="text-gray-300">{a.total}</b></span>
                {a.ok > 0 && <span className="text-green-400">✓ {a.ok}</span>}
                {a.errCount > 0 && <span className={a.realFaults > 0 ? "text-red-400" : "text-blue-400"}>✕ {a.errCount}</span>}
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

      {/* Mini-feed de actividad reciente */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-gray-50 font-semibold text-sm flex items-center gap-2">📡 Actividad reciente</h2>
          <span className="text-gray-500 text-xs">últimas {feed.length} acciones</span>
        </div>
        <div className="divide-y divide-gray-800/70 max-h-96 overflow-y-auto">
          {feed.length === 0 && <div className="px-4 py-6 text-center text-gray-500 text-sm">Sin actividad reciente</div>}
          {feed.map((r, i) => {
            const meta = ACTION_META[r.action ?? ""] ?? { icon: "•", label: r.action ?? "?" }
            const err = r.status === "error" ? classifyCommandError(r.error, "error") : null
            return (
              <div key={i} className="px-4 py-2 flex items-center gap-3 text-xs hover:bg-gray-800/40">
                <span className="text-base shrink-0 w-5 text-center">{meta.icon}</span>
                <span className="text-gray-300 truncate flex-1">{meta.label}</span>
                {r.status === "completed" && <span className="text-green-400 shrink-0">✓</span>}
                {r.status === "pending" && <span className="text-amber-400 shrink-0">⏳</span>}
                {err && (
                  <span className={`shrink-0 flex items-center gap-1 ${err.isFault ? "text-red-400" : "text-blue-400"}`}>
                    <span>{err.isFault ? "🔴" : "ℹ️"}</span>
                    <code className="text-[10px] opacity-80 max-w-40 truncate">{r.error}</code>
                  </span>
                )}
                <span className="text-gray-500 shrink-0 w-16 text-right">{hace(r.created_at)}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Leyenda */}
      <div className="flex flex-wrap gap-4 text-[11px] text-gray-500 pt-2">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-green-500" /> Activo (&lt;1h)</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-400" /> En espera</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-blue-400" /> OK — regla de LinkedIn (no es fallo)</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-500" /> Falla real — requiere acción</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-gray-600" /> Sin actividad</span>
      </div>
    </div>
  )
}
