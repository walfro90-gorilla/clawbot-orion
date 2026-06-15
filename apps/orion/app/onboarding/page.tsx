import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { redirect } from "next/navigation"
import { OnboardingWizard } from "@/components/onboarding-wizard"

// Wizard self-serve de onboarding. Vive FUERA de /dashboard (root) para NO heredar el
// dashboard layout — así el gate de ese layout puede redirigir aquí sin loop.
// Solo lo ven users con onboarding_step='pending' y cuenta asignada; cualquier otro → /dashboard.

export default async function OnboardingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const admin = createAdminClient()
  const { data: profile } = await admin
    .from("profiles")
    .select("role, linkedin_account_id, onboarding_step")
    .eq("id", user.id)
    .single()

  // Solo el carril self-serve: user + pendiente + con cuenta. El resto fuera.
  if (
    !profile ||
    profile.role !== "user" ||
    profile.onboarding_step === "done" ||
    !profile.linkedin_account_id
  ) {
    redirect("/dashboard")
  }

  const accountId = profile.linkedin_account_id

  const { data: account } = await admin
    .from("linkedin_accounts")
    .select("id, label, linkedin_profile_url, extension_api_key")
    .eq("id", accountId)
    .single()
  if (!account) redirect("/dashboard")

  const { data: camps } = await admin
    .from("campaigns")
    .select("search_keywords, search_location, ai_sender_persona, target_audience, daily_invite_target")
    .eq("linkedin_account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(1)
  const campaign = camps?.[0] ?? null

  return (
    <OnboardingWizard
      accountId={account.id}
      accountLabel={account.label ?? "Tu cuenta"}
      apiKey={account.extension_api_key ?? null}
      profileUrl={account.linkedin_profile_url ?? null}
      campaign={campaign}
      downloadBaseUrl="http://209.50.63.149/download"
    />
  )
}
