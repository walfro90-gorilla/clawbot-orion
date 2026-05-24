// ai-message.js — Generación de mensajes LinkedIn vía Gemini para Sub-Fase 3.
//
// Diseño: un solo entry point `generateLinkedInMessage` que toma:
//   - sender persona/context de la campaña (gemini_system_prompt)
//   - perfil del lead (name, headline, location)
//   - tipo de mensaje (invite, follow_up_1..5)
//   - opcionalmente: ejemplos del paso (fm1_example_reply, etc.)
//
// Retorna { message } o { error }. NO toma decisiones de envío — solo gen.

import { GoogleGenAI } from '@google/genai'

const MODEL = 'gemini-2.5-flash'

const TYPE_RULES = {
  invite: {
    maxChars: 150,
    description: 'mensaje de conexión LinkedIn de primer contacto',
    rules: [
      'Es el PRIMER contacto — no asumas relación previa.',
      'Menciona algo específico de su rol o perfil para demostrar que leíste.',
      'NO intentes vender nada. Solo conecta.',
      'Termina con una pregunta corta y abierta (opcional pero recomendado).',
      'Tono casual y humano. CERO lenguaje corporativo.',
      'NO uses emojis a menos que el sender persona lo indique explícitamente.',
    ],
  },
  follow_up_1: {
    maxChars: 500,
    description: 'primer mensaje de follow-up después de aceptar la conexión',
    rules: [
      'Esta persona acaba de aceptar tu invitación. Saluda casualmente.',
      'Reconoce que aceptaron y aporta algo de valor (insight, pregunta).',
      'NO vendas todavía. Genera contexto/conversación.',
      'Tono casual y humano.',
    ],
  },
  follow_up_2: {
    maxChars: 500,
    description: 'segundo follow-up — la persona no respondió al primero',
    rules: [
      'Ya enviaste un primer mensaje sin respuesta. No insistas pero recuérdale el contexto.',
      'Aporta valor nuevo: insight, dato relevante, pregunta diferente.',
      'Mantén tono casual.',
    ],
  },
  follow_up_3: {
    maxChars: 500,
    description: 'tercer follow-up — último intento amistoso',
    rules: [
      'Ya enviaste 2 mensajes sin respuesta. Esta es la última vez que escribes.',
      'Reconoce explícitamente que es el último intento.',
      'Ofrece valor + pregunta directa.',
    ],
  },
  follow_up_4: {
    maxChars: 500,
    description: 'cuarto follow-up — solo si el cliente lo configuró',
    rules: ['Persistencia estratégica. Aporta algo NUEVO y relevante.'],
  },
  follow_up_5: {
    maxChars: 500,
    description: 'quinto y último follow-up',
    rules: ['Cierre formal y educado. "Si no es buen momento, todo bien."'],
  },
}

function buildSystemPrompt({ campaignPrompt, type, exampleReply }) {
  const typeConf = TYPE_RULES[type] ?? TYPE_RULES.invite
  const sections = [
    campaignPrompt || 'Eres un SDR experto que envía mensajes en LinkedIn en español.',
    '',
    `TIPO DE MENSAJE: ${typeConf.description}`,
    `LÍMITE: máximo ${typeConf.maxChars} caracteres (cuenta uno por uno).`,
    '',
    'REGLAS:',
    ...typeConf.rules.map(r => `- ${r}`),
  ]
  if (exampleReply) {
    sections.push('', `EJEMPLO DE MENSAJE QUE FUNCIONA:`, `"${exampleReply}"`)
  }
  sections.push('', 'FORMATO DE RESPUESTA: SOLO el mensaje, sin comillas, sin prefijos, sin firma. Una respuesta de texto plano.')
  return sections.join('\n')
}

function buildUserPrompt(lead) {
  const parts = [
    `Nombre: ${lead.full_name ?? '(desconocido)'}`,
    `URL perfil: ${lead.linkedin_url ?? '(sin URL)'}`,
  ]
  if (lead.profile_data?.headline) parts.push(`Headline: ${lead.profile_data.headline}`)
  if (lead.profile_data?.location) parts.push(`Ubicación: ${lead.profile_data.location}`)
  if (lead.profile_data?.about) parts.push(`Acerca de: ${lead.profile_data.about.slice(0, 400)}`)
  if (lead.profile_data?.currentPosition) parts.push(`Posición actual: ${lead.profile_data.currentPosition}`)
  if (lead.profile_data?.currentCompany) parts.push(`Empresa: ${lead.profile_data.currentCompany}`)
  return parts.join('\n')
}

/**
 * Genera un mensaje LinkedIn personalizado vía Gemini.
 *
 * @param {object} campaign - { gemini_system_prompt, fm1_example_reply, ... }
 * @param {object} lead - { full_name, linkedin_url, profile_data }
 * @param {string} type - 'invite' | 'follow_up_1' | ... | 'follow_up_5'
 * @param {object} opts - { retries?: number, temperature?: number }
 * @returns {Promise<{message: string} | {error: string}>}
 */
export async function generateLinkedInMessage(campaign, lead, type = 'invite', opts = {}) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return { error: 'GEMINI_API_KEY missing' }

  const exampleField = {
    invite:       'fm1_example_reply',
    follow_up_1:  'fm1_example_reply',
    follow_up_2:  'fm2_example_reply',
    follow_up_3:  'fm3_example_reply',
  }[type]
  const exampleReply = exampleField ? campaign[exampleField] : null

  const systemPrompt = buildSystemPrompt({
    campaignPrompt: campaign.gemini_system_prompt,
    type,
    exampleReply,
  })
  const userPrompt = buildUserPrompt(lead)
  const maxChars = TYPE_RULES[type]?.maxChars ?? 150

  const ai = new GoogleGenAI({ apiKey })
  const retries = opts.retries ?? 2

  let lastError
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        config: {
          systemInstruction: systemPrompt,
          temperature: opts.temperature ?? 0.85,
          maxOutputTokens: 300,
          thinkingConfig: { thinkingBudget: 0 },
        },
        contents: userPrompt,
      })
      let text = (response.text ?? '').trim()
      // Strip surrounding quotes si el modelo las añadió
      if ((text.startsWith('"') && text.endsWith('"')) ||
          (text.startsWith("'") && text.endsWith("'"))) {
        text = text.slice(1, -1).trim()
      }
      if (!text) {
        lastError = 'empty_response'
        continue
      }
      if (text.length > maxChars) {
        // Recorte suave en última palabra completa antes del límite
        const truncated = text.slice(0, maxChars)
        const lastSpace = truncated.lastIndexOf(' ')
        text = lastSpace > maxChars * 0.7 ? truncated.slice(0, lastSpace) : truncated
        text = text.replace(/[,.;:\-]+$/, '').trim()
      }
      return { message: text }
    } catch (err) {
      lastError = err.message ?? String(err)
      if (attempt < retries) await new Promise(r => setTimeout(r, 1500 * attempt))
    }
  }
  return { error: lastError ?? 'unknown' }
}
