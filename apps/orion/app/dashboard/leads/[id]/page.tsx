import { createClient } from "@/lib/supabase/server"
import { StatusBadge } from "@/components/ui/status-badge"
import Link from "next/link"
import { notFound } from "next/navigation"
import type { LeadStatusConfig } from "@clawbot/db-types"

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const [{ data: lead }, { data: configs }, { data: notes }, { data: conv }] = await Promise.all([
    supabase.from("v_lead_pipeline").select("*").eq("id", id).single(),
    supabase.from("lead_status_config").select("*").order("stage_order"),
    supabase.from("lead_notes").select("*").eq("lead_id", id).order("created_at", { ascending: false }),
    supabase.from("conversations").select("id").eq("lead_id", id).maybeSingle(),
  ])

  // Fetch events separately using the conversation id — more reliable than join filter
  const { data: events } = conv?.id
    ? await supabase
        .from("conversation_events")
        .select("*")
        .eq("conversation_id", conv.id)
        .order("sent_at", { ascending: true })
    : { data: [] }

  if (!lead) notFound()

  const statuses = configs as LeadStatusConfig[] ?? []
  const profile  = lead.profile_data as any ?? {}

  return (
    <div className="p-8 max-w-5xl space-y-6">
      {/* Back */}
      <Link href="/dashboard/leads" className="text-gray-400 hover:text-white text-sm flex items-center gap-1">
        ← Volver a Leads
      </Link>

      {/* Header */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white">{lead.full_name ?? "Sin nombre"}</h1>
            <p className="text-gray-400 text-sm mt-1">{profile.headline}</p>
            <a
              href={lead.linkedin_url ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline text-xs mt-1 inline-block"
            >
              {lead.linkedin_url}
            </a>
          </div>
          <StatusBadge status={lead.status} configs={statuses} />
        </div>

        {/* Meta */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-gray-800">
          <MetaItem label="Campaña"    value={lead.campaign_name ?? "—"} />
          <MetaItem label="Cuenta LI"  value={lead.account_label ?? "—"} />
          <MetaItem label="AI Calificó" value={lead.ai_qualified ? "✅ Sí" : "❌ No"} />
          <MetaItem label="Enviado"    value={lead.sent_at ? new Date(lead.sent_at).toLocaleString("es-MX") : "—"} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* AI Message */}
        {lead.ai_message && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Mensaje enviado</h2>
            {lead.ai_subject && (
              <p className="text-gray-300 text-xs font-medium">Asunto: {lead.ai_subject}</p>
            )}
            <p className="text-white text-sm leading-relaxed whitespace-pre-wrap bg-gray-800/50 rounded-lg p-3">
              {lead.ai_message}
            </p>
          </div>
        )}

        {/* Profile data */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Perfil LinkedIn</h2>
          <dl className="space-y-2 text-sm">
            {profile.headline  && <Row label="Cargo"     value={profile.headline} />}
            {profile.location  && <Row label="Ubicación" value={profile.location} />}
            {profile.about     && <Row label="About"     value={profile.about} />}
            {profile.currentPosition && <Row label="Empresa" value={profile.currentPosition} />}
          </dl>
          {Object.keys(profile).length === 0 && (
            <p className="text-gray-500 text-sm">Sin datos de perfil guardados.</p>
          )}
        </div>
      </div>

      {/* Conversation */}
      {events && events.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Historial de conversación</h2>
          <div className="space-y-3">
            {events.map((e: any) => (
              <div
                key={e.id}
                className={`rounded-lg p-3 text-sm ${
                  e.direction === "inbound"
                    ? "bg-green-500/10 border border-green-500/20 ml-0 mr-12"
                    : "bg-blue-500/10 border border-blue-500/20 ml-12 mr-0"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-gray-400">
                    {e.direction === "inbound" ? "📩 Lead" : "✉️ Tú"} · {e.event_type}
                  </span>
                  <span className="text-xs text-gray-500">
                    {e.sent_at ? new Date(e.sent_at).toLocaleString("es-MX") : ""}
                  </span>
                </div>
                <p className="text-white whitespace-pre-wrap">{e.content}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Notas</h2>
        {notes && notes.length > 0 ? (
          <div className="space-y-2">
            {notes.map((n: any) => (
              <div key={n.id} className="bg-gray-800/50 rounded-lg p-3 text-sm">
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>{n.author}</span>
                  <span>{new Date(n.created_at).toLocaleString("es-MX")}</span>
                </div>
                <p className="text-white">{n.content}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-500 text-sm">Sin notas aún.</p>
        )}
      </div>
    </div>
  )
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-sm text-white mt-0.5">{value}</p>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <dt className="text-gray-500">{label}</dt>
      <dd className="col-span-2 text-white">{value}</dd>
    </div>
  )
}
