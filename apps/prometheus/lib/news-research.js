// Fase B: grounding de noticias para el post diario.
// Usa Gemini con la herramienta googleSearch (built-in) para traer 1 dato/tendencia
// reciente relevante al negocio del agente. Best-effort: si falla o no hay nada
// reciente, devuelve null y el copy se genera sin noticia.

import { GoogleGenAI } from '@google/genai'

export async function researchNews(agent) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null
  const ai = new GoogleGenAI({ apiKey })
  const topics = [agent?.business_context, agent?.ideas].filter(Boolean).join('\n').slice(0, 800)

  try {
    const resp = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      config: { tools: [{ googleSearch: {} }], temperature: 0.3 },
      contents:
        `Busca 1 noticia, dato o tendencia RECIENTE (últimos 7-10 días) relevante para este ` +
        `negocio y resúmela en 3-4 líneas en español, incluyendo el dato/hecho clave y por qué ` +
        `importa. Si no encuentras nada reciente y realmente relevante, responde SOLO: SIN_NOTICIA.\n\n` +
        `Negocio / temas:\n${topics || 'tecnología, IA, automatización, negocios B2B'}`,
    })
    const summary = (resp?.text || '').trim()
    if (!summary || /^SIN_NOTICIA/i.test(summary)) return null

    const sources = (resp?.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
      .map((c) => ({ title: c?.web?.title ?? null, uri: c?.web?.uri ?? null }))
      .filter((s) => s.uri)
      .slice(0, 5)

    return { summary, sources, fetched_at: new Date().toISOString() }
  } catch (e) {
    console.warn('[daily-publish] researchNews failed:', String(e.message ?? e).slice(0, 120))
    return null
  }
}
