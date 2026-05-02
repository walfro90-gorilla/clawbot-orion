import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/auth/role"
import { RefreshInboxBtn } from "@/components/refresh-inbox-btn"
import { ReplyBtn } from "@/components/reply-btn"
import { ApproveDraftBtn } from "@/components/approve-draft-btn"
import { CountdownTimer } from "@/components/countdown-timer"
import Link from "next/link"

// Badge config for inbound_signal
const INBOUND_SIGNAL_META: Record<string, { icon: string; label: string; cls: string }> = {
  lead:      { icon: "🔵", label: "Comprador",  cls: "bg-blue-500/15 border-blue-500/30 text-blue-400" },
  vendor:    { icon: "🟡", label: "Vendedor",   cls: "bg-yellow-500/15 border-yellow-500/30 text-yellow-400" },
  recruiter: { icon: "🟣", label: "Recruiter",  cls: "bg-purple-500/15 border-purple-500/30 text-purple-400" },
  unknown:   { icon: "⚪", label: "Desconocido",cls: "bg-gray-500/15 border-gray-500/30 text-gray-400" },
}

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const { tab = "all" } = await searchParams
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

  // Conversations — include inbound_signal from leads
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
        id, full_name, linkedin_url, status, source,
        inbound_signal,
        inbound_message,
        campaigns ( name )
      )
    `)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(150)

  if (isRestricted && me?.linkedin_account_id) {
    convosQuery = convosQuery.eq("linkedin_account_id", me.linkedin_account_id)
  }

  const { data: convos } = await convosQuery
  const allList = convos ?? []

  // Filter by tab
  const list = allList.filter((c: any) => {
    const isInbound = (c.leads as any)?.source === "inbound"
    if (tab === "inbound") return isInbound
    if (tab === "outbound") return !isInbound
    return true
  })

  const inboundCount  = allList.filter((c: any) => (c.leads as any)?.source === "inbound").length
  const outboundCount = allList.filter((c: any) => (c.leads as any)?.source !== "inbound").length

  // Detect conversation signals from last message text
  function detectSignal(lastMsg: string | null, draft: string | null) {
    const msg  = (lastMsg ?? "").toLowerCase()
    const drft = (draft ?? "").toLowerCase()
    if (lastMsg?.startsWith("[Sin texto"))
      return { icon: "👁️", label: "Revisar manualmente", cls: "bg-orange-500/10 border-orange-500/30 text-orange-400" }
    if (/ya no (trabajo|laburo|estoy|soy)|dejé de trabajar|ya no (pertenec|form)|i (no longer|don't) work|moved (on|company)|left (the company|my role)/i.test(msg))
      return { icon: "🏢", label: "Ya no trabaja ahí", cls: "bg-red-500/10 border-red-500/30 text-red-400" }
    if (/no soy (el|la|quien|la persona)|no es conmigo|no aplica para mí|otro contacto|te recomiendo acercarte|wrong person|not the right (person|contact)/i.test(msg))
      return { icon: "🔀", label: "Persona incorrecta", cls: "bg-red-500/10 border-red-500/30 text-red-400" }
    if (/no (me interesa|tengo interés|estoy interesado|aplica)|no gracias|paso por ahora|not interested|no thanks/i.test(msg))
      return { icon: "❌", label: "No interesado", cls: "bg-gray-500/10 border-gray-500/30 text-gray-400" }
    if (/notificaci|antes de tiempo|mensaje (técnico|del sistema)/i.test(drft))
      return { icon: "🚨", label: "Draft sospechoso", cls: "bg-red-500/10 border-red-500/30 text-red-400" }
    if (/interesa|cuéntame|cómo funciona|cuánto cuesta|me gustaría|cuándo|disponib|tell me more|how (does|do) (it|you)|how much|interested|sounds good|let's (talk|connect|chat)/i.test(msg))
      return { icon: "🔥", label: "Interés detectado", cls: "bg-green-500/10 border-green-500/30 text-green-400" }
    return null
  }

  const statusColors: Record<string, string> = {
    active:         "bg-green-500/15 text-green-400 border-green-500/30",
    initiated:      "bg-blue-500/15 text-blue-400 border-blue-500/30",
    connected:      "bg-purple-500/15 text-purple-400 border-purple-500/30",
    meeting_booked: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    closed_won:     "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    dead:           "bg-red-500/15 text-red-400 border-red-500/30",
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

  const tabs = [
    { key: "all",      label: "Todos",      count: allList.length },
    { key: "outbound", label: "Outbound",   count: outboundCount },
    { key: "inbound",  label: "Entrantes",  count: inboundCount },
  ]

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-50">Conversaciones</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          {allList.length} conversación{allList.length !== 1 ? "es" : ""} — bandeja de mensajes recibidos
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

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {tabs.map(t => (
          <Link
            key={t.key}
            href={`/dashboard/conversations${t.key === "all" ? "" : `?tab=${t.key}`}`}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === t.key || (t.key === "all" && tab === "all")
                ? "bg-gray-800 text-gray-50"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t.key === "inbound" && "📥 "}
            {t.label}
            <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
              tab === t.key ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-500"
            }`}>{t.count}</span>
          </Link>
        ))}
      </div>

      {list.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <p className="text-4xl mb-3">{tab === "inbound" ? "📥" : "💬"}</p>
          <p className="text-gray-50 font-semibold">
            {tab === "inbound" ? "Sin mensajes entrantes aún" : "Sin conversaciones aún"}
          </p>
          <p className="text-gray-400 text-sm mt-1">
            {tab === "inbound"
              ? "Cuando alguien te escriba directamente en LinkedIn, aparecerá aquí clasificado automáticamente."
              : "Las respuestas de LinkedIn aparecerán aquí cuando el inbox las capture."}
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
                  <th className="px-4 py-3 text-left font-medium">Fecha</th>
                  <th className="px-4 py-3 text-left font-medium">Estado</th>
                  <th className="px-4 py-3 text-left font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {list.map((c: any) => {
                  const lead          = c.leads as any
                  const campaign      = lead?.campaigns
                  const isInbound     = lead?.source === "inbound"
                  const inboundSignal = lead?.inbound_signal as string | null
                  const signalMeta    = inboundSignal ? INBOUND_SIGNAL_META[inboundSignal] : null

                  return (
                    <tr key={c.id} className={`hover:bg-gray-800/50 transition-colors ${isInbound ? "bg-purple-500/3" : ""}`}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Link
                            href={`/dashboard/conversations/${c.lead_id}`}
                            className="text-gray-50 hover:text-blue-400 font-medium"
                          >
                            {lead?.full_name ?? "Sin nombre"}
                          </Link>
                          {/* Inbound source badge */}
                          {isInbound && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-500/15 border border-purple-500/30 text-purple-400 font-bold tracking-wide shrink-0">
                              📥 INBOUND
                            </span>
                          )}
                          {/* Inbound signal badge */}
                          {signalMeta && (
                            <span className={`text-[9px] px-1.5 py-0.5 rounded-full border font-bold tracking-wide shrink-0 ${signalMeta.cls}`}>
                              {signalMeta.icon} {signalMeta.label.toUpperCase()}
                            </span>
                          )}
                        </div>
                        {lead?.linkedin_url && (
                          <div className="text-gray-500 text-xs mt-0.5 truncate max-w-[180px]">
                            {lead.linkedin_url.replace("https://www.linkedin.com/in/", "")}
                          </div>
                        )}
                        {/* Inbound original message preview */}
                        {isInbound && lead?.inbound_message && (
                          <div className="text-[10px] text-purple-300/60 mt-0.5 line-clamp-1 max-w-[200px]" title={lead.inbound_message}>
                            "{lead.inbound_message.slice(0, 80)}"
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {campaign?.name ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-xs max-w-[300px]">
                        {c.last_message_text ? (
                          <Link href={`/dashboard/conversations/${c.lead_id}`} className="group">
                            <span className="text-gray-200 group-hover:text-gray-50 line-clamp-2 leading-relaxed">
                              "{c.last_message_text.slice(0, 120)}{c.last_message_text.length > 120 ? "…" : ""}"
                            </span>
                          </Link>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {(() => {
                            const sig = detectSignal(c.last_message_text, c.ai_reply_draft)
                            return sig ? (
                              <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${sig.cls}`}>
                                {sig.icon} {sig.label}
                              </span>
                            ) : null
                          })()}
                          {(c.ai_reply_draft || c.ai_reply_scheduled_at) && (
                            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 font-medium">
                              {c.ai_reply_scheduled_at ? "🤖 Envío programado" : "✨ Draft IA listo"}
                            </span>
                          )}
                          {c.conversation_turn >= 0 && (() => {
                            const t = c.conversation_turn ?? 0
                            const fmLabel = t === 0 ? "FM1" : t <= 2 ? `FM${t + 1}` : "FM3+"
                            const fmCls = t === 0
                              ? "bg-blue-500/10 border-blue-500/20 text-blue-400"
                              : t <= 2
                                ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-400"
                                : "bg-green-500/10 border-green-500/20 text-green-400"
                            return (
                              <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded border font-bold ${fmCls}`}>
                                {fmLabel}
                              </span>
                            )
                          })()}
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
