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
      // La extensión ahora envía JPEG (más liviano). Detectamos por el header.
      const isJpeg = buf.length > 2 && buf[0] === 0xFF && buf[1] === 0xD8
      const ext = isJpeg ? "jpg" : "png"
      const filename = `${accountId}/${action}_${errorCode}_${Date.now()}.${ext}`
      const { error: upErr } = await admin.storage
        .from("ui-failures")
        .upload(filename, buf, { contentType: isJpeg ? "image/jpeg" : "image/png", upsert: false })
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

  // ── CEREBRO AI — ANÁLISIS EN CASCADA (barato → caro) ──────────────────────
  // Capa 1: etiqueta humana previa para este patrón  → $0, máxima autoridad.
  // Capa 2: heurística por código sobre el DOM snippet → $0, no requiere screenshot.
  // Capa 3: Gemini Vision → SOLO si las capas baratas no resolvieron Y hay screenshot.
  // Así no quemamos tokens de Gemini en fallos que el código ya sabe diagnosticar.
  let aiSource = "heuristic"
  let escalatedToGemini = false
  if (row?.id) {
    const humanFix  = await lookupHumanLabel(admin, action, errorCode)
    const heuristic = heuristicDiagnose(errorCode, action, body.domSnippet, body.url as string | undefined)
    const cheap = humanFix ?? heuristic
    aiSource = cheap.source

    await admin.from("ui_pattern_failures")
      .update({ ai_diagnosis: cheap as never, ai_analyzed_at: new Date().toISOString() })
      .eq("id", row.id)

    // Escalar a Gemini solo si: no hay fix humano, la heurística no está segura,
    // y tenemos screenshot + API key.
    const needsVision = !humanFix && heuristic.confidence < 0.7
    if (needsVision && b64 && process.env.GEMINI_API_KEY) {
      escalatedToGemini = true
      analyzeWithGeminiVision(row.id, b64, errorCode, action, body.domSnippet, admin)
        .catch(e => console.error("[capture-failure] gemini vision error:", e?.message ?? e))
    }
  }

  return NextResponse.json(
    { ok: true, id: row?.id, screenshotPath, aiSource, escalatedToGemini },
    { headers: CORS },
  )
}

// ── Tipo común de diagnóstico ────────────────────────────────────────────────
type Diagnosis = {
  source: "human_label" | "heuristic" | "gemini_vision"
  element_visible: boolean | null
  location_description: string | null
  likely_cause: string
  suggested_css_selector: string | null
  page_state: string
  confidence: number
  recommendation: string
}

