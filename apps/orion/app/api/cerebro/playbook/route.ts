export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"

const ROLE_LEVEL: Record<string, number> = { god_admin: 4, admin: 3, user: 2, viewer: 1 }

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { user: null, admin: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }

  const admin = createAdminClient()
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single()
  if ((ROLE_LEVEL[profile?.role ?? ""] ?? 0) < 3) {
    return { user: null, admin: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }

  return { user, admin, error: null }
}

// GET /api/cerebro/playbook — list all entries, admin only
export async function GET() {
  const { admin, error } = await requireAdmin()
  if (error) return error

  const { data, error: dbErr } = await admin!
    .from("ai_playbook")
    .select("*")
    .order("created_at", { ascending: false })

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  return NextResponse.json({ data })
}

// POST /api/cerebro/playbook — admins crean entradas ACTIVAS (ámbito libre).
// (3-ago) Modo propuesta: rol `user` con cuenta ligada también puede crear, pero la
// entrada nace INACTIVA y solo en una campaña SUYA — un admin la revisa y la activa
// con el toggle. El gate de calidad del Cerebro sigue siendo del admin.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const admin = createAdminClient()
  const { data: profile } = await admin
    .from("profiles").select("role, linkedin_account_id").eq("id", user.id).single()
  const level = ROLE_LEVEL[profile?.role ?? ""] ?? 0
  if (level < 2) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const isProposal = level < 3   // user → propuesta; admin/god_admin → entrada directa

  const body = await req.json()
  const {
    title,
    description,
    tags,
    situation,
    example_message,
    applies_to_turns,
    campaign_id,
    kind,
  } = body as {
    title: string
    description?: string
    tags: string[]
    situation?: string
    example_message: string
    applies_to_turns: number[]
    campaign_id?: string | null
    kind?: string
  }

  const entryKind = kind ?? "example"
  if (!["principle", "example", "objection"].includes(entryKind)) {
    return NextResponse.json({ error: "kind must be principle|example|objection" }, { status: 400 })
  }
  if (!title?.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 })
  }
  if (!example_message?.trim()) {
    return NextResponse.json({ error: "example_message is required" }, { status: 400 })
  }
  // Los principios se inyectan siempre (no se recuperan por turno) → applies_to_turns no aplica.
  if (entryKind !== "principle" && (!Array.isArray(applies_to_turns) || applies_to_turns.length === 0)) {
    return NextResponse.json({ error: "applies_to_turns must be a non-empty array" }, { status: 400 })
  }

  // Propuesta de rol user: campaña OBLIGATORIA y tiene que ser SUYA (nada global).
  if (isProposal) {
    if (!campaign_id?.trim()) {
      return NextResponse.json({ error: "Como usuario debes elegir una de tus campañas (sin ámbito global)" }, { status: 400 })
    }
    if (!profile?.linkedin_account_id) {
      return NextResponse.json({ error: "Tu usuario no tiene cuenta LinkedIn ligada" }, { status: 403 })
    }
    const { data: own } = await admin
      .from("campaigns").select("id")
      .eq("id", campaign_id).eq("linkedin_account_id", profile.linkedin_account_id)
      .maybeSingle()
    if (!own) return NextResponse.json({ error: "Esa campaña no pertenece a tu cuenta" }, { status: 403 })
  }

  const { data, error: dbErr } = await admin!
    .from("ai_playbook")
    .insert({
      // Propuesta nace inactiva → un admin la activa tras revisarla. Admin nace activa.
      is_active: !isProposal,
      title: title.trim(),
      description: description?.trim() ?? null,
      tags: Array.isArray(tags) ? tags : [],
      situation: situation?.trim() ?? null,
      example_message: example_message.trim(),
      applies_to_turns: entryKind === "principle" ? [] : applies_to_turns,
      campaign_id: campaign_id?.trim() ? campaign_id : null,   // vacío = global
      kind: entryKind,
      created_by: user!.id,
    } as any)   // campaign_id/kind nuevos; db-types se regeneran con `npm run types`
    .select()
    .single()

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  return NextResponse.json({ data }, { status: 201 })
}
