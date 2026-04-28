import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"

export type UserRole = "god_admin" | "admin" | "user" | "viewer"

export const ROLE_LEVEL: Record<UserRole, number> = {
  god_admin: 4,
  admin:     3,
  user:      2,
  viewer:    1,
}

/** Obtiene el usuario actual y su rol via admin client (sin RLS, sin recursión) */
export async function getSessionUser() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  // Usar admin client para el perfil — evita recursión en RLS
  const admin = createAdminClient()
  const { data: profile } = await admin
    .from("profiles")
    .select("id, email, role, company_name, linkedin_account_id")
    .eq("id", user.id)
    .single()

  return profile ?? null
}

/** Requiere al menos el nivel de rol indicado, redirige si no cumple */
export async function requireRole(minRole: UserRole) {
  const profile = await getSessionUser()
  if (!profile) redirect("/login")

  const level = ROLE_LEVEL[profile.role as UserRole] ?? 0
  if (level < ROLE_LEVEL[minRole]) redirect("/dashboard")

  return profile
}
