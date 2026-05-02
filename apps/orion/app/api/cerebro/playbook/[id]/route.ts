export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"

const ROLE_LEVEL: Record<string, number> = { god_admin: 4, admin: 3, user: 2, viewer: 1 }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { admin: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }

  const admin = createAdminClient()
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single()
  if ((ROLE_LEVEL[profile?.role ?? ""] ?? 0) < 3) {
    return { admin: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }

  return { admin, error: null }
}

// PATCH /api/cerebro/playbook/[id] — update entry, admin only
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { admin, error } = await requireAdmin()
  if (error) return error

  const { id } = await params
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  const body = await req.json()
  const {
    title,
    description,
    tags,
    situation,
    example_message,
    applies_to_turns,
    is_active,
    outcome,
  } = body as {
    title?: string
    description?: string
    tags?: string[]
    situation?: string
    example_message?: string
    applies_to_turns?: number[]
    is_active?: boolean
    outcome?: string
  }

  type PlaybookUpdate = {
    title?: string
    description?: string | null
    tags?: string[]
    situation?: string | null
    example_message?: string
    applies_to_turns?: number[]
    is_active?: boolean
    outcome?: string
  }
  const patch: PlaybookUpdate = {}
  if (title !== undefined)            patch.title = title.trim()
  if (description !== undefined)      patch.description = description?.trim() ?? null
  if (tags !== undefined)             patch.tags = Array.isArray(tags) ? tags : []
  if (situation !== undefined)        patch.situation = situation?.trim() ?? null
  if (example_message !== undefined)  patch.example_message = example_message.trim()
  if (applies_to_turns !== undefined) patch.applies_to_turns = applies_to_turns
  if (is_active !== undefined)        patch.is_active = is_active
  if (outcome !== undefined)          patch.outcome = outcome

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 })
  }

  const { data, error: dbErr } = await admin!
    .from("ai_playbook")
    .update(patch as any)
    .eq("id", id)
    .select()
    .single()

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  return NextResponse.json({ data })
}

// DELETE /api/cerebro/playbook/[id] — hard delete, admin only
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { admin, error } = await requireAdmin()
  if (error) return error

  const { id } = await params
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  const { error: dbErr } = await admin!
    .from("ai_playbook")
    .delete()
    .eq("id", id)

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
