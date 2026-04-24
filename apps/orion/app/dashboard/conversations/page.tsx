import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/auth/role"
import { RefreshInboxBtn } from "@/components/refresh-inbox-btn"
import { ReplyBtn } from "@/components/reply-btn"
import { ApproveDraftBtn } from "@/components/approve-draft-btn"
import { CountdownTimer } from "@/components/countdown-timer"
import Link from "next/link"

export default async function ConversationsPage() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const me = await getSessionUser()

  const isRestricted = me?.role === "user" || me?.role === "viewer"

  // Accounts visible to this user
  const accountsQuery = supabase
    .from("linkedin_accounts")
    .select("id, label, last_inbox_check_at, status")
    .eq("status", "active")
    .order("label")

  const { data: accounts } = isRestricted && me?.linkedin_account_id
    ? await accountsQuery.eq("id", me.linkedin_account_id)
    : await accountsQuery

  // Conversations — filter by account for restricted users
  let convosQuery = supabase
    .from("conversations")
    .select(`
      id,
      lead_id,
      linkedin_account_id,
      status,
      last_message_text,
      last_message_at,
      inbox_checked_at,
      ai_reply_draft,
      ai_reply_scheduled_at,
      conversation_turn,
      leads (
        id, full_name, linkedin_url, status,
        campaigns ( name )
      )
    `)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(100)

  if (isRestricted && me?.linkedin_account_id) {
    convosQuery = convosQuery.eq("linkedin_account_id", me.linkedin_account_id)
  }

  const { data: convos } = await convosQuery

  const list = convos ?? []

  // Detect conversation signals from last message text
  function detectSignal(lastMsg: string | null, draft: string | null): {
    icon: string; label: string; cls: string
  } | null {
    const msg  = (lastMsg ?? "").toLowerCase()
    const drft = (draft ?? "").toLowerCase()

    if (lastMsg?.startsWith("[Sin texto"))
      return { icon: "👁️", label: "Revisar manualmente", cls: "bg-orange-500/10 border-orange-500/30 text-orange-400" }
    if (/ya no (trabajo|laburo|estoy|soy)|dejé de trabajar|ya no (pertenec|form)/i.test(msg))
      return { icon: "🏢", label: "Ya no trabaja ahí", cls: "bg-red-500/10 border-red-500/30 text-red-400" }
    if (/no soy (el|la|quien|la persona)|no es conmigo|no aplica para mí|otro contacto|te recomiendo acercarte/i.test(msg))
      return { icon: "🔀", label: "Persona incorrecta", cls: "bg-red-500/10 border-red-500/30 text-red-400" }
    if (/no (me interesa|tengo interés|estoy interesado|aplica)|no gracias|paso por ahora/i.test(msg))
      return { icon: "❌", label: "No interesado", cls: "bg-gray-500/10 border-gray-500/30 text-gray-400" }
    if (/notificaci|antes de tiempo|mensaje (técnico|del sistema)/i.test(drft))
      return { icon: "🚨", label: "Draft sospechoso", cls: "bg-red-500/10 border-red-500/30 text-red-400" }
    if (/interesa|cuéntame|cómo funciona|cuánto cuesta|me gustaría|cuándo|disponib/i.test(msg))
      return { icon: "🔥", label: "Interés detectado", cls: "bg-green-500/10 border-green-500/30 text-green-400" }
    return null
  }

  const statusColors: Record<string, string> = {
    active:        "bg-green-500/15 text-green-400 border-green-500/30",
    initiated:     "bg-blue-500/15 text-blue-400 border-blue-500/30",
    connected:     "bg-purple-500/15 text-purple-400 border-purple-500/30",
    meeting_booked:"bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    closed_won:    "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    dead:          "bg-red-500/15 text-red-400 border-red-500/30",
  }
  const statusLabels: Record<string, string> = {
    active:        "Activo",
    initiated:     "Invitado",
    connected:     "Conectado",
    meeting_booked:"Reunión agendada",
    closed_won:    "Cerrado ganado",
    closed_lost:   "Cerrado perdido",
    dead:          "Muerto",
  }

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Conversaciones</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          {list.length} conversación{list.length !== 1 ? "es" : ""} — bandeja de mensajes recibidos
        </p>
      </div>

      {/* Refresh per account */}
      {accounts && accounts.length > 0 && (
        <RefreshInboxBtn accounts={accounts.map(a => ({
          id: a.id,
          label: a.label,
          last_inbox_check_at: a.last_inbox_check_at ?? null,
        }))} />
      )}

      {list.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <p className="text-4xl mb-3">💬</p>
          <p className="text-white font-semibold">Sin conversaciones aún</p>
          <p className="text-gray-400 text-sm mt-1">
            Las respuestas de LinkedIn aparecerán aquí cuando el inbox las capture.
          </p>
          <p className="text-gray-500 text-xs mt-3">
            El inbox corre automáticamente Lun–Vie 9–19h hora México.
          </p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
                  <th className="px-4 py-3 text-left font-medium">Lead</th>
                  <th className="px-4 py-3 text-left font-medium">Campaña</th>
                  <th className="px-4 py-3 text-left font-medium">Último mensaje</th>
                  <th className="px-4 py-3 text-left font-medium">Fecha respuesta</th>
                  <th className="px-4 py-3 text-left font-medium">Estado conv.</th>
                  <th className="px-4 py-3 text-left font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {list.map((c: any) => {
                  const lead     = c.leads
                  const campaign = lead?.campaigns
                  return (
                    <tr key={c.id} className="hover:bg-gray-800/50 transition-colors">
                      <td className="px-4 py-3">
                        <Link
                          href={`/dashboard/conversations/${c.lead_id}`}
                          className="text-white hover:text-blue-400 font-medium"
                        >
                          {lead?.full_name ?? "Sin nombre"}
                        </Link>
                        {lead?.linkedin_url && (
                          <div className="text-gray-500 text-xs mt-0.5 truncate max-w-[180px]">
                            {lead.linkedin_url.replace("https://www.linkedin.com/in/", "")}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {campaign?.name ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-xs max-w-[300px]">
                        {c.last_message_text ? (
                          <Link href={`/dashboard/conversations/${c.lead_id}`} className="group">
                            <span className="text-gray-200 group-hover:text-white line-clamp-2 leading-relaxed">
                              "{c.last_message_text.slice(0, 120)}{c.last_message_text.length > 120 ? "…" : ""}"
                            </span>
                          </Link>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {/* Conversation signal */}
                          {(() => {
                            const sig = detectSignal(c.last_message_text, c.ai_reply_draft)
                            return sig ? (
                              <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${sig.cls}`}>
                                {sig.icon} {sig.label}
                              </span>
                            ) : null
                          })()}
                          {/* Draft / schedule status */}
                          {(c.ai_reply_draft || c.ai_reply_scheduled_at) && (
                            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 font-medium">
                              {c.ai_reply_scheduled_at ? "🤖 Envío programado" : "✨ Draft IA listo"}
                            </span>
                          )}
                          {/* Turn badge */}
                          {c.conversation_turn > 0 && (
                            <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">
                              Turno {c.conversation_turn}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                        {c.last_message_at
                          ? new Date(c.last_message_at).toLocaleString("es-MX", {
                              day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                            })
                          : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-1 rounded-full border font-medium ${statusColors[c.status] ?? "bg-gray-500/15 text-gray-400 border-gray-500/30"}`}>
                          {statusLabels[c.status] ?? c.status ?? "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1.5">
                          {c.ai_reply_scheduled_at ? (
                            <CountdownTimer
                              scheduledAt={c.ai_reply_scheduled_at}
                              leadId={c.lead_id}
                              draft={c.ai_reply_draft ?? ""}
                              leadName={lead?.full_name ?? "Lead"}
                            />
                          ) : c.ai_reply_draft ? (
                            <ApproveDraftBtn
                              leadId={c.lead_id}
                              leadName={lead?.full_name ?? "Lead"}
                              draft={c.ai_reply_draft}
                            />
                          ) : (
                            <ReplyBtn
                              leadId={c.lead_id}
                              leadName={lead?.full_name ?? "Lead"}
                            />
                          )}
                          <Link
                            href={`/dashboard/conversations/${c.lead_id}`}
                            className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors text-center"
                          >
                            Ver hilo →
                          </Link>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
