import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/auth/role"
import { ApproveDraftBtn } from "@/components/approve-draft-btn"
import { CountdownTimer } from "@/components/countdown-timer"
import Link from "next/link"
import { notFound } from "next/navigation"

const EVENT_LABELS: Record<string, string> = {
  invite_sent:      "Invitación enviada",
  invite_accepted:  "Invitación aceptada",
  invite_rejected:  "Invitación rechazada",
  message_sent:     "Mensaje enviado",
  message_failed:   "Mensaje fallido",
  reply_received:   "Respuesta recibida",
  follow_up_sent:   "Seguimiento enviado",
  follow_up_sent_2: "Seguimiento 2 enviado",
  follow_up_sent_3: "Seguimiento 3 enviado",
  reply_sent:       "Respuesta enviada",
  meeting_booked:   "Reunión agendada",
  meeting_proposed: "Reunión propuesta",
  meeting_confirmed:"Reunión confirmada",
  note_added:       "Nota interna",
}

const STATUS_COLORS: Record<string, string> = {
  replied:          "bg-green-500/15 text-green-400 border-green-500/30",
  connected:        "bg-blue-500/15 text-blue-400 border-blue-500/30",
  invite_sent:      "bg-purple-500/15 text-purple-400 border-purple-500/30",
  follow_up_sent:   "bg-orange-500/15 text-orange-400 border-orange-500/30",
  follow_up_sent_2: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  follow_up_sent_3: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  meeting_booked:   "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
}

