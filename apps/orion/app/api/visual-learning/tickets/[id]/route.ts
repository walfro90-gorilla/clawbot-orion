export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

// GET /api/visual-learning/tickets/[id]
// Detalle del ticket: screenshot, dom_snapshot, pins existentes.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params
  const id = parseInt(idStr)
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400, headers: CORS })
  }
  const admin = createAdminClient() as any

  // Refresh signed URL si está caducada
  const { data: ticket, error: tkErr } = await admin
    .from("selector_tickets")
    .select("*")
    .eq("id", id)
    .single()
  if (tkErr || !ticket) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: CORS })
  }
  // Renovar signed URL si el path existe
  if (ticket.screenshot_path) {
    const { data: signed } = await admin.storage
      .from("selector-screenshots")
      .createSignedUrl(ticket.screenshot_path, 24 * 3600)
    if (signed?.signedUrl) ticket.screenshot_url = signed.signedUrl
  }

  const { data: pins } = await admin
    .from("selector_pins")
    .select("*")
    .eq("ticket_id", id)
    .order("created_at", { ascending: true })

  return NextResponse.json({ ticket, pins: pins ?? [] }, { headers: CORS })
}

// PATCH /api/visual-learning/tickets/[id]
// Body: { status?, resolution_note?, resolved_by? }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params
  const id = parseInt(idStr)
  const body = await req.json().catch(() => ({}))
  const admin = createAdminClient() as any
  const updates: any = {}
  if (body.status) updates.status = body.status
  if (body.resolution_note) updates.resolution_note = body.resolution_note
  if (body.resolved_by) updates.resolved_by = body.resolved_by
  if (body.status === "resolved" || body.status === "dismissed") {
    updates.resolved_at = new Date().toISOString()
  }
  const { error } = await admin.from("selector_tickets").update(updates).eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS })
  return NextResponse.json({ ok: true, id, updates }, { headers: CORS })
}
