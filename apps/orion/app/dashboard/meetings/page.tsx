import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/auth/role"
import Link from "next/link"

export default async function MeetingsPage() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const me = await getSessionUser()
  const isRestricted = me?.role === "user" || me?.role === "viewer"

  // Query leads with meeting_booked status (or meeting_at set)
  let query = admin
    .from("leads")
    .select(`
      id, full_name, linkedin_url, status, meeting_at, meeting_url,
      campaigns ( name, linkedin_account_id )
    `)
    .not("meeting_at", "is", null)
    .order("meeting_at", { ascending: false })
    .limit(100)

  // Restrict for role=user to their account's campaigns
  if (isRestricted && me?.linkedin_account_id) {
    const { data: accountCampaigns } = await admin
      .from("campaigns")
      .select("id")
      .eq("linkedin_account_id", me.linkedin_account_id)
    const campaignIds = (accountCampaigns ?? []).map((c: any) => c.id)
    if (campaignIds.length > 0) {
      query = query.in("campaign_id", campaignIds)
    } else {
      return (
        <div className="p-8">
          <p className="text-gray-500">Sin reuniones asignadas a tu cuenta.</p>
        </div>
      )
    }
  }

  const { data: meetings } = await query
  const list = meetings ?? []

  const upcoming = list.filter(m => m.meeting_at && new Date(m.meeting_at) >= new Date())
  const past     = list.filter(m => m.meeting_at && new Date(m.meeting_at) < new Date())

  function MeetingRow({ m }: { m: any }) {
    const campaign = m.campaigns
    const meetingDate = m.meeting_at ? new Date(m.meeting_at) : null
    const isPast = meetingDate && meetingDate < new Date()

    return (
      <tr className="hover:bg-gray-800/50 transition-colors">
        <td className="px-4 py-3">
          <Link
            href={`/dashboard/conversations/${m.id}`}
            className="text-white hover:text-blue-400 font-medium"
          >
            {m.full_name ?? "Sin nombre"}
          </Link>
          {m.linkedin_url && (
            <div className="text-gray-500 text-xs mt-0.5 truncate max-w-[180px]">
              {m.linkedin_url.replace("https://www.linkedin.com/in/", "")}
            </div>
          )}
        </td>
        <td className="px-4 py-3 text-gray-400 text-xs">
          {campaign?.name ?? "—"}
        </td>
        <td className="px-4 py-3">
          {meetingDate ? (
            <div>
              <div className="text-white text-sm">
                {meetingDate.toLocaleDateString("es-MX", {
                  weekday: "short", day: "numeric", month: "short", year: "numeric",
                })}
              </div>
              <div className="text-gray-400 text-xs">
                {meetingDate.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })} hora MX
              </div>
            </div>
          ) : "—"}
        </td>
        <td className="px-4 py-3">
          {m.meeting_url ? (
            <a
              href={m.meeting_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 text-xs underline"
            >
              Abrir link
            </a>
          ) : (
            <span className="text-gray-600 text-xs">—</span>
          )}
        </td>
        <td className="px-4 py-3">
          <span className={`text-xs px-2 py-1 rounded-full border font-medium ${
            isPast
              ? "bg-gray-500/15 text-gray-400 border-gray-500/30"
              : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
          }`}>
            {isPast ? "Pasada" : "Próxima"}
          </span>
        </td>
        <td className="px-4 py-3">
          <Link
            href={`/dashboard/conversations/${m.id}`}
            className="text-xs text-gray-500 hover:text-blue-400 transition-colors"
          >
            Ver hilo →
          </Link>
        </td>
      </tr>
    )
  }

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Reuniones</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          {upcoming.length} próxima{upcoming.length !== 1 ? "s" : ""} · {past.length} pasada{past.length !== 1 ? "s" : ""}
        </p>
      </div>

      {list.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <p className="text-4xl mb-3">📅</p>
          <p className="text-white font-semibold">Sin reuniones agendadas</p>
          <p className="text-gray-400 text-sm mt-1">
            Las reuniones aparecerán aquí cuando un lead agende a través del link de Cal.com.
          </p>
        </div>
      ) : (
        <>
          {upcoming.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-gray-400 text-xs uppercase tracking-wider font-medium">Próximas reuniones</h2>
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
                        <th className="px-4 py-3 text-left font-medium">Lead</th>
                        <th className="px-4 py-3 text-left font-medium">Campaña</th>
                        <th className="px-4 py-3 text-left font-medium">Fecha y hora</th>
                        <th className="px-4 py-3 text-left font-medium">Link</th>
                        <th className="px-4 py-3 text-left font-medium">Estado</th>
                        <th className="px-4 py-3 text-left font-medium"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {upcoming.map(m => <MeetingRow key={m.id} m={m} />)}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {past.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-gray-400 text-xs uppercase tracking-wider font-medium">Reuniones pasadas</h2>
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
                        <th className="px-4 py-3 text-left font-medium">Lead</th>
                        <th className="px-4 py-3 text-left font-medium">Campaña</th>
                        <th className="px-4 py-3 text-left font-medium">Fecha y hora</th>
                        <th className="px-4 py-3 text-left font-medium">Link</th>
                        <th className="px-4 py-3 text-left font-medium">Estado</th>
                        <th className="px-4 py-3 text-left font-medium"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {past.map(m => <MeetingRow key={m.id} m={m} />)}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