export default async function ConversationThreadPage({
  params,
}: {
  params: Promise<{ leadId: string }>
}) {
  const { leadId } = await params
  const supabase = await createClient()
  const admin    = createAdminClient()
  const me       = await getSessionUser()

  const { data: lead } = await admin
    .from("leads")
    .select("id, full_name, linkedin_url, status, campaigns ( id, name )")
    .eq("id", leadId)
    .single()

  if (!lead) notFound()

  const isRestricted = me?.role === "user" || me?.role === "viewer"
  if (isRestricted && me?.linkedin_account_id) {
    const campId = (lead.campaigns as any)?.id ?? ""
    const { data: camp } = await admin
      .from("campaigns")
      .select("linkedin_account_id")
      .eq("id", campId)
      .single()
    if (camp?.linkedin_account_id !== me.linkedin_account_id) notFound()
  }

  const { data: conv } = await supabase
    .from("conversations")
    .select("id, ai_reply_draft, ai_draft_generated_at, ai_reply_scheduled_at, conversation_turn, last_message_at")
    .eq("lead_id", leadId)
    .maybeSingle()

  const { data: events } = conv?.id
    ? await supabase
        .from("conversation_events")
        .select("*")
        .eq("conversation_id", conv.id)
        .order("sent_at", { ascending: true })
    : { data: [] }

  const eventList    = events ?? []
  const campaign     = lead.campaigns as any
  const hasDraft     = !!(conv?.ai_reply_draft)
  const hasScheduled = !!(conv?.ai_reply_scheduled_at)

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">

      {/* ── Header ── */}
      <div className="flex-none border-b border-gray-800 bg-gray-950 px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/conversations"
            className="text-gray-500 hover:text-gray-300 transition-colors p-1 -ml-1"
            title="Volver"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          {/* Avatar */}
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center text-gray-50 text-sm font-bold flex-shrink-0">
            {(lead.full_name ?? "?")[0].toUpperCase()}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-gray-50 font-semibold text-sm">{lead.full_name}</span>
              <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${STATUS_COLORS[lead.status ?? ""] ?? "bg-gray-500/15 text-gray-400 border-gray-500/30"}`}>
                {lead.status}
              </span>
              {(conv?.conversation_turn ?? 0) > 0 && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-800 text-gray-500 border border-gray-700">
                  Turno {conv!.conversation_turn}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              {campaign?.name && (
                <span className="text-gray-500 text-xs">{campaign.name}</span>
              )}
              {lead.linkedin_url && (
                <>
                  <span className="text-gray-700 text-xs">·</span>
                  <a
                    href={lead.linkedin_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gray-600 hover:text-blue-400 text-xs transition-colors"
                  >
                    LinkedIn ↗
                  </a>
                </>
              )}
            </div>
          </div>
        </div>
        <Link
          href={`/dashboard/leads/${leadId}`}
          className="text-xs text-gray-600 hover:text-gray-400 transition-colors border border-gray-800 hover:border-gray-700 rounded-lg px-3 py-1.5"
        >
          Ver perfil →
        </Link>
      </div>

      {/* ── Messages ── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1 bg-gray-950">
        {eventList.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <p className="text-5xl mb-3">💬</p>
            <p className="text-gray-400 text-sm font-medium">Sin mensajes aún</p>
            <p className="text-gray-600 text-xs mt-1 max-w-xs">
              Los mensajes enviados y recibidos aparecerán aquí cuando el scheduler los registre.
            </p>
          </div>
        ) : (
          <>
            {eventList.map((ev: any, i: number) => {
              const isOutbound = ev.direction === "outbound"
              const isInternal = ev.direction === "internal"
              const isMeeting  = ev.event_type === "meeting_booked"

              // Pill: system events
              if (isMeeting) return (
                <div key={ev.id} className="flex justify-center py-2">
                  <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-full px-4 py-1.5 text-xs text-emerald-400 font-medium flex items-center gap-1.5">
                    📅 {ev.content ?? "Reunión agendada"}
                  </div>
                </div>
              )

              if (isInternal) return (
                <div key={ev.id} className="flex justify-center py-1">
                  <div className="bg-gray-900 border border-gray-800 rounded-full px-3 py-1 text-[11px] text-gray-600">
                    {EVENT_LABELS[ev.event_type] ?? ev.event_type}
                  </div>
                </div>
              )

              // Check if date separator needed
              const prevEv = i > 0 ? eventList[i - 1] : null
              const currDate = ev.sent_at ? new Date(ev.sent_at).toDateString() : null
              const prevDate = prevEv?.sent_at ? new Date(prevEv.sent_at).toDateString() : null
              const showDateSep = currDate && currDate !== prevDate

              return (
                <div key={ev.id}>
                  {showDateSep && (
                    <div className="flex justify-center py-3">
                      <span className="text-[11px] text-gray-600 bg-gray-900 px-3 py-1 rounded-full border border-gray-800">
                        {new Date(ev.sent_at).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" })}
                      </span>
                    </div>
                  )}
                  <div className={`flex ${isOutbound ? "justify-end" : "justify-start"} mb-1`}>
                    <div className={`max-w-[72%] ${isOutbound ? "items-end" : "items-start"} flex flex-col`}>
                      {/* Type label only for non-standard events */}
                      {ev.event_type !== "reply_received" && ev.event_type !== "reply_sent" && (
                        <span className={`text-[10px] mb-0.5 ${isOutbound ? "text-blue-500 text-right" : "text-gray-600"}`}>
                          {EVENT_LABELS[ev.event_type] ?? ev.event_type}
                        </span>
                      )}
                      <div
                        className={`rounded-2xl px-3.5 py-2.5 ${
                          isOutbound
                            ? "bg-blue-600 text-white rounded-br-sm"
                            : "bg-gray-800 text-gray-100 border border-gray-700/60 rounded-bl-sm"
                        }`}
                      >
                        {ev.content ? (
                          <p className="text-sm leading-relaxed whitespace-pre-wrap">{ev.content}</p>
                        ) : (
                          <p className="text-sm italic opacity-50">(sin contenido)</p>
                        )}
                      </div>
                      <span className={`text-[10px] mt-1 ${isOutbound ? "text-gray-600 text-right" : "text-gray-600"}`}>
                        {ev.sent_at
                          ? new Date(ev.sent_at).toLocaleString("es-MX", {
                              hour: "2-digit", minute: "2-digit",
                            })
                          : ""}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>

      {/* ── Draft / Countdown bar (sticky bottom) ── */}
      {(hasDraft || hasScheduled) && conv?.ai_reply_draft && (
        <div className="flex-none border-t border-yellow-500/20 bg-yellow-500/5 px-4 py-3">
          <div className="max-w-3xl mx-auto">
            {hasScheduled ? (
              <CountdownTimer
                scheduledAt={conv.ai_reply_scheduled_at!}
                leadId={leadId}
                draft={conv.ai_reply_draft!}
                leadName={lead.full_name ?? "Lead"}
              />
            ) : (
              <div className="flex items-start gap-3">
                <div className="flex-1 bg-gray-900/80 rounded-xl px-4 py-2.5 border border-gray-700/60">
                  <p className="text-[10px] text-yellow-400 font-medium mb-1">✨ Borrador IA</p>
                  <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">{conv.ai_reply_draft}</p>
                </div>
                <div className="flex-shrink-0 pt-1">
                  <ApproveDraftBtn
                    leadId={leadId}
                    leadName={lead.full_name ?? "Lead"}
                    draft={conv.ai_reply_draft!}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
