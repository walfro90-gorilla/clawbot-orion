import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { getSessionUser } from "@/lib/auth/role"
import { MeetingsCalendar, type MeetingItem } from "@/components/meetings-calendar"

export default async function MeetingsPage() {
  const supabase = await createClient()
  const admin    = createAdminClient()
  const me       = await getSessionUser()
  const isRestricted = me?.role === "user" || me?.role === "viewer"

  // ── Restrict to account's campaigns if non-admin ──────────────────────────
  let campaignFilter: string[] | null = null
  if (isRestricted && me?.linkedin_account_id) {
    const { data: camps } = await admin
      .from("campaigns")
      .select("id")
      .eq("linkedin_account_id", me.linkedin_account_id)
    campaignFilter = (camps ?? []).map((c: any) => c.id)
  }

  // ── Source 1: appointments table (created by cal-webhook) ─────────────────
  let appointmentsQuery = admin
    .from("appointments")
    .select(`
      id, lead_id, scheduled_at, duration_min, meeting_url, location, status,
      leads ( id, full_name, linkedin_url, campaign_id,
        campaigns ( name )
      )
    `)
    .order("scheduled_at", { ascending: false })
    .limit(200)

  // ── Source 2: leads with meeting_at (legacy / direct updates) ────────────
  let leadsQuery = admin
    .from("leads")
    .select(`id, full_name, linkedin_url, campaign_id, meeting_at, meeting_url, campaigns ( name )`)
    .not("meeting_at", "is", null)
    .order("meeting_at", { ascending: false })
    .limit(200)

  if (campaignFilter !== null) {
    if (campaignFilter.length === 0) {
      // No campaigns for this account → no meetings
      return <EmptyPage noAccount />
    }
    appointmentsQuery = appointmentsQuery.in("leads.campaign_id", campaignFilter) as any
    leadsQuery        = leadsQuery.in("campaign_id", campaignFilter)
  }

  const [{ data: appts }, { data: leadsWithMeeting }] = await Promise.all([
    appointmentsQuery,
    leadsQuery,
  ])

  // ── Merge & deduplicate by lead_id ────────────────────────────────────────
  const seen = new Set<string>()
  const meetings: MeetingItem[] = []

  for (const a of appts ?? []) {
    const lead = (a as any).leads
    if (!lead?.id) continue
    if (seen.has(lead.id)) continue
    seen.add(lead.id)
    meetings.push({
      id:           a.id,
      leadId:       lead.id,
      leadName:     lead.full_name ?? "Sin nombre",
      linkedinUrl:  lead.linkedin_url ?? null,
      campaignName: lead.campaigns?.name ?? null,
      scheduledAt:  a.scheduled_at,
      durationMin:  a.duration_min ?? 30,
      meetingUrl:   a.meeting_url ?? null,
      location:     a.location ?? null,
      status:       a.status ?? null,
    })
  }

  for (const l of leadsWithMeeting ?? []) {
    if (!l.meeting_at || seen.has(l.id)) continue
    seen.add(l.id)
    meetings.push({
      id:           `lead-${l.id}`,
      leadId:       l.id,
      leadName:     l.full_name ?? "Sin nombre",
      linkedinUrl:  l.linkedin_url ?? null,
      campaignName: (l as any).campaigns?.name ?? null,
      scheduledAt:  l.meeting_at,
      durationMin:  30,
      meetingUrl:   l.meeting_url ?? null,
      location:     null,
      status:       null,
    })
  }

  meetings.sort((a, b) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime())

  const upcoming = meetings.filter(m => new Date(m.scheduledAt) >= new Date())
  const past     = meetings.filter(m => new Date(m.scheduledAt) < new Date())

  return (
    <div className="p-4 sm:p-8 space-y-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-50">Reuniones</h1>
          <p className="text-gray-400 text-sm mt-1">
            {upcoming.length} próxima{upcoming.length !== 1 ? "s" : ""} · {past.length} pasada{past.length !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      {/* Calendar component */}
      <MeetingsCalendar meetings={meetings} />

      {/* Google Calendar setup CTA */}
      <GCalSetup />
    </div>
  )
}

// ── Google Calendar setup instructions ───────────────────────────────────────
function GCalSetup() {
  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-xl">📆</span>
        <h2 className="text-sm font-semibold text-gray-200">Sincronizar con Google Calendar</h2>
      </div>

      <p className="text-sm text-gray-400">
        Cada reunión tiene un botón <strong className="text-gray-200">📅 Google Cal</strong> que la agrega
        directamente a tu Google Calendar con un clic — sin OAuth, sin configuración extra.
      </p>

      <div className="border-t border-gray-800 pt-4">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Sincronización bidireccional automática (recomendado)
        </p>
        <p className="text-sm text-gray-400 mb-3">
          Conecta Google Calendar en Cal.com y <strong className="text-gray-200">todas las reuniones aparecerán
          automáticamente</strong> en tu Google Calendar — sin hacer nada más:
        </p>
        <ol className="space-y-2">
          {[
            ["Abre Cal.com", "Ve a app.cal.com → Settings → Calendars"],
            ["Conecta Google Calendar", "Haz clic en \"Add → Google Calendar\" y autoriza el acceso"],
            ["Selecciona el calendario destino", "Elige en qué calendario de Google quieres que aparezcan las reuniones"],
            ["Listo", "Cada booking de Cal.com aparecerá automáticamente en tu Google Calendar con todos los detalles"],
          ].map(([step, desc], i) => (
            <li key={step} className="flex gap-3 text-sm">
              <span className="w-5 h-5 rounded-full bg-blue-600/20 border border-blue-500/30 text-blue-400 text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                {i + 1}
              </span>
              <div>
                <span className="text-gray-200 font-medium">{step}</span>
                <span className="text-gray-500"> — {desc}</span>
              </div>
            </li>
          ))}
        </ol>
        <a
          href="https://app.cal.com/settings/my-account/calendars"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 mt-4 text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg transition-colors font-medium"
        >
          Abrir Cal.com → Calendarios ↗
        </a>
      </div>

      <div className="border-t border-gray-800 pt-4">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          ¿Por qué este enfoque?
        </p>
        <div className="grid sm:grid-cols-3 gap-3">
          {[
            ["🔄 Bidireccional", "Cal.com bloquea tu disponibilidad en GCal. GCal bloquea slots en Cal.com. Cero conflictos."],
            ["🔔 Notificaciones", "Google Calendar envía recordatorios automáticos a ambas partes."],
            ["📱 Móvil", "Las reuniones aparecen en la app de Google Calendar en tu teléfono."],
          ].map(([icon, desc]) => (
            <div key={icon} className="bg-gray-800/50 rounded-lg p-3 text-xs text-gray-400">
              <p className="font-medium text-gray-200 mb-1">{icon}</p>
              {desc}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ── No account fallback ───────────────────────────────────────────────────────
function EmptyPage({ noAccount }: { noAccount?: boolean }) {
  return (
    <div className="p-8 space-y-6">
      <h1 className="text-2xl font-bold text-gray-50">Reuniones</h1>
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
        <p className="text-4xl mb-3">📅</p>
        <p className="text-gray-400 text-sm">
          {noAccount ? "Sin campañas asignadas a tu cuenta." : "Sin reuniones agendadas."}
        </p>
      </div>
    </div>
  )
}
