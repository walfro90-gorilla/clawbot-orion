export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"

// POST /api/cerebro/analyze-screenshot — admin only.
// Recibe una captura de una conversación (LinkedIn/WhatsApp/etc.), la analiza con
// Gemini Vision y devuelve un BORRADOR de entrada de playbook + transcript + diagnóstico.
// NO guarda nada: el humano revisa/edita el borrador en el form y lo guarda por la ruta
// normal (/api/cerebro/playbook). Ese review es el gate anti-alucinación del Cerebro.
// La imagen tampoco se persiste — contiene PII de terceros; el borrador sale GENERALIZADO
// (sin nombres propios) y eso es lo único que vive en la DB.

const ROLE_LEVEL: Record<string, number> = { god_admin: 4, admin: 3, user: 2, viewer: 1 }
const MAX_IMAGE_B64 = 8_000_000  // ~6MB reales; un screenshot normal es <1MB

const ANALYSIS_SYSTEM = `Eres el analista del playbook de ventas de un equipo que prospecta por LinkedIn. Recibes una CAPTURA DE PANTALLA de una conversación real y, opcionalmente, una nota del operador con contexto.

TAREA (en orden):
1. Transcribe la conversación visible. Etiqueta cada mensaje como [VENDEDOR] (quien prospecta/envía en nombre del equipo) o [LEAD] (el contacto). Si no puedes distinguir quién es quién, márcalo como [?].
2. Diagnostica en 1-3 frases qué está pasando: tipo de situación (objeción, rol invertido —el lead nos quiere vender ÉL—, empresa/persona equivocada, interés real, confusión, respuesta robótica o genérica del vendedor, etc.) y qué hizo bien o mal el VENDEDOR si su respuesta es visible.
3. Genera un BORRADOR de entrada de playbook para que la IA maneje MEJOR esta situación la próxima vez.

REGLAS (obligatorias):
- Usa SOLO lo visible en la imagen y la nota del operador. NADA inventado.
- GENERALIZA: en el borrador no uses nombres propios de personas ni empresas del screenshot — escribe "el lead", "su empresa". La entrada debe servir para futuros casos similares, no para este contacto.
- example_message = la respuesta IDEAL del vendedor para esta situación, en el MISMO IDIOMA de la conversación, lista como referencia de tono y estructura. Sin placeholders tipo [nombre], sin cifras ni datos inventados.
- Si la imagen NO es una conversación de chat, responde exactamente: {"error":"not_a_conversation"}

Responde SOLO con JSON válido (sin markdown):
{
  "transcript": "[VENDEDOR]: ...\\n[LEAD]: ...",
  "diagnosis": "qué pasa y qué hizo bien/mal el vendedor",
  "draft": {
    "kind": "objection|example",
    "title": "corto y buscable (ej: 'Rol invertido: el lead nos quiere vender')",
    "description": "1 línea: qué corrige o enseña esta entrada",
    "situation": "cuándo aplica, generalizado",
    "tags": ["3-6 tags: tipo de situación, industria, rol"],
    "applies_to_turns": [0,1,2,3],
    "example_message": "la respuesta ideal, en el idioma de la conversación"
  }
}
Guía de kind: "objection" si el lead plantea resistencia, rol invertido o no-fit; "example" si el intercambio funcionó y quieres replicarlo.
Guía de applies_to_turns: 0=rapport inicial, 1-2=profundizar, 3=cierre/agenda — elige los turnos donde esta situación ocurre de verdad.`

