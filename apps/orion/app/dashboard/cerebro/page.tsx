import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/auth/role"
import { redirect } from "next/navigation"
import { CerebroPlaybookForm } from "@/components/cerebro-playbook-form"
import { CerebroPlaybookRow } from "@/components/cerebro-playbook-row"

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlaybookEntry {
  id: string
  title: string
  description: string | null
  tags: string[] | null
  situation: string | null
  example_message: string
  applies_to_turns: number[] | null
  outcome: string
  outcome_count: number
  is_active: boolean
  created_at: string
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function CerebroPage() {
  const me = await getSessionUser()
  if (!me) redirect("/login")

  const admin = createAdminClient()
  const isAdmin    = me.role === "god_admin" || me.role === "admin"
  const isRestricted = me.role === "user" || me.role === "viewer"

  // ── Scope campaigns for restricted users ──────────────────────────────────
  let campaignIds: string[] | null = null
  if (isRestricted && me.linkedin_account_id) {
    const { data: camps } = await admin
      .from("campaigns")
      .select("id")
      .eq("linkedin_account_id", me.linkedin_account_id)
    campaignIds = (camps ?? []).map((c: { id: string }) => c.id)
  }

  // ── KPI queries (run in parallel) ─────────────────────────────────────────

  // 1. Conversaciones con IA activa — conversations WHERE conversation_turn > 0
  let convAiQ = admin
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .gt("conversation_turn", 0)

  // 2. Mensajes IA enviados — conversation_events WHERE ai_generated = true
  let aiMsgsQ = admin
    .from("conversation_events")
    .select("id", { count: "exact", head: true })
    .eq("ai_generated", true)

  // 3. Leads que respondieron post-IA: leads WHERE status IN ('replied','meeting_booked')
  //    joined to conversations WHERE conversation_turn > 0
  //    Strategy: count leads that have status replied|meeting_booked AND a conversation with turn > 0
  let repliedPostAiQ = admin
    .from("leads")
    .select("id", { count: "exact", head: true })
    .in("status", ["replied", "meeting_booked"])

  // 4. Reuniones post-IA: leads WHERE status = 'meeting_booked' with IA conversation
  let meetingsPostAiQ = admin
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("status", "meeting_booked")

  // Apply campaign scope for restricted users
  if (campaignIds !== null) {
    if (campaignIds.length === 0) {
      // No campaigns — all counts are zero, skip real queries
    } else {
      convAiQ        = convAiQ.in("campaign_id", campaignIds) as typeof convAiQ
      repliedPostAiQ = repliedPostAiQ.in("campaign_id", campaignIds) as typeof repliedPostAiQ
      meetingsPostAiQ = meetingsPostAiQ.in("campaign_id", campaignIds) as typeof meetingsPostAiQ
      // ai_generated events don't have campaign_id directly — we skip scoping them
    }
  }

  // 5. Playbook entries
  const playbookQ = admin
    .from("ai_playbook")
    .select("*")
    .order("created_at", { ascending: false })

  const [
    { count: convAiCount },
    { count: aiMsgsCount },
    { count: repliedCount },
    { count: meetingsCount },
    { data: playbookRaw },
  ] = await Promise.all([
    campaignIds?.length === 0 ? Promise.resolve({ count: 0 }) : convAiQ,
    aiMsgsQ,
    campaignIds?.length === 0 ? Promise.resolve({ count: 0 }) : repliedPostAiQ,
    campaignIds?.length === 0 ? Promise.resolve({ count: 0 }) : meetingsPostAiQ,
    playbookQ,
  ])

  const playbook = (playbookRaw ?? []) as PlaybookEntry[]

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 sm:p-8 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-50">Cerebro IA</h1>
        <p className="text-gray-400 text-sm mt-1">
          Gestión del playbook de ejemplos que usa Gemini para generar mensajes personalizados
        </p>
      </div>

      {/* ── Section A: KPI stats ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Rendimiento IA
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            label="Conversaciones con IA activa"
            value={convAiCount ?? 0}
            color="purple"
            icon="🧠"
          />
          <KpiCard
            label="Mensajes IA enviados"
            value={aiMsgsCount ?? 0}
            color="blue"
            icon="🤖"
          />
          <KpiCard
            label="Leads respondieron post-IA"
            value={repliedCount ?? 0}
            color="orange"
            icon="💬"
          />
          <KpiCard
            label="Reuniones post-IA"
            value={meetingsCount ?? 0}
            color="green"
            icon="📅"
          />
        </div>
      </section>

      {/* ── Section C: Tips (always visible) ────────────────────────────────── */}
      <section>
        <div className="bg-blue-950/40 border border-blue-500/20 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">💡</span>
            <h2 className="text-sm font-semibold text-blue-300">¿Cómo funciona el Cerebro IA?</h2>
          </div>
          <ul className="space-y-2 text-sm text-blue-200/80 leading-relaxed">
            <li className="flex gap-2">
              <span className="shrink-0 text-blue-400 font-bold">1.</span>
              <span>
                Agrega ejemplos de mensajes que han funcionado bien. Gemini los usará automáticamente
                como referencia cuando genere nuevas respuestas para leads con perfil similar.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="shrink-0 text-blue-400 font-bold">2.</span>
              <span>
                Los <strong className="text-blue-300">tags</strong> determinan cuándo se usa cada ejemplo.
                Si el lead es CEO de manufactura, los ejemplos con tag <code className="bg-blue-900/50 px-1 rounded text-xs">CEO</code> o{" "}
                <code className="bg-blue-900/50 px-1 rounded text-xs">manufactura</code> se incluyen primero.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="shrink-0 text-blue-400 font-bold">3.</span>
              <span>
                El <strong className="text-blue-300">outcome</strong> se actualiza automáticamente: si el lead respondió
                después de un mensaje IA, el sistema aprende que esa estrategia funcionó.
              </span>
            </li>
          </ul>
        </div>
      </section>

      {/* ── Section B: Playbook CRUD ─────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
            Playbook de ejemplos
            <span className="text-xs font-normal normal-case text-gray-600 ml-2">({playbook.length})</span>
          </h2>
          {isAdmin && <CerebroPlaybookForm />}
        </div>

        {/* Table */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/80">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Título
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Situación
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Tags
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Turnos
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Outcome
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Activo
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Acciones
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/60">
                {playbook.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-gray-500">
                      <p className="text-2xl mb-2">🧠</p>
                      {isAdmin
                        ? "No hay ejemplos en el playbook. Agrega el primero usando el botón de arriba."
                        : "No hay ejemplos en el playbook aún."}
                    </td>
                  </tr>
                ) : (
                  playbook.map(entry => (
                    <CerebroPlaybookRow key={entry.id} entry={entry} isAdmin={isAdmin} />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  )
}

// ── KPI Card ──────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  color,
  icon,
}: {
  label: string
  value: number
  color: string
  icon: string
}) {
  const colors: Record<string, string> = {
    purple: "bg-purple-500/10 border-purple-500/20 text-purple-400",
    blue:   "bg-blue-500/10 border-blue-500/20 text-blue-400",
    orange: "bg-orange-500/10 border-orange-500/20 text-orange-400",
    green:  "bg-green-500/10 border-green-500/20 text-green-400",
  }
  return (
    <div className={`rounded-xl border p-5 ${colors[color] ?? colors.blue}`}>
      <div className="flex items-center justify-between">
        <span className="text-2xl">{icon}</span>
        <span className="text-3xl font-bold text-gray-50">{value}</span>
      </div>
      <p className="text-sm mt-2 font-medium">{label}</p>
    </div>
  )
}
