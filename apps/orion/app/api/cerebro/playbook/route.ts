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

// POST /api/cerebro/playbook — create new entry, admin only
export async function POST(req: NextRequest) {
  const { user, admin, error } = await requireAdmin()
  if (error) return error

  const body = await req.json()
  const {
    title,
    description,
    tags,
    situation,
    example_message,
    applies_to_turns,
  } = body as {
    title: string
    description?: string
    tags: string[]
    situation?: string
    example_message: string
    applies_to_turns: number[]
  }

  if (!title?.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 })
  }
  if (!example_message?.trim()) {
    return NextResponse.json({ error: "example_message is required" }, { status: 400 })
  }
  if (!Array.isArray(applies_to_turns) || applies_to_turns.length === 0) {
    return NextResponse.json({ error: "applies_to_turns must be a non-empty array" }, { status: 400 })
  }

  const { data, error: dbErr } = await admin!
    .from("ai_playbook")
    .insert({
      title: title.trim(),
      description: description?.trim() ?? null,
      tags: Array.isArray(tags) ? tags : [],
      situation: situation?.trim() ?? null,
      example_message: example_message.trim(),
      applies_to_turns,
      created_by: user!.id,
    })
    .select()
    .single()

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  return NextResponse.json({ data }, { status: 201 })
}
