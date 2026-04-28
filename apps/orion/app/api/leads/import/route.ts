export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { ROLE_LEVEL } from "@/lib/auth/role"
import { checkRateLimit } from "@/lib/rate-limit"
import { parse as csvParse } from "csv-parse/sync"

const MAX_CSV_BYTES = 5 * 1024 * 1024 // 5 MB

function parseCSV(text: string): Record<string, string>[] {
  try {
    const rows: Record<string, string>[] = csvParse(text, {
      columns: (headers: string[]) => headers.map(h => h.trim().toLowerCase().replace(/['"]/g, "")),
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
      relax_column_count: true,
    })
    return rows.filter(r => Object.values(r).some(v => v !== ""))
  } catch {
    return []
  }
}

function normalizeLinkedInUrl(raw: string): string | null {
  if (!raw) return null
  try {
    const url = raw.startsWith("http") ? new URL(raw) : new URL(`https://www.linkedin.com/${raw}`)
    const match = url.pathname.match(/\/in\/([^/?#]+)/)
    if (!match) return null
    return `https://www.linkedin.com/in/${match[1]}/`
  } catch {
    // Try /in/handle format directly
    const match = raw.match(/\/in\/([^/?#\s]+)/)
    if (match) return `https://www.linkedin.com/in/${match[1]}/`
    return null
  }
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const admin = createAdminClient()
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single()
  const userLevel = ROLE_LEVEL[profile?.role as keyof typeof ROLE_LEVEL] ?? 0
  if (userLevel < 3) return NextResponse.json({ error: "Forbidden — admins only" }, { status: 403 })

  // Rate limit: max 10 imports per user per hour
  const rl = checkRateLimit(`import:${user.id}`, 10, 60 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Demasiadas importaciones. Intenta en ${Math.ceil(rl.retryAfterMs / 60_000)} min.` },
      { status: 429 }
    )
  }

  let campaignId: string
  let csvText: string

  const contentType = req.headers.get("content-type") ?? ""

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData()
    campaignId = form.get("campaignId") as string
    const file = form.get("file") as File | null
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 })
    csvText = await file.text()
  } else {
    const body = await req.json()
    campaignId = body.campaignId
    csvText    = body.csv ?? ""
  }

  if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 })
  if (!csvText?.trim()) return NextResponse.json({ error: "Empty CSV" }, { status: 400 })
  if (Buffer.byteLength(csvText, "utf8") > MAX_CSV_BYTES) {
    return NextResponse.json({ error: "Archivo demasiado grande (máx 5 MB)" }, { status: 413 })
  }

  // Validate campaign exists and user can access it
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, name")
    .eq("id", campaignId)
    .single()
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 })

  const rows = parseCSV(csvText)
  if (rows.length === 0) return NextResponse.json({ error: "No valid rows in CSV" }, { status: 400 })
  if (rows.length > 500) return NextResponse.json({ error: "Max 500 rows per import" }, { status: 400 })

  // Check required column
  const sample = rows[0]
  const urlKey = Object.keys(sample).find(k => k.includes("linkedin") || k.includes("url") || k === "profile")
  const nameKey = Object.keys(sample).find(k => k.includes("name") || k === "nombre")

  if (!urlKey) {
    return NextResponse.json({
      error: `CSV must have a column with 'linkedin' or 'url' in its name. Found: ${Object.keys(sample).join(", ")}`
    }, { status: 400 })
  }

  let imported = 0
  let skipped  = 0
  const errors: string[] = []

  for (const row of rows) {
    const rawUrl  = row[urlKey]  ?? ""
    const rawName = nameKey ? (row[nameKey] ?? "") : ""
    const url     = normalizeLinkedInUrl(rawUrl)

    if (!url) { skipped++; continue }

    const urlSlug  = url.match(/\/in\/([^/]+)/)?.[1]?.replace(/-/g, " ")
    const fullName = rawName.trim() || (urlSlug ?? "Importado")

    // Check for duplicates in this campaign
    const { data: existing } = await admin
      .from("leads")
      .select("id")
      .eq("campaign_id", campaignId)
      .eq("linkedin_url", url)
      .maybeSingle()

    if (existing) { skipped++; continue }

    const { error: insertErr } = await admin.from("leads").insert({
      campaign_id:  campaignId,
      linkedin_url: url,
      full_name:    fullName,
      status:       "scraped",
    })

    if (insertErr) {
      errors.push(`${rawUrl}: ${insertErr.message}`)
      skipped++
    } else {
      imported++
    }
  }

  console.log(`[leads/import] campaign=${campaignId} imported=${imported} skipped=${skipped} by ${user.email}`)
  return NextResponse.json({ ok: true, imported, skipped, total: rows.length, errors: errors.slice(0, 5) })
}
