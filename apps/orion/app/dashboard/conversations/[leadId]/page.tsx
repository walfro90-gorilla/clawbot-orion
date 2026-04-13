import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/auth/role"
import { ApproveDraftBtn } from "@/components/approve-draft-btn"
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
  reply_sent:       "Respuesta enviada",
  meeting_booked:   "Reunión agendada",
  meeting_proposed: "Reunión propuesta",
  meeting_confirmed:"Reunión confirmada",
  note_added:       "Nota interna",
}

export default async function ConversationThreadPage({
  params,
}: {
  params: Promise<{ leadId: string }>
}) {
  const { leadId } = await params
  const supabase = await createClient()
  const admin = createAdminClient()
  const me = await getSessionUser()

  // Load lead info with campaign name
  const { data: lead } = await admin
    .from("leads")
    .select(`
      id, full_name, linkedin_url, status,
      campaigns ( name, cal_com_url )
    `)
    .eq("id", leadId)
    .single()

  if (!lead) notFound()

  // Access control: restricted users can only see leads of their account
  const isRestricted = me?.role === "user" || me?.role === "viewer"
  if (isRestricted && me?.linkedin_account_id) {
    const { data: campaign } = await admin
      .from("campaigns")
      .select("linkedin_account_id")
      .eq("id", (lead.campaigns as any)?.id ?? "")
      .single()
    if (campaign?.linkedin_account_id !== me.linkedin_account_id) notFound()
  }

  // Load conversation + events
  const { data: conv } = await supabase
    .from("conversations")
    .select("id, ai_reply_draft, ai_draft_generated_at, last_message_text, last_message_at")
    .eq("lead_id", leadId)
    .maybeSingle()

  const { data: events } = conv?.id
    ? await supabase
        .from("conversation_events")
        .select("*")
        .eq("conversation_id", conv.id)
        .order("sent_at", { ascending: true })
    : { data: [] }

  const eventList  = events ?? []
  const campaign   = lead.campaigns as any
  const hasDraft   = !!(conv?.ai_reply_draft)

  const statusColors: Record<string, string> = {
    replied:         "bg-green-500/15 text-green-400 border-green-500/30",
    connected:       "bg-blue-500/15 text-blue-400 border-blue-500/30",
    invite_sent:     "bg-purple-500/15 text-purple-400 border-purple-500/30",
    follow_up_sent:  "bg-orange-500/15 text-orange-400 border-orange-500/30",
    follow_up_sent_2:"bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    meeting_booked:  "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  }

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Link href="/dashboard/conversations" className="hover:text-gray-300 transition-colors">
          Conversaciones
        </Link>
        <span>/</span>
        <span className="text-gray-300">{lead.full_name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">{lead.full_name}</h1>
          {lead.linkedin_url && (
            <a
              href={lead.linkedin_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-500 hover:text-blue-400 text-xs mt-0.5 block transition-colors"
            >
              {lead.linkedin_url.replace("https://www.linkedin.com/in/", "linkedin.com/in/")}
            </a>
          )}
          {campaign?.name && (
            <p className="text-gray-400 text-xs mt-1">Campaña: {campaign.name}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className={`text-xs px-2.5 py-1 rounded-full border font-medium ${statusColors[lead.status ?? ""] ?? "bg-gray-500/15 text-gray-400 border-gray-500/30"}`}>
            {lead.status}
          </span>
          <Link
            href={`/dashboard/leads/${leadId}`}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Ver perfil completo →
          </Link>
        </div>
      </div>

      {/* AI Draft panel */}
      {hasDraft && conv?.ai_reply_draft && (
        <div className="bg-yellow-500/5 border border-yellow-500/30 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-yellow-300 font-semibold text-sm">✨ Borrador de IA listo para aprobación</p>
              {conv.ai_draft_generated_at && (
                <p className="text-gray-500 text-xs mt-0.5">
                  Generado {new Date(conv.ai_draft_generated_at).toLocaleString("es-MX")}
                </p>
              )}
            </div>
            <ApproveDraftBtn
              leadId={leadId}
              leadName={lead.full_name ?? "Lead"}
              draft={conv.ai_reply_draft!}
            />
          </div>
          <div className="bg-gray-900/60 rounded-lg px-4 py-3 border border-gray-700/50">
            <p className="text-gray-200 text-sm leading-relaxed whitespace-pre-wrap">{conv.ai_reply_draft}</p>
          </div>
        </div>
      )}

      {/* Conversation thread */}
      <div className="space-y-1">
        <h2 className="text-gray-400 text-xs uppercase tracking-wider font-medium pb-2">
          Historial de mensajes ({eventList.length})
        </h2>

        {eventList.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
            <p className="text-gray-500 text-sm">Sin historial de mensajes aún.</p>
            <p className="text-gray-600 text-xs mt-1">
              Los mensajes enviados y recibidos aparecerán aquí cuando el scheduler los registre.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {eventList.map((ev: any) => {
              const isOutbound = ev.direction === "outbound"
              const isInternal = ev.direction === "internal"
              const isMeeting  = ev.event_type === "meeting_booked"

              if (isMeeting) {
                return (
                  <div key={ev.id} className="flex justify-center">
                    <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-full px-4 py-1.5 text-xs text-emerald-400 font-medium">
                      📅 {ev.content ?? "Reunión agendada"}
                    </div>
                  </div>
                )
              }

              if (isInternal) {
                return (
                  <div key={ev.id} className="flex justify-center">
                    <div className="bg-gray-800/60 border border-gray-700/50 rounded-full px-4 py-1.5 text-xs text-gray-500">
                      {EVENT_LABELS[ev.event_type] ?? ev.event_type}
                    </div>
                  </div>
                )
              }

              return (
                <div
                  key={ev.id}
                  className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
                      isOutbound
                        ? "bg-blue-600/20 border border-blue-500/20 rounded-br-sm"
                        : "bg-gray-800 border border-gray-700/60 rounded-bl-sm"
                    }`}
                  >
                    {/* Event type badge */}
                    <p className={`text-[10px] font-medium mb-1 ${isOutbound ? "text-blue-400" : "text-gray-500"}`}>
                      {EVENT_LABELS[ev.event_type] ?? ev.event_type}
                    </p>
                    {ev.content && (
                      <p className="text-sm text-gray-100 leading-relaxed whitespace-pre-wrap">
                        {ev.content}
                      </p>
                    )}
                    <p className={`text-[10px] mt-1.5 ${isOutbound ? "text-blue-400/60" : "text-gray-600"}`}>
                      {ev.sent_at
                        ? new Date(ev.sent_at).toLocaleString("es-MX", {
                            day: "numeric", month: "short",
                            hour: "2-digit", minute: "2-digit",
                          })
                        : ""}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
