// lib/crm/auth-helper.ts
// Auth helper común para todas las rutas /api/crm/* — copia patrón release/route.ts
import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { ROLE_LEVEL, type UserRole } from "@/lib/auth/role"

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AuthOk = {
  ok: true
  userId: string
  email: string | null
  role: UserRole
  level: number
  accountId: string | null
  admin: ReturnType<typeof createAdminClient>
}

export type AuthErr = { ok: false; response: NextResponse }

/**
 * Authentica + autoriza por nivel mínimo + valida ownership por leadId (opcional).
 * @param minRole - rol mínimo requerido para esta ruta
 * @param leadId - si provisto y level < 3, valida que el lead.campaign.linkedin_account_id === user.linkedin_account_id
 */
export async function authorize(
  minRole: UserRole = "user",
  leadId?: string,
): Promise<AuthOk | AuthErr> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }

  const admin = createAdminClient()
  const { data: profile } = await admin
    .from("profiles")
    .select("id, email, role, linkedin_account_id")
    .eq("id", user.id)
    .single()

  const role = (profile?.role as UserRole) ?? "viewer"
  const level = ROLE_LEVEL[role] ?? 0
  const minLevel = ROLE_LEVEL[minRole]

  if (level < minLevel) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }

  // Ownership check para roles < admin
  if (leadId && level < 3) {
    if (!UUID_RE.test(leadId)) {
      return { ok: false, response: NextResponse.json({ error: "Invalid leadId" }, { status: 400 }) }
    }
    const { data: lead } = await admin
      .from("leads")
      .select("campaign_id, campaigns(linkedin_account_id)")
      .eq("id", leadId)
      .single()
    const leadAccountId = (lead?.campaigns as { linkedin_account_id?: string } | null)?.linkedin_account_id
    if (leadAccountId !== profile?.linkedin_account_id) {
      return { ok: false, response: NextResponse.json({ error: "Forbidden (account scope)" }, { status: 403 }) }
    }
  }

  return {
    ok: true,
    userId: user.id,
    email: profile?.email ?? user.email ?? null,
    role,
    level,
    accountId: profile?.linkedin_account_id ?? null,
    admin,
  }
}