export async function POST(req: NextRequest) {
  // Mismo gate de rol que el resto de /api/cerebro
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const admin = createAdminClient()
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single()
  if ((ROLE_LEVEL[profile?.role ?? ""] ?? 0) < 3) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "GEMINI_API_KEY no configurada en Orion" }, { status: 500 })
  }

  const body = await req.json().catch(() => null)
  const imageBase64: string = body?.imageBase64 ?? ""
  const mimeType: string = body?.mimeType ?? "image/png"
  const hint: string = String(body?.hint ?? "").slice(0, 500)

  if (!imageBase64 || imageBase64.length < 100) {
    return NextResponse.json({ error: "imageBase64 requerido" }, { status: 400 })
  }
  if (imageBase64.length > MAX_IMAGE_B64) {
    return NextResponse.json({ error: "Imagen muy grande (máx ~6MB). Recorta el screenshot." }, { status: 413 })
  }
  if (!/^image\/(png|jpe?g|webp)$/.test(mimeType)) {
    return NextResponse.json({ error: `mimeType no soportado: ${mimeType}` }, { status: 400 })
  }

  const { GoogleGenAI } = await import("@google/genai")
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })

  const userPrompt = hint
    ? `NOTA DEL OPERADOR (contexto adicional, confiable): ${hint}\n\nAnaliza el screenshot.`
    : "Analiza el screenshot."

  try {
    const resp = await Promise.race([
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        // thinkingBudget 0 OBLIGATORIO: gemini-2.5-flash trae thinking por default y el
        // razonamiento interno se come maxOutputTokens → resp.text vacío → "no JSON".
        // (Mismo bug que ya pagó capture-failure; el patrón original lo lleva.)
        config: { systemInstruction: ANALYSIS_SYSTEM, temperature: 0.3, maxOutputTokens: 2400, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
        contents: [{ role: "user", parts: [
          { text: userPrompt },
          { inlineData: { mimeType, data: imageBase64 } },
        ] }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("vision_timeout_45s")), 45_000)),
    ]) as { text?: string }

    const txt = (resp.text ?? "").trim().replace(/^```json\s*/i, "").replace(/```$/, "").trim()
    if (!txt) {
      return NextResponse.json({ error: "El modelo devolvió respuesta vacía — reintenta (si persiste, la imagen puede ser demasiado grande o compleja)" }, { status: 502 })
    }
    let parsed: {
      error?: string
      transcript?: string
      diagnosis?: string
      draft?: {
        kind?: string; title?: string; description?: string; situation?: string
        tags?: string[]; applies_to_turns?: number[]; example_message?: string
      }
    }
    try {
      parsed = JSON.parse(txt)
    } catch {
      // Gemini a veces envuelve el JSON en prosa: rescatar el primer {...}
      const m = txt.match(/\{[\s\S]*\}/)
      if (!m) return NextResponse.json({ error: "La IA no devolvió JSON parseable", raw: txt.slice(0, 300) }, { status: 502 })
      parsed = JSON.parse(m[0])
    }

    if (parsed.error === "not_a_conversation") {
      return NextResponse.json({ error: "La imagen no parece una conversación de chat. Sube una captura del hilo de mensajes." }, { status: 422 })
    }
    if (!parsed.draft?.example_message || !parsed.draft?.title) {
      return NextResponse.json({ error: "Análisis incompleto (sin borrador utilizable)", raw: txt.slice(0, 300) }, { status: 502 })
    }

    // Saneo del borrador: solo campos conocidos, tipos correctos, defaults seguros
    const d = parsed.draft
    const draft = {
      kind: d.kind === "example" ? "example" : "objection",
      title: String(d.title).slice(0, 120),
      description: String(d.description ?? "").slice(0, 300),
      situation: String(d.situation ?? "").slice(0, 500),
      tags: (Array.isArray(d.tags) ? d.tags : []).map(t => String(t).trim()).filter(Boolean).slice(0, 6),
      applies_to_turns: (Array.isArray(d.applies_to_turns) ? d.applies_to_turns : [0, 1, 2, 3])
        .map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 0 && n <= 3),
      example_message: String(d.example_message).slice(0, 2000),
    }
    if (draft.applies_to_turns.length === 0) draft.applies_to_turns = [0, 1, 2, 3]

    return NextResponse.json({
      draft,
      transcript: String(parsed.transcript ?? "").slice(0, 3000),
      diagnosis: String(parsed.diagnosis ?? "").slice(0, 800),
    })
  } catch (err) {
    return NextResponse.json({ error: `Análisis falló: ${(err as Error).message}` }, { status: 502 })
  }
}
