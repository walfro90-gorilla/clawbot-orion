// ai-message.js — Generación de mensajes LinkedIn vía Gemini.
//
// Sub-Fase 3.6 + 3.8 update: ahora soporta `fm_reply` con conversation history
// y cal.com URL para que las respuestas sean contextuales y dirijan a la cita.
//
// Entry points:
//   - generateLinkedInMessage(campaign, lead, type) — para invite + FU outbound
//   - generateLinkedInReply(campaign, lead, ctx)    — para FM (responder al lead)
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
  // ── NUEVO Sub-Fase 3.8: respuestas contextuales (cuando lead nos escribe) ──
  fm_reply_1: {
    maxChars: 700,
    description: 'PRIMERA respuesta al lead. Él te escribió, ahora le contestas.',
    rules: [
      'CRITICO: el lead te ESCRIBIÓ algo. Lee atentamente su mensaje y responde DIRECTAMENTE a lo que dijo.',
      'NO ignores su contenido. Reconoce su punto, valida su contexto, agradece si compartió info.',
      'Si compartió un dato (problema, cifra, situación), profundiza con una pregunta inteligente o aporta perspectiva.',
      'INTRODUCE sutilmente la idea de "hablar más a profundidad" o "una llamada corta" — pero sin presionar.',
      'NO incluyas el link de calendario en este primer reply. Solo abre la puerta.',
      'Tono natural, conversacional, humano. CERO lenguaje corporativo.',
    ],
  },
  fm_reply_2: {
    maxChars: 700,
    description: 'SEGUNDA respuesta al lead. La conversación está activa. Mueve hacia la cita.',
    rules: [
      'El lead siguió la conversación contigo. Es buen momento de ser más directo.',
      'Responde a su último mensaje con contexto y valor.',
      'PROPÓN explícitamente una llamada corta (20-30 min) e INCLUYE el link de calendario disponible.',
      'Hazlo opcional, sin presión: "Si te interesa, aquí tienes mi calendario: [link]".',
      'Tono cálido, natural.',
    ],
  },
  fm_reply_3: {
    maxChars: 700,
    description: 'TERCERA respuesta — cierre. Pregunta directa por fecha.',
    rules: [
      'Ya hubo intercambio. Es momento de cerrar con pregunta directa.',
      'Responde a su mensaje con empatía.',
      'Pregunta DIRECTAMENTE: "¿Tienes 20 min esta semana o la próxima?" o "¿Qué día te funciona mejor?".',
      'Reitera el link de calendario.',
      'Si parece tibio, deja la puerta abierta con elegancia: "Si no es buen momento, sin problema, quedo cerca".',
    ],
  },
}

function buildSystemPrompt({ campaignPrompt, type, exampleReply, calUrl }) {
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
  if (calUrl && (type === 'fm_reply_2' || type === 'fm_reply_3')) {
    sections.push('', `LINK DE CALENDARIO PARA AGENDAR: ${calUrl}`)
    sections.push('Inclúyelo en tu respuesta tal cual, sin acortar.')
  }
  if (exampleReply) {
    sections.push('', `EJEMPLO DE TONO Y ESTILO QUE FUNCIONA EN ESTA CAMPAÑA:`, `"${exampleReply}"`)
    sections.push('Úsalo como GUÍA de tono y estructura, NO copies literal.')
  }
  sections.push('', 'FORMATO DE RESPUESTA: SOLO el mensaje a enviar, texto plano. Sin comillas envolventes, sin prefijos tipo "Respuesta:", sin firma.')
  return sections.join('\n')
}

