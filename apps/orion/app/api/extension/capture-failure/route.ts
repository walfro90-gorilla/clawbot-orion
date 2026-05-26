export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-orion-api-key",
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

// POST body:
// {
//   accountId, apiKey,
//   commandId, action, error, reason?, url?, extVersion?,
//   leadId?,
//   screenshotBase64?,   // PNG, sin prefijo data:
//   domSnippet?,         // jsonb arbitrario
// }
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: CORS })
  }

  const accountId = body.accountId as string | undefined
  const apiKey    = (req.headers.get("x-orion-api-key") ?? body.apiKey) as string | undefined
  if (!accountId || !apiKey) {
    return NextResponse.json({ error: "missing_credentials" }, { status: 400, headers: CORS })
  }

  const admin = createAdminClient()
  const { data: account } = await admin
    .from("linkedin_accounts")
    .select("id, extension_api_key")
    .eq("id", accountId)
    .single()
  if (!account || account.extension_api_key !== apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS })
  }

  const action = body.action as string | undefined
  const errorCode = body.error as string | undefined
  if (!action || !errorCode) {
    return NextResponse.json({ error: "action and error required" }, { status: 400, headers: CORS })
  }

  // Dedup: si en últimas 4h hay una fila con misma combinación (action+error+lead+account)
  // sin etiquetar, incrementa el counter en vez de crear nueva fila.
  const fourHoursAgo = new Date(Date.now() - 4 * 3600 * 1000).toISOString()
  const { data: existing } = await admin
    .from("ui_pattern_failures")
    .select("id, occurrence_count")
    .eq("account_id", accountId)
    .eq("action", action)
    .eq("error", errorCode)
    .in("status", ["pending"])
    .gte("created_at", fourHoursAgo)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existing) {
    await admin
      .from("ui_pattern_failures")
      .update({
        occurrence_count: (existing.occurrence_count ?? 1) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
    return NextResponse.json({ ok: true, deduped: true, id: existing.id }, { headers: CORS })
  }

  // Upload screenshot a Supabase Storage (si viene)
  let screenshotPath: string | null = null
  const b64 = body.screenshotBase64 as string | undefined
  if (b64) {
    try {
      const buf = Buffer.from(b64, "base64")
      // 5MB cap
      if (buf.byteLength > 5 * 1024 * 1024) {
        return NextResponse.json({ error: "screenshot_too_large" }, { status: 413, headers: CORS })
      }
      const filename = `${accountId}/${action}_${errorCode}_${Date.now()}.png`
      const { error: upErr } = await admin.storage
        .from("ui-failures")
        .upload(filename, buf, { contentType: "image/png", upsert: false })
      if (upErr) {
        console.error("[capture-failure] storage upload error:", upErr.message)
      } else {
        screenshotPath = filename
      }
    } catch (err) {
      console.error("[capture-failure] screenshot decode error:", err)
    }
  }

  const insertRow = {
    command_id:      (body.commandId as string) ?? null,
    account_id:      accountId,
    related_lead_id: (body.leadId as string) ?? null,
    action,
    error:           errorCode,
    reason:          (body.reason as string) ?? null,
    url:             (body.url as string) ?? null,
    ext_version:     (body.extVersion as string) ?? null,
    screenshot_path: screenshotPath,
    dom_snippet:     (body.domSnippet ?? null) as never,
  }
  const { data: row, error: insErr } = await admin
    .from("ui_pattern_failures")
    .insert(insertRow)
    .select("id")
    .single()

  if (insErr) {
    return NextResponse.json({ error: insErr.message }, { status: 500, headers: CORS })
  }
  return NextResponse.json({ ok: true, id: row?.id, screenshotPath }, { headers: CORS })
}
