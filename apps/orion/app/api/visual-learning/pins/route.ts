export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

// POST /api/visual-learning/pins
// Body: { ticketId, pinX, pinY, label, promoteToLearned?: boolean }
//
// Resolución: usa pin.x,y + ticket.dom_snapshot para encontrar el elemento más
// profundo cuyo rect contiene (x,y). Genera selector estable. Opcional: promover
// inmediatamente a learned_selectors (auto-applied).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { ticketId, pinX, pinY, label, promoteToLearned } = body ?? {}
  if (!ticketId || pinX == null || pinY == null || !label) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400, headers: CORS })
  }
  const admin = createAdminClient() as any

  // 1. Cargar ticket + dom_snapshot
  const { data: ticket, error: tkErr } = await admin
    .from("selector_tickets")
    .select("id, phase_name, account_id, dom_snapshot, viewport_width, viewport_height")
    .eq("id", ticketId)
    .single()
  if (tkErr || !ticket) {
    return NextResponse.json({ error: "ticket_not_found" }, { status: 404, headers: CORS })
  }
  const snapshot = ticket.dom_snapshot as any[]
  if (!Array.isArray(snapshot)) {
    return NextResponse.json({ error: "no_dom_snapshot" }, { status: 400, headers: CORS })
  }

  // 2. Encontrar elemento más PROFUNDO cuyo rect contiene (x,y)
  //    Si imagen != viewport size, escalar. Asumimos que client pasó x/y en
  //    coordenadas DEL VIEWPORT original (no de la imagen).
  const candidates = snapshot.filter(el => {
    const r = el.rect
    if (!r) return false
    return pinX >= r.x && pinX <= (r.x + r.w) && pinY >= r.y && pinY <= (r.y + r.h)
  }).sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0))

  if (candidates.length === 0) {
    return NextResponse.json({
      error: "no_element_at_coords",
      hint: "Ningún elemento del DOM snapshot cae en (x,y). Verificar coordenadas.",
    }, { status: 400, headers: CORS })
  }

  const resolved = candidates[0]

  // 3. Generar selector estable del elemento resuelto
  const selector = generateStableSelector(resolved)
  const alternatives = candidates.slice(0, 3).map(c => generateStableSelector(c).primary).filter(Boolean)

  // 4. Insertar pin
  const { data: pin, error: pinErr } = await admin
    .from("selector_pins")
    .insert({
      ticket_id: ticketId,
      pin_x: pinX,
      pin_y: pinY,
      label,
      resolved_element: resolved,
      extracted_selector: selector.primary,
      selector_candidates: selector.candidates,
      confidence: selector.confidence,
    })
    .select("id")
    .single()
  if (pinErr) {
    return NextResponse.json({ error: pinErr.message }, { status: 500, headers: CORS })
  }

  // 5. Update ticket pin count
  await admin.rpc("noop_pin_increment").catch(() => {})  // optional, ignore if RPC doesn't exist
  await admin
    .from("selector_tickets")
    .update({ pinned_count: (ticket as any).pinned_count ? (ticket as any).pinned_count + 1 : 1 })
    .eq("id", ticketId)

  // 6. Promote: insert en learned_selectors
  let learned: any = null
  if (promoteToLearned && selector.primary) {
    const { data: ls } = await admin
      .from("learned_selectors")
      .upsert({
        label,
        phase_name: ticket.phase_name,
        selector: selector.primary,
        selector_alternatives: alternatives,
        source_pin_id: pin.id,
        source_ticket_id: ticketId,
        enabled: true,
        priority: 150,  // mayor que default 100 → se intenta antes que originales
      }, { onConflict: "label,phase_name,selector" })
      .select("id")
      .single()
    learned = ls
    await admin
      .from("selector_pins")
      .update({ applied_to_runtime: true })
      .eq("id", pin.id)
  }

  return NextResponse.json({
    ok: true,
    pinId: pin.id,
    resolved: { tag: resolved.tag, cls: resolved.cls, depth: resolved.depth },
    selector: selector.primary,
    alternatives,
    confidence: selector.confidence,
    learnedId: learned?.id ?? null,
  }, { headers: CORS })
}

// ── Helper: generar selector estable (réplica de la lógica del extension) ──
function generateStableSelector(el: any): { primary: string | null; candidates: string[]; confidence: number } {
  if (!el || !el.tag) return { primary: null, candidates: [], confidence: 0 }
  const candidates: { sel: string; score: number }[] = []
  const tag = el.tag
  const attrs = el.attrs ?? {}
  const cls = (el.cls ?? "").toString()

  if (attrs.id && !/^[a-z0-9]{8,}$/.test(attrs.id) && !attrs.id.startsWith("ember")) {
    candidates.push({ sel: `${tag}#${cssEscape(attrs.id)}`, score: 0.95 })
  }
  if (attrs["aria-label"] && attrs["aria-label"].length > 1 && attrs["aria-label"].length < 50) {
    candidates.push({ sel: `${tag}[aria-label="${attrs["aria-label"].replace(/"/g,'\\"')}" i]`, score: 0.9 })
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("data-") && typeof v === "string" && v.length < 50 && !/^[a-z0-9]{20,}$/.test(v)) {
      candidates.push({ sel: `${tag}[${k}="${v}"]`, score: 0.85 })
    }
  }
  const classes = cls.split(/\s+/).filter((c: string) =>
    c.length > 3 && c.length < 50 &&
    !/^[a-z0-9]{10,}$/.test(c) &&
    !c.startsWith("ember") &&
    (c.includes("-") || c.includes("_"))
  )
  const role = attrs.role
  if (role && classes.length > 0) candidates.push({ sel: `${tag}[role="${role}"].${classes[0]}`, score: 0.8 })
  else if (role) candidates.push({ sel: `${tag}[role="${role}"]`, score: 0.7 })
  if (classes.length > 0) {
    const topClass = classes.find((c: string) => c.includes("msg-") || c.includes("artdeco-")) ?? classes[0]
    candidates.push({ sel: `${tag}.${topClass}`, score: 0.65 })
    if (classes.length >= 2) candidates.push({ sel: `${tag}.${classes[0]}.${classes[1]}`, score: 0.7 })
  }
  if (el.editable) {
    const ariaPart = attrs["aria-label"] ? `[aria-label="${attrs["aria-label"].replace(/"/g,'\\"')}" i]` : ""
    candidates.push({ sel: `${tag}[contenteditable="true"]${ariaPart}`, score: 0.75 })
  }
  candidates.sort((a, b) => b.score - a.score)
  return {
    primary: candidates[0]?.sel ?? null,
    candidates: candidates.slice(0, 4).map(c => c.sel),
    confidence: candidates[0]?.score ?? 0,
  }
}

function cssEscape(s: string): string {
  return s.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, "\\$&")
}
