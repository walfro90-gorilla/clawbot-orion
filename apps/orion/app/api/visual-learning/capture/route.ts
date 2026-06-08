export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-orion-api-key",
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

// POST /api/visual-learning/capture
// Body: {
//   accountId, phaseName, source, commandId, urlAtCapture,
//   viewport: { width, height, scrollY },
//   domSnapshot: [{tag, attrs, rect, ...}],
//   capturedAt,
//   screenshotDataUrl: 'data:image/png;base64,...'
// }
//
// Crea selector_ticket + sube screenshot a Storage bucket.
export async function POST(req: NextRequest) {
  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS })
  }
  const apiKey = req.headers.get("x-orion-api-key")
  const {
    accountId, phaseName, source, commandId, urlAtCapture,
    viewport, domSnapshot, capturedAt, screenshotDataUrl,
  } = body ?? {}
  if (!accountId || !phaseName || !screenshotDataUrl) {
    return NextResponse.json({ error: "missing_required_fields" }, { status: 400, headers: CORS })
  }

  const admin = createAdminClient() as any

  // 1. Auth: verificar apiKey de la cuenta
  const { data: account } = await admin
    .from("linkedin_accounts")
    .select("id, label, extension_api_key")
    .eq("id", accountId)
    .single()
  if (!account || account.extension_api_key !== apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS })
  }

  // 2. Dedup: si ya hay un ticket abierto para esta phase en últimos 30min, skip
  const recentCutoff = new Date(Date.now() - 30 * 60_000).toISOString()
  const { data: existingTicket } = await admin
    .from("selector_tickets")
    .select("id, created_at")
    .eq("phase_name", phaseName)
    .eq("status", "open")
    .gte("created_at", recentCutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existingTicket) {
    return NextResponse.json({
      ok: true, dedup: true, ticketId: existingTicket.id,
      note: "ticket abierto reciente para esta phase ya existe — skipping",
    }, { headers: CORS })
  }

  // 3. Convertir dataURL a Buffer
  const match = String(screenshotDataUrl).match(/^data:(image\/\w+);base64,(.+)$/)
  if (!match) {
    return NextResponse.json({ error: "invalid_dataurl" }, { status: 400, headers: CORS })
  }
  const mimeType = match[1]
  const buffer = Buffer.from(match[2], "base64")
  const ext = mimeType === "image/png" ? "png" : "jpg"

  // 4. Upload a Supabase Storage
  const timestamp = Date.now()
  const path = `${accountId}/${phaseName}/${timestamp}.${ext}`
  const { error: upErr } = await admin.storage
    .from("selector-screenshots")
    .upload(path, buffer, { contentType: mimeType, upsert: false })
  if (upErr) {
    return NextResponse.json({ error: `storage_upload_failed: ${upErr.message}` }, { status: 500, headers: CORS })
  }
  // Generar signed URL para acceso (24h)
  const { data: signed } = await admin.storage
    .from("selector-screenshots")
    .createSignedUrl(path, 24 * 3600)
  const screenshotUrl = signed?.signedUrl ?? null

  // 5. Insertar ticket
  const { data: ticket, error: tkErr } = await admin
    .from("selector_tickets")
    .insert({
      account_id: accountId,
      phase_name: phaseName,
      trigger_source: source ?? "auto_threshold",
      command_id: commandId ?? null,
      screenshot_url: screenshotUrl,
      screenshot_path: path,
      viewport_width: viewport?.width ?? null,
      viewport_height: viewport?.height ?? null,
      scroll_y: viewport?.scrollY ?? null,
      dom_snapshot: domSnapshot ?? null,
      url_at_capture: urlAtCapture ?? null,
      status: "open",
    })
    .select("id")
    .single()
  if (tkErr) {
    return NextResponse.json({ error: `ticket_insert_failed: ${tkErr.message}` }, { status: 500, headers: CORS })
  }

  console.log(`[VL] ✅ ticket #${ticket.id} created for ${account.label} / phase ${phaseName}`)
  return NextResponse.json({
    ok: true, ticketId: ticket.id, screenshotUrl,
    domElementsCount: Array.isArray(domSnapshot) ? domSnapshot.length : 0,
  }, { headers: CORS })
}