// ── Capa 1: ¿ya etiquetó un humano este patrón? (action+error) ───────────────
async function lookupHumanLabel(
  admin: ReturnType<typeof createAdminClient>,
  action: string,
  errorCode: string,
): Promise<Diagnosis | null> {
  const { data } = await admin
    .from("ui_pattern_failures")
    .select("labeled_selector, labeled_notes")
    .eq("action", action)
    .eq("error", errorCode)
    .eq("status", "labeled")
    .not("labeled_selector", "is", null)
    .order("labeled_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data?.labeled_selector) return null
  return {
    source: "human_label",
    element_visible: true,
    location_description: null,
    likely_cause: "Patrón ya etiquetado por un humano anteriormente.",
    suggested_css_selector: data.labeled_selector,
    page_state: "loaded_ok",
    confidence: 0.95,
    recommendation: data.labeled_notes
      ? `Usar selector etiquetado. Nota: ${data.labeled_notes}`
      : "Usar el selector etiquetado previamente.",
  }
}

// ── Capa 2: heurística por código sobre el DOM snippet (sin LLM, $0) ─────────
function heuristicDiagnose(
  errorCode: string,
  _action: string,
  domSnippet: unknown,
  url: string | undefined,
): Diagnosis {
  const dom = (domSnippet ?? {}) as {
    debugButtons?: Array<{ txt?: string; aria?: string; cls?: string; ctrl?: string; disabled?: boolean }> | null
    debugEditables?: Array<{ editable?: string; aria?: string; classes?: string; visible?: boolean }> | null
    topCardBtns?: Array<{ tag?: string; visible?: boolean; text?: string; aria?: string; href?: string }> | string[] | null
    visibleBtns?: string[] | null
  }
  const btns      = Array.isArray(dom.debugButtons) ? dom.debugButtons : []
  const editables = Array.isArray(dom.debugEditables) ? dom.debugEditables : []
  const topBtns   = Array.isArray(dom.topCardBtns)
    ? dom.topCardBtns.filter((b): b is { tag?: string; visible?: boolean; text?: string; aria?: string; href?: string } => typeof b === "object" && b !== null)
    : []
  const u = (url ?? "").toLowerCase()

  const base: Diagnosis = {
    source: "heuristic",
    element_visible: null,
    location_description: null,
    likely_cause: "Heurística sin diagnóstico concluyente.",
    suggested_css_selector: null,
    page_state: "other",
    confidence: 0,
    recommendation: "Escalar a análisis visual (Gemini).",
  }

  // Checks por URL (aplican a cualquier error, alta confianza)
  if (u.includes("/404")) {
    return { ...base, element_visible: false, likely_cause: "URL 404 — el perfil/hilo ya no existe.", confidence: 0.9, recommendation: "Marcar lead como dead (profile_not_found)." }
  }
  if (u.includes("/sales/")) {
    return { ...base, element_visible: false, page_state: "second_degree_restricted", likely_cause: "Redirigido a Sales Navigator — probable 2do grado / sin acceso directo.", confidence: 0.85, recommendation: "Revertir a invite_sent o marcar dead; no es bug de selector." }
  }

  switch (errorCode) {
    case "send_button_not_found":
    case "send_button_not_found_in_overlay": {
      const re = /enviar|send/i
      const cand = btns.find(b => (b.cls ?? "").includes("msg-form__send") || re.test(b.aria ?? "") || re.test(b.txt ?? ""))
      if (cand) {
        const sel = (cand.cls ?? "").includes("msg-form__send")
          ? ".msg-form__send-btn"
          : `button[aria-label*="${(cand.aria || "Enviar").slice(0, 20)}"]`
        if (cand.disabled) {
          return { ...base, element_visible: true, location_description: "esquina inferior derecha del compositor", likely_cause: "El botón de enviar EXISTE pero está disabled — el mensaje no se tipeó o quedó vacío.", suggested_css_selector: sel, page_state: "loaded_ok", confidence: 0.8, recommendation: "No es bug de selector: reintentar el tipeo del mensaje antes de enviar." }
        }
        return { ...base, element_visible: true, location_description: "esquina inferior derecha del compositor", likely_cause: `Botón de enviar visible y habilitado; el matcher actual no lo cubre (cls="${(cand.cls ?? "").slice(0, 40)}").`, suggested_css_selector: sel, page_state: "loaded_ok", confidence: 0.85, recommendation: `Agregar el selector "${sel}" al matcher del send button.` }
      }
      if (btns.length === 0) {
        return { ...base, element_visible: false, page_state: "partial_load", likely_cause: "Cero botones visibles — la página cargó a medias.", confidence: 0.72, recommendation: "Esperar más / reintentar; abrir el thread desde la lista, no por URL directa." }
      }
      return base // sin candidato claro → escalar
    }

    case "thread_editor_not_found":
    case "compose_editor_not_found_in_overlay": {
      const visEditable = editables.find(e => e.visible && (e.classes ?? "").includes("msg-form__contenteditable"))
      if (visEditable) {
        return { ...base, element_visible: true, location_description: "área de texto del compositor", likely_cause: "El editor contenteditable EXISTE y es visible; el matcher no lo encontró.", suggested_css_selector: ".msg-form__contenteditable", page_state: "loaded_ok", confidence: 0.85, recommendation: "Usar .msg-form__contenteditable como selector del editor." }
      }
      const onlyNoise = editables.length > 0 && editables.every(e =>
        (e.classes ?? "").includes("search-global-typeahead") || (e.classes ?? "").includes("g-recaptcha"))
      if (onlyNoise) {
        return { ...base, element_visible: false, page_state: "second_degree_restricted", likely_cause: "Solo hay search global + recaptcha (sin editor) — LinkedIn oculta el compositor en 2do grado.", confidence: 0.85, recommendation: "Revertir a invite_sent / marcar dead; no es bug de selector." }
      }
      if (editables.length === 0) {
        return { ...base, element_visible: false, page_state: "partial_load", likely_cause: "Cero elementos editables — página cargó a medias o navegación directa por URL.", confidence: 0.72, recommendation: "Abrir el thread desde la lista de mensajes (no por URL); reintentar tras esperar." }
      }
      return base // escalar
    }

    case "profile_message_button_not_found": {
      const re = /message|mensaje/i
      const msgBtn = topBtns.find(b => b.visible && (re.test(b.aria ?? "") || re.test(b.text ?? "")))
      if (msgBtn) {
        return { ...base, element_visible: true, location_description: "barra de acciones del perfil (top card)", likely_cause: "El botón 'Mensaje' existe en el top card; el matcher no lo cubrió.", suggested_css_selector: `button[aria-label*="ensaje"], button[aria-label*="essage"]`, page_state: "loaded_ok", confidence: 0.8, recommendation: "Agregar selector por aria-label 'Mensaje/Message'." }
      }
      const connectOnly = topBtns.some(b => /conectar|connect|seguir|follow/i.test((b.aria ?? "") + (b.text ?? "")))
      if (connectOnly) {
        return { ...base, element_visible: false, likely_cause: "Solo hay botón Conectar/Seguir — aún NO es conexión de 1er grado.", confidence: 0.85, recommendation: "No enviar mensaje: revertir a invite_sent (lead no es 1er grado todavía)." }
      }
      return base // escalar
    }

    case "thread_header_mismatch":
      return { ...base, page_state: "loaded_ok", likely_cause: "El nombre del header no coincide con el lead esperado — posible thread equivocado abierto.", confidence: 0.55, recommendation: "Re-verificar matching de nombre; abrir el hilo correcto desde la lista." }
  }

  return base // error desconocido → escalar
}

// ── Gemini Vision: analiza el screenshot del fallo y sugiere dónde está el elemento ──
async function analyzeWithGeminiVision(
  failureId: string,
  imageBase64: string,
  errorCode: string,
  action: string,
  domSnippet: unknown,
  admin: ReturnType<typeof createAdminClient>,
) {
  const { GoogleGenAI } = await import("@google/genai")
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })

  // Qué buscamos según el error
  const target: Record<string, string> = {
    send_button_not_found: "el botón de ENVIAR mensaje (paperplane/Enviar)",
    send_button_not_found_in_overlay: "el botón de ENVIAR en el overlay de compose",
    profile_message_button_not_found: "el botón 'Mensaje' en el perfil",
    thread_editor_not_found: "el editor de texto para escribir el mensaje (contenteditable)",
    compose_editor_not_found_in_overlay: "el editor de texto en el overlay de compose",
    thread_header_mismatch: "el nombre del contacto en el header del thread",
  }
  const lookingFor = target[errorCode] ?? "el elemento de UI que falló"

  const systemPrompt = `Eres un experto en automatización web y scraping de LinkedIn. Analizas un screenshot de una página de LinkedIn donde un bot falló al encontrar un elemento. Tu trabajo: determinar si el elemento está visible, dónde, y por qué el selector falló.

Responde SOLO con JSON válido (sin markdown):
{
  "element_visible": true|false,
  "location_description": "dónde está el elemento en la imagen (ej: esquina inferior derecha del panel de chat)",
  "likely_cause": "por qué el selector del bot falló (ej: la página cargó a medias / es 2do grado / selector cambió / elemento no existe)",
  "suggested_css_selector": "selector CSS candidato si lo puedes inferir, o null",
  "page_state": "loaded_ok|partial_load|second_degree_restricted|captcha|other",
  "confidence": 0.0-1.0,
  "recommendation": "qué debería hacer el bot (ej: esperar más / click en X primero / abrir desde la lista / marcar lead dead)"
}`

  const userPrompt = `ERROR: ${errorCode} (acción: ${action})
BUSCÁBAMOS: ${lookingFor}
DOM detectado (elementos editables visibles): ${JSON.stringify(domSnippet)?.slice(0, 600)}

Analiza el screenshot y diagnostica.`

  try {
    const resp = await Promise.race([
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        config: { systemInstruction: systemPrompt, temperature: 0.2, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
        contents: [{ role: "user", parts: [
          { text: userPrompt },
          { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
        ] }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("vision_timeout_30s")), 30_000)),
    ]) as { text?: string }

    let txt = (resp.text ?? "").trim().replace(/^```json\s*/i, "").replace(/```$/, "").trim()
    let diagnosis: unknown
    try { diagnosis = { source: "gemini_vision", ...JSON.parse(txt) } }
    catch { diagnosis = { source: "gemini_vision", raw: txt.slice(0, 500), parse_error: true } }

    await admin.from("ui_pattern_failures")
      .update({ ai_diagnosis: diagnosis as never, ai_analyzed_at: new Date().toISOString() })
      .eq("id", failureId)
    console.log(`[capture-failure] ✅ Gemini Vision diagnóstico guardado para ${failureId}`)
  } catch (err) {
    await admin.from("ui_pattern_failures")
      .update({ ai_diagnosis: { error: (err as Error).message } as never, ai_analyzed_at: new Date().toISOString() })
      .eq("id", failureId)
  }
}
