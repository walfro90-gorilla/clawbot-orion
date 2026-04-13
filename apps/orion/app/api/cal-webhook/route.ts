export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import crypto from "crypto"

// Cal.com sends a HMAC-SHA256 signature in the X-Cal-Signature-256 header
// Set CALCOM_WEBHOOK_SECRET in your .env to verify authenticity
function verifyCalSignature(body: string, signature: string | null): boolean {
  const secret = process.env.CALCOM_WEBHOOK_SECRET
  if (!secret) return true // Skip verification if no secret configured
  if (!signature) return false
  const expected = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex")
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

// Extract LEAD_ID=<uuid> from any string field in the payload
function extractLeadId(text: string | null | undefined): string | null {
  if (!text) return null
  const match = text.match(/LEAD_ID=([0-9a-f-]{36})/i)
  return match?.[1] ?? null
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text()

  // Verify signature if secret is configured
  const signature = req.headers.get("x-cal-signature-256")
  if (!verifyCalSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // Only process BOOKING_CREATED events
  const triggerEvent = payload?.triggerEvent
  if (triggerEvent !== "BOOKING_CREATED") {
    return NextResponse.json({ ok: true, skipped: true, reason: `event=${triggerEvent}` })
  }

  const bookingPayload = payload?.payload ?? payload

  // Try to extract leadId from common Cal.com fields where we embed it
  const leadId =
    extractLeadId(bookingPayload?.description) ??
    extractLeadId(bookingPayload?.responses?.notes?.value) ??
    extractLeadId(bookingPayload?.metadata?.leadId) ??
    extractLeadId(bookingPayload?.additionalNotes) ??
    null

  if (!leadId) {
    console.warn("[cal-webhook] BOOKING_CREATED but no LEAD_ID found in payload")
    return NextResponse.json({ ok: true, skipped: true, reason: "no_lead_id" })
  }

  const meetingAt  = bookingPayload?.startTime ?? null
  const meetingUrl = bookingPayload?.videoCallData?.url
    ?? bookingPayload?.metadata?.videoCallUrl
    ?? bookingPayload?.location
    ?? null

  const admin = createAdminClient()

  // Update lead with meeting info
  const { error: leadErr } = await admin
    .from("leads")
    .update({
      status:     "meeting_booked",
      meeting_at: meetingAt,
      meeting_url: meetingUrl ?? null,
    })
    .eq("id", leadId)

  if (leadErr) {
    console.error("[cal-webhook] Failed to update lead:", leadErr.message)
    return NextResponse.json({ error: leadErr.message }, { status: 500 })
  }

  // Record meeting_booked in conversation_events
  const { data: conv } = await admin
    .from("conversations")
    .select("id")
    .eq("lead_id", leadId)
    .maybeSingle()

  if (conv?.id) {
    await admin.from("conversation_events").insert({
      conversation_id: conv.id,
      event_type:      "meeting_booked",
      direction:       "inbound",
      content:         `Reunión agendada para ${meetingAt ? new Date(meetingAt).toLocaleString("es-MX") : "fecha pendiente"}${meetingUrl ? ` — ${meetingUrl}` : ""}`,
      sent_at:         new Date().toISOString(),
    })
  }

  console.log(`[cal-webhook] Meeting booked for lead=${leadId} at=${meetingAt}`)
  return NextResponse.json({ ok: true, leadId })
}
