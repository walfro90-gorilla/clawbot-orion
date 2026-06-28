// Agente de contenido diario para LinkedIn (perfil propio).
// Genera el COPY del post a partir del contexto que el admin define en publish_agents.
// Proveedor de texto: Groq (vía endpoint OpenAI-compatible, sin dep nueva) con
// FALLBACK a Gemini si no hay GROQ_API_KEY o si Groq falla.
// Fase B añadirá: grounding de noticias (Gemini googleSearch) + imagen (Nano Banana).

import { GoogleGenAI } from '@google/genai'
import { researchNews } from './news-research.js'
import { generateImagePrompt, generateImage } from './gemini-image.js'

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
const GEMINI_MODEL = 'gemini-2.5-flash'

// ── System prompt desde la config del agente ────────────────────────────────
export function buildPublishSystemPrompt(agent = {}) {
  const ctx = (agent.business_context || '').trim()
  const ideas = (agent.ideas || '').trim()
  const tone = (agent.tone || '').trim() || 'profesional, cercano y humano; cero clichés corporativos'
  const doDont = (agent.do_dont || '').trim()
  const extra = (agent.gemini_system_prompt || '').trim()

  return `Eres un experto en personal branding y copywriting para LinkedIn. Escribes posts en
PRIMERA PERSONA para el perfil del usuario, sobre lo que ofrece su negocio. El objetivo es
aportar valor y posicionarlo como referente — NO vender de forma agresiva.

CONTEXTO DEL NEGOCIO:
${ctx || '(el admin no definió contexto; sé genérico pero profesional)'}

${ideas ? `IDEAS / TEMAS RECURRENTES (elige UNO o combínalos con un ángulo fresco):\n${ideas}\n` : ''}
TONO: ${tone}

REGLAS DE ESCRITURA:
- UN solo post, en español neutro (a menos que el contexto indique otro idioma).
- 60–180 palabras. Engancha en la PRIMERA línea (sin "Hoy quiero hablarles de…").
- Aporta UN dato, idea o insight CONCRETO y útil. Nada de relleno.
- Máximo 3 hashtags relevantes al final. Emojis con moderación (0–2).
- NO inventes cifras, estudios ni hechos falsos. Si usas un dato, que sea plausible y general.
- Cierra con una invitación suave a conversar (pregunta abierta o CTA ligero), sin sonar a anuncio.
${doDont ? `- Reglas extra del admin: ${doDont}` : ''}
${extra ? `\n${extra}` : ''}

FORMATO: Devuelve ÚNICAMENTE el texto del post (listo para pegar), sin comillas, sin markdown,
sin etiquetas ni explicaciones.`.trim()
}

// ── Proveedores ─────────────────────────────────────────────────────────────
async function groqChat(system, user, { temperature = 0.75, maxTokens = 600 } = {}) {
  const key = process.env.GROQ_API_KEY
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`groq_${res.status}_${t.slice(0, 140)}`)
  }
  const j = await res.json()
  return (j?.choices?.[0]?.message?.content ?? '').trim()
}

async function geminiChat(system, user, { temperature = 0.85, maxTokens = 600 } = {}) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY no definida')
  const ai = new GoogleGenAI({ apiKey })
  const resp = await ai.models.generateContent({
    model: GEMINI_MODEL,
    config: { systemInstruction: system, temperature, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } },
    contents: user,
  })
  return (resp?.text ?? '').trim()
}

// Limpia comillas/markdown envolventes que a veces agregan los modelos.
function cleanPost(text) {
  let t = (text || '').trim()
  t = t.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim()
  if (t.length > 1 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”')))) {
    t = t.slice(1, -1).trim()
  }
  return t
}

/**
 * Genera el copy del post diario.
 * @param {object} agent  fila de publish_agents
 * @param {object} opts   { newsContext?: string }  (fase B)
 * @returns {Promise<{text:string, provider:string, warn?:string}>}
 */
export async function generatePostCopy(agent, { newsContext = null } = {}) {
  const system = buildPublishSystemPrompt(agent)
  const user = newsContext
    ? `Escribe el post de hoy. Apóyate en esta noticia/contexto reciente y conéctalo con lo que ofrecemos:\n\n${newsContext}`
    : `Escribe el post de hoy sobre lo que ofrecemos. Elige un ángulo fresco a partir del contexto/ideas.`

  const useGroq = !!process.env.GROQ_API_KEY
  try {
    const raw = useGroq ? await groqChat(system, user) : await geminiChat(system, user)
    const text = cleanPost(raw)
    if (!text || text.length < 20) throw new Error(`empty_or_short_copy_${text.length}`)
    return { text, provider: useGroq ? 'groq' : 'gemini' }
  } catch (e) {
    // Fallback: si íbamos por Groq y falló, intenta Gemini.
    if (useGroq && process.env.GEMINI_API_KEY) {
      const text = cleanPost(await geminiChat(system, user))
      if (text && text.length >= 20) return { text, provider: 'gemini-fallback', warn: String(e.message) }
    }
    throw e
  }
}

/**
 * Orquestador completo (Fase B): noticia (Google Search) → copy (Groq/Gemini) →
 * prompt de imagen → imagen (Nano Banana). Noticia e imagen son best-effort: si
 * fallan, el post sale igual (sin noticia / sin imagen). El upload de la imagen lo
 * hace el caller (scheduler) porque necesita el id de la fila ya insertada.
 * @returns {Promise<{text, provider, imagePrompt, imageBase64, imageMime, sourceNews, warn}>}
 */
export async function generateDailyPost(agent) {
  // 1. Noticia reciente (best-effort)
  let newsContext = null
  let sourceNews = null
  try {
    const news = await researchNews(agent)
    if (news) { newsContext = news.summary; sourceNews = news }
  } catch { /* sin noticia */ }

  // 2. Copy (con o sin noticia)
  const copy = await generatePostCopy(agent, { newsContext })

  // 3. Imagen (best-effort)
  let imagePrompt = null
  let imageBase64 = null
  let imageMime = null
  let imageWarn = null
  try {
    imagePrompt = await generateImagePrompt(copy.text, agent)
    const img = await generateImage(imagePrompt)
    imageBase64 = img.base64
    imageMime = img.mime
  } catch (e) {
    imageWarn = 'image:' + String(e.message ?? e).slice(0, 80)
  }

  return {
    text: copy.text,
    provider: copy.provider,
    imagePrompt,
    imageBase64,
    imageMime,
    sourceNews,
    warn: [copy.warn, imageWarn].filter(Boolean).join('; ') || null,
  }
}