function buildUserPrompt(lead) {
  const parts = [
    `PERFIL DEL LEAD:`,
    `- Nombre: ${lead.full_name ?? '(desconocido)'}`,
  ]
  if (lead.profile_data?.headline)        parts.push(`- Headline: ${lead.profile_data.headline}`)
  if (lead.profile_data?.location)        parts.push(`- Ubicación: ${lead.profile_data.location}`)
  if (lead.profile_data?.currentPosition) parts.push(`- Posición actual: ${lead.profile_data.currentPosition}`)
  if (lead.profile_data?.currentCompany)  parts.push(`- Empresa: ${lead.profile_data.currentCompany}`)
  if (lead.profile_data?.about)           parts.push(`- Acerca de: ${lead.profile_data.about.slice(0, 400)}`)
  return parts.join('\n')
}

function buildReplyUserPrompt(lead, conversationHistory, calUrl) {
  const parts = [buildUserPrompt(lead)]
  if (conversationHistory?.length) {
    parts.push('', 'HISTORIAL DE LA CONVERSACIÓN (cronológico, más antiguo arriba):')
    for (const msg of conversationHistory) {
      const speaker = msg.direction === 'outbound' ? 'YO (sender)' : `LEAD (${lead.full_name?.split(' ')[0] ?? 'él/ella'})`
      const content = (msg.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)
      parts.push(`[${speaker}]: ${content}`)
    }
    parts.push('', 'TAREA: Responde DIRECTAMENTE al ÚLTIMO mensaje del LEAD. Considera todo el contexto previo.')
  }
  if (calUrl) {
    parts.push('', `CAL_URL disponible: ${calUrl}`)
  }
  return parts.join('\n')
}

