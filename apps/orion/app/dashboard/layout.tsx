import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Sidebar } from "@/components/sidebar"
import { AlertBanner } from "@/components/alert-banner"
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
    .select("email, role")
    .eq("id", user.id)
    .single()

  // Cargar alertas no resueltas (RLS filtra por cuentas del usuario)
  const { data: alerts } = await supabase
    .from("account_alerts")
    .select("id, alert_type, severity, message, details, auto_paused, created_at, linkedin_account_id, campaign_id")
    .is("resolved_at", null)
    .order("created_at", { ascending: false })
    .limit(20)

  const unresolvedAlerts = (alerts ?? []) as AccountAlert[]

  return (
    <div className="flex min-h-screen bg-gray-950">
      <Sidebar
        email={profile?.email ?? user.email}
        role={profile?.role ?? "user"}
        alertCount={unresolvedAlerts.filter(a => a.severity === "critical").length}
      />
      <main className="flex-1 overflow-auto">
        <AlertBanner initialAlerts={unresolvedAlerts} />
        {children}
      </main>
    </div>
  )
}
