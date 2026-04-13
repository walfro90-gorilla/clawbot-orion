import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Sidebar } from "@/components/sidebar"
import { AlertBanner } from "@/components/alert-banner"
import { GuidedTour } from "@/components/guided-tour"
import type { AccountAlert } from "@/components/alert-banner"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // Usar admin client para el perfil — evita recursión en RLS
  const admin = createAdminClient()
  const { data: profile } = await admin
    .from("profiles")
    .select("email, role, linkedin_account_id, onboarded_at")
    .eq("id", user.id)
    .single()

  // Cargar alertas no resueltas y conteo de conversaciones no vistas en paralelo
  const [{ data: alerts }, { count: unreadCount }] = await Promise.all([
    supabase
      .from("account_alerts")
      .select("id, alert_type, severity, message, details, auto_paused, created_at, linkedin_account_id, campaign_id")
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(20),
    // Conversaciones activas (leads que han respondido) — muestra badge en sidebar
    profile?.role === "user" && profile?.linkedin_account_id
      ? admin
          .from("conversations")
          .select("id", { count: "exact", head: true })
          .eq("linkedin_account_id", profile.linkedin_account_id)
          .eq("status", "active")
      : admin
          .from("conversations")
          .select("id", { count: "exact", head: true })
          .eq("status", "active"),
  ])

  const unresolvedAlerts = (alerts ?? []) as AccountAlert[]
  const showTour = !profile?.onboarded_at

  return (
    <div className="flex min-h-screen bg-gray-950">
      <Sidebar
        email={profile?.email ?? user.email}
        role={profile?.role ?? "user"}
        alertCount={unresolvedAlerts.filter(a => a.severity === "critical").length}
        unreadCount={unreadCount ?? 0}
      />
      <main className="flex-1 overflow-auto pt-12 sm:pt-0">
        <AlertBanner initialAlerts={unresolvedAlerts} />
        {children}
      </main>
      {showTour && <GuidedTour show={true} role={profile?.role ?? "user"} />}
    </div>
  )
}