async function callGemini(systemPrompt, userPrompt, maxChars, opts) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return { error: 'GEMINI_API_KEY missing' }
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
          maxOutputTokens: 500,
          thinkingConfig: { thinkingBudget: 0 },
        },
        contents: userPrompt,
      })
      let text = (response.text ?? '').trim()
      if ((text.startsWith('"') && text.endsWith('"')) ||
          (text.startsWith("'") && text.endsWith("'"))) {
        text = text.slice(1, -1).trim()
      }
      if (!text) { lastError = 'empty_response'; continue }
      if (text.length > maxChars) {
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

/**
 * Genera un mensaje LinkedIn outbound (invite o follow_up). Sin historial.
 */
export async function generateLinkedInMessage(campaign, lead, type = 'invite', opts = {}) {
  const exampleField = {
    invite:       'fm1_example_reply',
    follow_up_1:  'fm1_example_reply',
    follow_up_2:  'fm2_example_reply',
    follow_up_3:  'fm3_example_reply',
  }[type]
  const exampleReply = exampleField ? campaign[exampleField] : null
  const systemPrompt = buildSystemPrompt({
    campaignPrompt: campaign.gemini_system_prompt,
    type, exampleReply,
  })
  const userPrompt = buildUserPrompt(lead)
  const maxChars = TYPE_RULES[type]?.maxChars ?? 150
  return await callGemini(systemPrompt, userPrompt, maxChars, opts)
}

/**
 * Personaliza un template de FU usando el perfil del lead.
 * Mantiene la INTENCIÓN del template original pero adapta el lenguaje al
 * lead específico (su empresa, rol, headline).
 *
 * @param {object} campaign
 * @param {object} lead
 * @param {string} template - El texto original del FU template
 * @param {number} fuStep - 1, 2, 3, 4 o 5
 * @param {string} calUrl - cal.com URL para incluir si aplica
 */
export async function personalizeFollowupMessage(campaign, lead, template, fuStep, calUrl, opts = {}) {
  const stepKey = `follow_up_${fuStep}`
  const typeConf = TYPE_RULES[stepKey] ?? TYPE_RULES.follow_up_1
  const maxChars = typeConf.maxChars

  const systemSections = [
    campaign.gemini_system_prompt || 'Eres un SDR experto B2B en español.',
    '',
    `TAREA: PERSONALIZAR un template de mensaje LinkedIn — manteniendo la INTENCIÓN COMPLETA del template original pero adaptando el wording al lead específico.`,
    '',
    `MEJORA QUE QUEREMOS:`,
    `- Mismo objetivo de venta/conversación que el template original.`,
    `- Mismas piezas estructurales: pregunta abierta si hay, dato si hay, CTA si hay.`,
    `- Lenguaje adaptado al cargo, empresa, industria y headline del lead.`,
    `- Ejemplos/casos relevantes para su industria (si en el template hay un caso, busca uno análogo a su sector).`,
    `- Tono: mismo que el template original (casual, directo, cálido).`,
    '',
    `LO QUE NO HAGAS:`,
    `- NO cambies la intención de venta del template.`,
    `- NO inventes datos numéricos (porcentajes, cifras) — usa los del template tal cual o más conservadores.`,
    `- NO añadas información que no esté en el template o en el perfil del lead.`,
    `- NO uses emojis a menos que el template original los tenga.`,
    `- NO incluyas tu firma o nombre.`,
    '',
    `STEP DEL FU: ${fuStep} (${typeConf.description})`,
    `LÍMITE: máximo ${maxChars} caracteres.`,
  ]
  if (calUrl && template.toLowerCase().includes('cal') || template.includes('[CAL_URL]') || template.includes('{cal_url}')) {
    systemSections.push('', `LINK CALENDARIO: ${calUrl} — inclúyelo tal cual si el template original tiene CTA de llamada.`)
  }
  systemSections.push('', 'FORMATO: SOLO el mensaje personalizado, texto plano. Sin comillas, sin prefijos, sin firma.')

  const systemPrompt = systemSections.join('\n')

  const userSections = [
    `TEMPLATE ORIGINAL A PERSONALIZAR (mantén su intención y estructura):`,
    '"""',
    template,
    '"""',
    '',
    `LEAD A QUIEN VA DIRIGIDO:`,
    `- Nombre: ${lead.full_name ?? '(?)'}`,
  ]
  if (lead.profile_data?.headline)        userSections.push(`- Headline: ${lead.profile_data.headline}`)
  if (lead.profile_data?.currentPosition) userSections.push(`- Posición: ${lead.profile_data.currentPosition}`)
  if (lead.profile_data?.currentCompany)  userSections.push(`- Empresa: ${lead.profile_data.currentCompany}`)
  if (lead.profile_data?.location)        userSections.push(`- Ubicación: ${lead.profile_data.location}`)
  if (lead.profile_data?.about)           userSections.push(`- Acerca de: ${lead.profile_data.about.slice(0, 300)}`)
  userSections.push('', `Personaliza el template para este lead. Adapta lenguaje, ejemplos y referencias a su contexto (empresa, industria, cargo).`)

  return await callGemini(systemPrompt, userSections.join('\n'), maxChars, opts)
}

/**
 * Genera RESPUESTA a un mensaje del lead (FM). Incluye conversation history y
 * cal.com URL en el prompt para que la respuesta sea coherente y mueva a cita.
 *
 * @param {object} campaign
 * @param {object} lead
 * @param {object} ctx
 *   - conversationHistory: [{direction:'inbound'|'outbound', content, sent_at}]
 *   - calUrl: string del cal.com de la cuenta
 *   - fmStep: 1, 2, o 3 (cuál respuesta es)
 */
export async function generateLinkedInReply(campaign, lead, ctx = {}, opts = {}) {
  const fmStep = Math.min(Math.max(ctx.fmStep ?? 1, 1), 3)
  const type = `fm_reply_${fmStep}`
  const exampleField = `fm${fmStep}_example_reply`
  const exampleReply = campaign[exampleField] ?? null
  const calUrl = ctx.calUrl ?? null
  const systemPrompt = buildSystemPrompt({
    campaignPrompt: campaign.gemini_system_prompt,
    type, exampleReply, calUrl,
  })
  const userPrompt = buildReplyUserPrompt(lead, ctx.conversationHistory ?? [], calUrl)
  const maxChars = TYPE_RULES[type]?.maxChars ?? 700
  return await callGemini(systemPrompt, userPrompt, maxChars, opts)
}
