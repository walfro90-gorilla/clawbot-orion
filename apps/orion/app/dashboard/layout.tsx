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
    .select("email, role, linkedin_account_id, onboarded_at, onboarding_step")
    .eq("id", user.id)
    .single()

  // SEGURIDAD multi-tenant (fail-closed): un usuario restringido (user/viewer) DEBE tener
  // una cuenta LinkedIn vinculada. Sin ella, el scoping por linkedin_account_id de las
  // páginas se SALTARÍA (patrón `if (cuenta) filtrar(...)` fail-open, + admin client que
  // ignora RLS) → vería datos de TODAS las cuentas. Por eso, si un restringido no tiene
  // cuenta, NO entra al dashboard. (Admin/god_admin con cuenta NULL = global por diseño.)
  const isRestricted = profile?.role === "user" || profile?.role === "viewer"
  if (isRestricted && !profile?.linkedin_account_id) {
    redirect("/no-account")
  }

  // Onboarding gate (null-safe): un user nuevo con cuenta y onboarding pendiente va al wizard
  // self-serve (vive en /onboarding, fuera de este layout → sin loop). Usuarios existentes
  // tienen onboarding_step='done' (backfill) o null → nunca caen aquí. Admin/viewer tampoco.
  if (
    profile?.role === "user" &&
    profile?.onboarding_step === "pending" &&
    profile?.linkedin_account_id
  ) {
    redirect("/onboarding")
  }

  // Cargar alertas + conteos en paralelo (incluye auto-learning insights y visual tickets)
  const isAdmin = profile?.role === "god_admin" || profile?.role === "admin"
  const [{ data: alerts }, { count: unreadCount }, insightsResult, ticketsResult, postsResult] = await Promise.all([
    supabase
      .from("account_alerts")
      .select("id, alert_type, severity, message, details, auto_paused, created_at, linkedin_account_id, campaign_id")
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(20),
    isRestricted && profile?.linkedin_account_id
      ? admin
          .from("conversations")
          .select("id", { count: "exact", head: true })
          .eq("linkedin_account_id", profile.linkedin_account_id)
          .eq("status", "active")
      : admin
          .from("conversations")
          .select("id", { count: "exact", head: true })
          .eq("status", "active"),
    // Auto-learning insights pendientes (admin only)
    isAdmin
      ? (admin as any).from("phase_insights").select("id", { count: "exact", head: true }).eq("acknowledged", false)
      : Promise.resolve({ count: 0 }),
    // Visual tickets abiertos (admin only)
    isAdmin
      ? (admin as any).from("selector_tickets").select("id", { count: "exact", head: true }).eq("status", "open")
      : Promise.resolve({ count: 0 }),
    // Post-Prospecting: comentarios esperando revisión (admin only)
    isAdmin
      ? (admin as any).from("post_opportunities").select("id", { count: "exact", head: true }).eq("status", "pending_review")
      : Promise.resolve({ count: 0 }),
  ])
  const insightsCount = (insightsResult as any)?.count ?? 0
  const ticketsCount = (ticketsResult as any)?.count ?? 0
  // post_opportunities puede no existir aún (migración pendiente) → count 0 si error.
  const postsCount = (postsResult as any)?.count ?? 0

  // Deduplicate alerts: keep only the most recent per (account_id + alert_type).
  // Without this, recurring scheduler-generated alerts (e.g. cookie_expiry every
  // tick for the same account) pile up into 20+ duplicates polluting the UI.
  const allAlerts = (alerts ?? []) as AccountAlert[]
  const seen = new Set<string>()
  const unresolvedAlerts = allAlerts.filter(a => {
    const key = `${a.linkedin_account_id ?? "global"}::${a.alert_type}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const showTour = !profile?.onboarded_at

  return (
    <div className="flex min-h-screen bg-gray-950">
      <Sidebar
        email={profile?.email ?? user.email}
        role={profile?.role ?? "user"}
        alertCount={unresolvedAlerts.filter(a => a.severity === "critical").length}
        unreadCount={unreadCount ?? 0}
        insightsCount={insightsCount}
        ticketsCount={ticketsCount}
        postsCount={postsCount}
      />
      <main className="flex-1 overflow-auto pt-12 sm:pt-0">
        <AlertBanner initialAlerts={unresolvedAlerts} />
        {children}
      </main>
      {showTour && <GuidedTour show={true} role={profile?.role ?? "user"} />}
    </div>
  )
}
