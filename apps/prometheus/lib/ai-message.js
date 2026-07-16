// ai-message.js — Generación de mensajes LinkedIn vía LLM (Groq primario + Gemini fallback).
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
import { supabase } from './supabase.js'

const GEMINI_MODEL = 'gemini-2.5-flash'
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
// Cadena de proveedores LLM: primario → fallback. Post-mortem 2026-07-03: el billing de
// Gemini ("dunning deny") rompió TODA la generación por ser proveedor único. Groq primario
// (rápido, free-tier, calidad Llama 3.3 70B validada) + Gemini fallback. Config por env:
//   LLM_PROVIDERS="groq,gemini"  ·  GROQ_MODEL="llama-3.3-70b-versatile"
const LLM_PROVIDERS = (process.env.LLM_PROVIDERS || 'groq,gemini')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

// Detecta placeholders/variables sin resolver en un mensaje listo para enviar:
//   - corchetes con contenido: "[menciona algo]", "[Nombre]", "[CAL_URL]"
//   - llaves con contenido: "{nombre}", "{cal_url}"
// Un mensaje FINAL nunca debe contener esto (los LinkedIn DMs no usan corchetes).
export const PLACEHOLDER_RE = /\[[^\]\n]{0,120}\]|\{[^}\n]{0,120}\}/

export function hasLeftoverPlaceholder(text) {
  return PLACEHOLDER_RE.test(String(text ?? ''))
}

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
    maxChars: 280, // v0.8: cap typing-safe (mensajes largos reventaban el typing_complete timeout)
    description: 'primer mensaje de follow-up después de aceptar la conexión',
    rules: [
      'Esta persona acaba de aceptar tu invitación. Saluda casualmente.',
      'Reconoce que aceptaron y aporta algo de valor (insight, pregunta).',
      'NO vendas todavía. Genera contexto/conversación.',
      'Tono casual y humano.',
    ],
  },
  follow_up_2: {
    maxChars: 280, // v0.8: cap typing-safe
    description: 'segundo follow-up — la persona no respondió al primero',
    rules: [
      'Ya enviaste un primer mensaje sin respuesta. No insistas pero recuérdale el contexto.',
      'Aporta valor nuevo: insight, dato relevante, pregunta diferente.',
      'Mantén tono casual.',
    ],
  },
  follow_up_3: {
    maxChars: 280, // v0.8: cap typing-safe
    description: 'tercer follow-up — último intento amistoso',
    rules: [
      'Ya enviaste 2 mensajes sin respuesta. Esta es la última vez que escribes.',
      'Reconoce explícitamente que es el último intento.',
      'Ofrece valor + pregunta directa.',
    ],
  },
  follow_up_4: {
    maxChars: 280, // v0.8: cap typing-safe
    description: 'cuarto follow-up — solo si el cliente lo configuró',
    rules: ['Persistencia estratégica. Aporta algo NUEVO y relevante.'],
  },
  follow_up_5: {
    maxChars: 280, // v0.8: cap typing-safe
    description: 'quinto y último follow-up',
    rules: ['Cierre formal y educado. "Si no es buen momento, todo bien."'],
  },
  // ── Post-Prospecting: comentario PÚBLICO value-first en un post ──
  // OJO: el comentario es PÚBLICO. NO vende, NO menciona empresa/servicio, NO CTA.
  // El pitch va en la nota privada de conexión (pitch_note), nunca aquí.
  post_comment: {
    maxChars: 400,
    description: 'comentario PÚBLICO en un post de LinkedIn donde el autor pide ayuda/recomendación',
    rules: [
      'El comentario es PÚBLICO y lo verá todo el mundo. Tu única meta es APORTAR VALOR genuino.',
      'Responde DIRECTAMENTE a lo que el autor pide en su post. Sé concreto y útil.',
      'PROHIBIDO vender. PROHIBIDO mencionar tu empresa, tu producto o tus servicios.',
      'PROHIBIDO cualquier CTA, link, "mándame DM", "te escribo por privado" o auto-promoción.',
      'Aporta UNA idea accionable, un recurso, una consideración técnica o una pregunta inteligente que demuestre expertise real.',
      'Tono humano, colega-a-colega. CERO lenguaje corporativo, CERO halagos vacíos ("¡Gran post!").',
      'Breve: 1-3 frases. Un comentario largo se ve a spam.',
      'NO uses emojis salvo que encaje muy naturalmente (máximo uno).',
    ],
  },
  // ── NUEVO Sub-Fase 3.8: respuestas contextuales (cuando lead nos escribe) ──
  fm_reply_1: {
    maxChars: 320, // v0.8: cap typing-safe (sin link de cal en este reply)
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
    maxChars: 400, // v0.8: cap typing-safe (deja espacio para el link de cal)
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
    maxChars: 400, // v0.8: cap typing-safe (deja espacio para el link de cal)
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

// v0.7.45: inyecta el lead_id en el link de cal.com vía el param `notes`. Cuando el
// lead agenda, cal.com prefilla el campo notes con "LEAD_ID=<uuid>" y el webhook
// BOOKING_CREATED (app/api/cal-webhook) lo extrae de responses.notes.value → setea
// meeting_at automático. Sin esto el booking llega sin forma de matchearse al lead
// (los leads no tienen email) → el funnel mostraba 0 citas aunque se agendaran.
export function calUrlWithLeadId(calUrl, leadId) {
  if (!calUrl || !leadId) return calUrl ?? null
  try {
    const u = new URL(calUrl)
    u.searchParams.set('notes', `LEAD_ID=${leadId}`)
    return u.toString()
  } catch {
    const sep = calUrl.includes('?') ? '&' : '?'
    return `${calUrl}${sep}notes=LEAD_ID%3D${encodeURIComponent(leadId)}`
  }
}

// Regla anti-"título como empresa" (hallazgo Wal 2026-07-03 #1): la ruta VIVA no
// pre-extrae la empresa (currentCompany suele ser null) y muchos headlines son títulos
// puros ("Director de Operaciones") → sin esta regla Gemini podría inventar/usar el título
// como si fuera el nombre de la empresa. La regex que lo evitaba vive en worker.js (MUERTO).
const NO_INVENT_COMPANY_RULE = '🏢 EMPRESA: NUNCA inventes ni asumas el nombre de una empresa. Si el perfil NO incluye una línea "Empresa:" explícita, NO menciones ninguna empresa. NUNCA uses el cargo, título o rol de la persona (ej. "Director de Operaciones", "Gerente de Logística") como si fuera el nombre de su empresa — es un error grave.'

// Modo relación ("vender sin vender") para el FM/auto-reply. Sustituye las reglas
// hardcodeadas fm_reply_* que empujan a cita. Se activa cuando la campaña define
// followup_tone_directive (mismo gate que el FU path). El lead pide la reunión; nunca al revés.
const FM_RELATIONSHIP_RULES = [
  'El lead te ESCRIBIÓ. Lee su mensaje y respóndele DIRECTAMENTE a lo que dijo — reconoce su punto, valida su contexto, agradece si compartió algo.',
  'Conversa como una persona genuina que quiere CONOCER al lead y construir relación. Vender sin vender: deja que tu trabajo y tu perfil hablen por sí solos.',
  'PROHIBIDO proponer, sugerir o insinuar una llamada, cita, reunión, demo o "hablar más a profundidad". NO empujes hacia una reunión de ninguna forma.',
  'Aporta valor con una pregunta inteligente o una perspectiva, pero SIN CTA de venta y SIN pitch.',
  'Solo si el lead PIDE EXPLÍCITAMENTE una llamada, reunión o más información, entonces SÍ compártele con gusto el link de calendario (ver abajo).',
  'Tono natural, conversacional, humano. CERO lenguaje corporativo.',
]

// (2026-07-06) Bloque de identidad/contexto de campaña configurado en Orion web (Centro de
// Control → tab IA: Persona del remitente / Contexto de empresa / Tono). Se inyecta al system
// prompt de TODA generación por IA (invite full-gen, FM/auto-reply, FU-LLM) cuando la campaña
// los tiene. Antes se cargaban pero NUNCA llegaban al prompt → el FM salía genérico. Guards
// if(campo): campañas sin estos campos quedan idénticas. NO afecta el FU verbatim (no llama LLM).
export function campaignPersonaBlock(campaign) {
  if (!campaign) return null
  // Dispara SOLO si hay identidad/contexto sustantivo (persona o empresa). ai_tone por sí solo
  // NO cuenta → campañas que solo tienen tono (Wal Tech/Transporte/[Post], que ya funcionan)
  // quedan idénticas. Caps defensivos: un persona/context enorme (Café: 25k chars) no aporta a
  // un DM y encarece cada llamada — acotamos sin perder el núcleo.
  if (!campaign.ai_sender_persona && !campaign.ai_company_context) return null
  const parts = []
  if (campaign.ai_sender_persona)
    parts.push(`QUIÉN ERES (tu identidad y voz — escribe SIEMPRE en primera persona como esta persona, nunca como un bot):\n${campaign.ai_sender_persona.slice(0, 2000)}`)
  if (campaign.ai_company_context)
    parts.push(`CONTEXTO DE TU EMPRESA / OFERTA (para dar color y credibilidad — NO lo recites literal ni lo pegues entero):\n${campaign.ai_company_context.slice(0, 3000)}`)
  if (campaign.ai_tone)
    parts.push(`TONO OBJETIVO: ${campaign.ai_tone}`)
  return parts.length ? parts.join('\n\n') : null
}

export function buildSystemPrompt({ campaignPrompt, personaBlock, brainBlock, type, exampleReply, calUrl, toneDirective, lastFuTemplate, lastFuStepNum }) {
  const typeConf = TYPE_RULES[type] ?? TYPE_RULES.invite
  // Modo relación (vender sin vender): si la campaña define followup_tone_directive y esto es
  // un reply al lead (FM), el auto-reply NO empuja a cita — solo conversa. Sin directive el
  // comportamiento es idéntico (empuje a cita hardcodeado en fm_reply_*).
  const relationshipMode = Boolean(toneDirective && String(toneDirective).trim()) && String(type).startsWith('fm_reply')
  const sections = [
    campaignPrompt || 'Eres un SDR experto que envía mensajes en LinkedIn en español.',
    // (2026-07-06) identidad/contexto de campaña (Orion web IA) — solo si está configurado.
    ...(personaBlock ? ['', personaBlock] : []),
    // (2026) Cerebro de metodología de ventas (ai_playbook, jerárquico): principios + ejemplos/objeciones.
    // Guarded: sin entradas → brainBlock='' → prompt idéntico a antes.
    ...(brainBlock ? ['', brainBlock] : []),
    ...(relationshipMode ? ['', `DIRECTRIZ DE TONO (obligatoria): ${toneDirective}`] : []),
    '',
    // En modo relación NO usamos typeConf.description: las de fm_reply_2/3 dicen "Mueve hacia la
    // cita" / "Pregunta directa por fecha" y contradecirían la directriz de no empujar cita.
    `TIPO DE MENSAJE: ${relationshipMode ? 'respuesta al lead — la conversación está activa; conversa y construye relación, sin empujar a cita' : typeConf.description}`,
    `LÍMITE: máximo ${typeConf.maxChars} caracteres (cuenta uno por uno).`,
    `CIERRE OBLIGATORIO: termina SIEMPRE con punto final, signo de interrogación o exclamación cerrados. NUNCA dejes una oración a la mitad — si vas a quedarte sin espacio, acorta el mensaje y deja la oración COMPLETA.`,
    '',
    'REGLAS:',
    ...(relationshipMode ? FM_RELATIONSHIP_RULES : typeConf.rules).map(r => `- ${r}`),
  ]
  if (relationshipMode) {
    if (calUrl) sections.push('',
      `LINK DE CALENDARIO — úsalo ÚNICAMENTE si el lead PIDIÓ explícitamente una llamada, reunión o más información: ${calUrl}`,
      'Si el lead NO lo pidió, NO incluyas ningún link ni propongas agendar. Si SÍ lo pidió, inclúyelo COMPLETO y EXACTO con todos sus parámetros (?notes=...), sin acortarlo.')
  } else if (calUrl && (type === 'fm_reply_2' || type === 'fm_reply_3')) {
    sections.push('', `LINK DE CALENDARIO PARA AGENDAR: ${calUrl}`)
    sections.push('Incluye el link COMPLETO y EXACTO, con TODOS sus parámetros (?notes=...). NO lo acortes, NO lo modifiques, NO quites nada después del "?". Es un link de seguimiento — alterarlo lo rompe.')
  }
  // Intención previa: si en FM, incluye el ÚLTIMO FU template que se mandó al lead
  // para mantener coherencia con la "fase del funnel" en la que está la conversación.
  if (lastFuTemplate && type.startsWith('fm_reply')) {
    sections.push('',
      `INTENCIÓN DEL FOLLOW-UP PREVIO (FU${lastFuStepNum ?? '?'}) que ya enviaste a este lead:`,
      '"""',
      lastFuTemplate.slice(0, 800),
      '"""',
      'Tu respuesta debe MANTENER ESA INTENCIÓN ESTRATÉGICA (oferta, ángulo, valor que ya planteaste),',
      'pero tomar como punto de partida la respuesta del lead — NO repitas el FU, evoluciónalo.'
    )
  }
  if (exampleReply) {
    sections.push('', `EJEMPLO DE TONO Y ESTILO QUE FUNCIONA EN ESTA CAMPAÑA:`, `"${exampleReply}"`)
    sections.push('Úsalo como GUÍA de tono y estructura, NO copies literal.')
  }
  sections.push('', 'FORMATO DE RESPUESTA: SOLO el mensaje a enviar, texto plano. Sin comillas envolventes, sin prefijos tipo "Respuesta:", sin firma.')
  sections.push('', '🚫 PROHIBIDO: corchetes [ ], llaves { } o cualquier placeholder/instrucción de relleno (ej. "[menciona algo de su perfil]", "[Nombre]", "[empresa]"). Si te falta un dato del lead, OMÍTELO de forma natural — escribe la frase completa sin ese dato. El mensaje debe quedar 100% listo para enviarse tal cual, sin nada por rellenar.')
  sections.push('', NO_INVENT_COMPANY_RULE)
  return sections.join('\n')
}

// (2026) Cerebro de metodología de ventas: bloque a inyectar en el system prompt desde ai_playbook.
// JERÁRQUICO: entradas globales (campaign_id NULL) + las de la campaña. Portado de la lógica muerta
// ai.js:fetchPlaybookExamples + soporte de `kind` (principle|example|objection) + saneo anti-placeholder.
//   - principle → SIEMPRE se inyecta (metodología base), cap ~2000 chars.
//   - example / objection → se RECUPERAN por turno (applies_to_turns) + overlap de tags con el perfil, top-3.
// Guarded: sin entradas activas → devuelve '' → el prompt queda idéntico a hoy (cero regresión).
export async function fetchBrainBlock(campaign, lead, { turn = 0 } = {}) {
  try {
    const campaignId = campaign?.id
    let q = supabase
      .from('ai_playbook')
      .select('kind, title, situation, example_message, tags, applies_to_turns, outcome_count')
      .eq('is_active', true)
    q = campaignId
      ? q.or(`campaign_id.is.null,campaign_id.eq.${campaignId}`)   // global + los de esta campaña
      : q.is('campaign_id', null)
    const { data, error } = await q.limit(60)
    if (error || !data?.length) return ''

    // Principios: todos (son cortos), cap total defensivo estilo campaignPersonaBlock.
    const principles = data.filter(e => e.kind === 'principle')
    let principlesText = ''
    if (principles.length) {
      const body = principles
        .map(p => `- ${p.title}${p.example_message ? `: ${p.example_message}` : ''}`)
        .join('\n').slice(0, 2000)
      principlesText = `METODOLOGÍA DE VENTAS (principios que SIEMPRE debes seguir en este mensaje):\n${body}`
    }

    // Ejemplos/objeciones: filtra por turno + puntúa por overlap de tags con el perfil, top-3.
    const cases = data.filter(e => e.kind !== 'principle'
      && (!e.applies_to_turns?.length || e.applies_to_turns.includes(turn)))
    let casesText = ''
    if (cases.length) {
      const profileText = [
        lead?.profile_data?.headline, lead?.profile_data?.currentCompany,
        lead?.profile_data?.currentPosition, lead?.profile_data?.about,
      ].filter(Boolean).join(' ').toLowerCase()
      const scored = cases
        .map(e => {
          const overlap = (e.tags ?? []).filter(t => profileText.includes(String(t).toLowerCase())).length
          return { e, score: overlap + (e.outcome_count ?? 0) * 0.1 }
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(({ e }) => {
          const sit = e.situation ? `  Situación: ${e.situation}\n` : ''
          return `— ${e.title}\n${sit}  Mensaje: "${e.example_message}"`
        })
      casesText = `EJEMPLOS / MANEJO DE OBJECIONES QUE FUNCIONAN (referencia de enfoque y tono, NO copies literal):\n${scored.join('\n\n')}`
    }

    const block = [principlesText, casesText].filter(Boolean).join('\n\n')
    // Sanea corchetes/llaves para no disparar el guard anti-placeholder (hasLeftoverPlaceholder) en el output.
    return block ? block.replace(/[\[\]{}]/g, '') : ''
  } catch (err) {
    console.warn('[ai] fetchBrainBlock error:', err.message)
    return ''
  }
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
  const parts = []

  // 1. HISTORIAL PRIMERO (alta prioridad para que Gemini lo procese antes que el perfil)
  if (conversationHistory?.length) {
    parts.push('HISTORIAL DE LA CONVERSACIÓN (cronológico, más antiguo arriba):')
    for (const msg of conversationHistory) {
      const speaker = msg.direction === 'outbound' ? 'YO (sender)' : `LEAD (${lead.full_name?.split(' ')[0] ?? 'él/ella'})`
      const content = (msg.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)
      parts.push(`[${speaker}]: ${content}`)
    }
    // Destacar explícitamente el último mensaje del LEAD (al que respondes)
    const lastInbound = [...conversationHistory].reverse().find(m => m.direction === 'inbound')
    if (lastInbound) {
      const txt = (lastInbound.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)
      parts.push('',
        `>>> ÚLTIMO MENSAJE DEL LEAD (AL QUE DEBES RESPONDER COHERENTEMENTE):`,
        `"${txt}"`,
      )
    }
    parts.push('', 'TAREA CRÍTICA: Tu mensaje debe (1) RECONOCER explícitamente lo que dijo el lead arriba, (2) responderle con coherencia conversacional, (3) avanzar la conversación con la INTENCIÓN del FU previo descrita en el system prompt.')
  }

  // 2. PERFIL después (contexto secundario)
  parts.push('', buildUserPrompt(lead))

  if (calUrl) {
    parts.push('', `CAL_URL disponible (si lo incluyes, cópialo EXACTO con todos sus parámetros): ${calUrl}`)
  }
  return parts.join('\n')
}

// ── Llamadas CRUDAS por proveedor (devuelven texto trimmed, o lanzan) ───────────
async function callGroqRaw(systemPrompt, userPrompt, opts) {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('GROQ_API_KEY missing')
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      temperature: opts.temperature ?? 0.85,
      max_tokens: 500,
    }),
  })
  const j = await resp.json()
  if (j.error) throw new Error(`groq_${resp.status}: ${j.error.message || JSON.stringify(j.error)}`)
  return (j.choices?.[0]?.message?.content ?? '').trim()
}

async function callGeminiRaw(systemPrompt, userPrompt, opts) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY missing')
  const ai = new GoogleGenAI({ apiKey })
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    config: {
      systemInstruction: systemPrompt,
      temperature: opts.temperature ?? 0.85,
      maxOutputTokens: 500,
      thinkingConfig: { thinkingBudget: 0 },
    },
    contents: userPrompt,
  })
  return (response.text ?? '').trim()
}

function callProviderRaw(provider, systemPrompt, userPrompt, opts) {
  if (provider === 'groq')   return callGroqRaw(systemPrompt, userPrompt, opts)
  if (provider === 'gemini') return callGeminiRaw(systemPrompt, userPrompt, opts)
  return Promise.reject(new Error(`unknown LLM provider: ${provider}`))
}

// Punto ÚNICO de generación con FALLBACK entre proveedores. Intenta cada proveedor de
// LLM_PROVIDERS en orden; si uno falla (billing/timeout/vacío/placeholder irresoluble),
// cae al siguiente. Si todos fallan → { error } y el caller usa su fallback (template
// literal en FU / skip en auto-reply). Mata la fragilidad de proveedor único.
async function callLLM(systemPrompt, userPrompt, maxChars, opts = {}) {
  let lastError = 'no_llm_provider'
  for (let i = 0; i < LLM_PROVIDERS.length; i++) {
    const provider = LLM_PROVIDERS[i]
    const res = await callProvider(provider, systemPrompt, userPrompt, maxChars, opts)
    if (res.message) {
      if (i > 0) console.warn(`[ai] ✅ generado con fallback '${provider}' (proveedor primario falló)`)
      return res
    }
    lastError = `${provider}: ${res.error}`
    console.warn(`[ai] ⚠️ proveedor '${provider}' falló: ${res.error}${i < LLM_PROVIDERS.length - 1 ? ' → fallback' : ' (sin más fallbacks)'}`)
  }
  return { error: lastError }
}

async function callProvider(provider, systemPrompt, userPrompt, maxChars, opts) {
  const retries = opts.retries ?? 2
  let lastError
  // Timeout duro por llamada — sin esto, si la red al proveedor se estanca, el await
  // cuelga el tick completo del scheduler → watchdog mata el proceso (297s hang).
  const LLM_TIMEOUT_MS = opts.timeoutMs ?? 30_000
  const withLlmTimeout = (p) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${provider}_timeout_${LLM_TIMEOUT_MS}ms`)), LLM_TIMEOUT_MS)),
  ])
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      let text = await withLlmTimeout(callProviderRaw(provider, systemPrompt, userPrompt, opts))
      if ((text.startsWith('"') && text.endsWith('"')) ||
          (text.startsWith("'") && text.endsWith("'"))) {
        text = text.slice(1, -1).trim()
      }
      if (!text) { lastError = 'empty_response'; continue }
      if (text.length > maxChars) {
        // Truncación inteligente: SOLO en final de oración completa (. ? ! \n).
        // Evita cortar a mitad de pregunta como "...invertir 20" sin "minutos?".
        const truncated = text.slice(0, maxChars)
        // Buscar el último cierre de oración dentro del límite
        const sentenceEnd = Math.max(
          truncated.lastIndexOf('. '),
          truncated.lastIndexOf('? '),
          truncated.lastIndexOf('! '),
          truncated.lastIndexOf('.\n'),
          truncated.lastIndexOf('?\n'),
          truncated.lastIndexOf('!\n'),
          truncated.lastIndexOf('.'),  // último .recurso
          truncated.lastIndexOf('?'),
          truncated.lastIndexOf('!'),
        )
        if (sentenceEnd > maxChars * 0.5) {
          // Cortamos justo después de la puntuación (incluyéndola)
          text = truncated.slice(0, sentenceEnd + 1).trim()
        } else {
          // No hay punto razonable → mensaje muy largo y sin cierre, re-intenta con menos
          lastError = 'no_sentence_boundary'
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 800))
            continue
          }
          // Último recurso: corta en último espacio y añade signo de interrogación si parece pregunta
          const lastSpace = truncated.lastIndexOf(' ')
          text = (lastSpace > maxChars * 0.7 ? truncated.slice(0, lastSpace) : truncated).replace(/[,.;:\-]+$/, '').trim()
          if (text.toLowerCase().includes('qué') || text.toLowerCase().includes('cómo') || text.toLowerCase().startsWith('¿')) {
            text = text + '?'
          } else {
            text = text + '.'
          }
        }
      }
      // Última guardia: si termina con número o palabra sin puntuación, agrega cierre
      if (!/[.?!…]$/.test(text)) {
        text = text + (text.includes('?') || text.startsWith('¿') ? '?' : '.')
      }
      // 🛡️ GUARD ANTI-PLACEHOLDER: el AI a veces deja instrucciones de relleno
      // literales ("[menciona algo de su perfil]", "[Nombre]", "{nombre}", "[CAL_URL]")
      // que se enviaban CRUDAS al lead. NUNCA devolver texto con placeholders sin
      // resolver. Reintentamos (Gemini es no-determinista); si persiste, error →
      // el caller cae a template seguro (FU) o salta el envío (auto-reply).
      if (hasLeftoverPlaceholder(text)) {
        lastError = `leftover_placeholder: ${text.match(PLACEHOLDER_RE)?.[0]?.slice(0, 40)}`
        if (attempt < retries) { await new Promise(r => setTimeout(r, 600)); continue }
        return { error: 'leftover_placeholder' }
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
  const turn = type === 'invite' ? 0 : (parseInt(String(type).replace('follow_up_', ''), 10) || 0)
  const brainBlock = await fetchBrainBlock(campaign, lead, { turn })
  const systemPrompt = buildSystemPrompt({
    campaignPrompt: campaign.gemini_system_prompt,
    personaBlock: campaignPersonaBlock(campaign),
    brainBlock,
    type, exampleReply,
  })
  const userPrompt = buildUserPrompt(lead)
  const maxChars = TYPE_RULES[type]?.maxChars ?? 150
  return await callLLM(systemPrompt, userPrompt, maxChars, opts)
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
  calUrl = calUrlWithLeadId(calUrl, lead?.id)  // v0.7.45: link de cita rastreable por lead
  const stepKey = `follow_up_${fuStep}`
  const typeConf = TYPE_RULES[stepKey] ?? TYPE_RULES.follow_up_1
  const maxChars = typeConf.maxChars

  // El objetivo de los follow-ups es CONSTRUIR RELACIÓN, no vender. El tono lo
  // dicta el TEMPLATE (intención): si el template es un saludo cálido de relación,
  // el output debe ser cálido de relación; solo hay pitch/CTA/datos si el template
  // los tiene explícitamente. Esto se puede tunear por cuenta via runtime_config
  // 'followup_tone_directive' (default abajo) o por campaña editando los templates.
  const toneDirective = opts.toneDirective
    || `Los follow-ups de LinkedIn buscan CONSTRUIR RELACIÓN y mantener el contacto, NO vender. Sé cálido, humano y genuino — en plan de conocer a la persona, no de cerrar una venta.`
  const personaBlock = campaignPersonaBlock(campaign)
  const brainBlock = await fetchBrainBlock(campaign, lead, { turn: fuStep })
  const systemSections = [
    campaign.gemini_system_prompt || 'Eres una persona que escribe mensajes de LinkedIn naturales, cálidos y humanos en español.',
    ...(personaBlock ? ['', personaBlock] : []),
    ...(brainBlock ? ['', brainBlock] : []),
    '',
    toneDirective,
    '',
    `TAREA: PERSONALIZAR un template de mensaje LinkedIn — manteniendo la INTENCIÓN del template original pero adaptando el wording al lead específico.`,
    '',
    `MEJORA QUE QUEREMOS:`,
    `- MISMA intención y tono que el template original (si es un saludo cálido de relación, mantenlo así).`,
    `- Mismas piezas estructurales que el template: pregunta SOLO si el template tiene, dato SOLO si el template tiene, CTA SOLO si el template tiene.`,
    `- Lenguaje adaptado al cargo, industria y headline del lead (menciona su empresa SOLO si aparece abajo como "Empresa:").`,
    `- Tono: mismo que el template original (natural, cálido, humano).`,
    '',
    `LO QUE NO HAGAS:`,
    `- NO conviertas un saludo de relación en un pitch de venta. Si el template NO vende, tú NO vendes.`,
    `- NO agregues CTA, pregunta de venta, datos ni cifras que el template no tenga explícitamente.`,
    `- NO inventes datos numéricos (porcentajes, cifras).`,
    `- NO añadas información que no esté en el template o en el perfil del lead.`,
    `- ${NO_INVENT_COMPANY_RULE}`,
    `- NO uses emojis a menos que el template original los tenga.`,
    `- NO incluyas tu firma o nombre.`,
    '',
    `STEP DEL FU: ${fuStep} (${typeConf.description})`,
    `LÍMITE: máximo ${maxChars} caracteres.`,
  ]
  if (calUrl && template.toLowerCase().includes('cal') || template.includes('[CAL_URL]') || template.includes('{cal_url}')) {
    systemSections.push('', `LINK CALENDARIO: ${calUrl} — inclúyelo COMPLETO y EXACTO (con todos sus parámetros ?notes=...) si el template tiene CTA de llamada. NO lo acortes ni modifiques.`)
  }
  systemSections.push('', 'FORMATO: SOLO el mensaje personalizado, texto plano. Sin comillas, sin prefijos, sin firma.')
  systemSections.push('🚫 PROHIBIDO corchetes [ ], llaves { } o placeholders de relleno ("[menciona algo]", "[Nombre]"). Si te falta un dato, OMÍTELO naturalmente. El mensaje debe quedar listo para enviar tal cual.')

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
  userSections.push('', `Personaliza el template para este lead. Adapta lenguaje, ejemplos y referencias a su contexto (cargo e industria; su empresa SOLO si aparece arriba como "Empresa:").`)

  return await callLLM(systemPrompt, userSections.join('\n'), maxChars, opts)
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
  const calUrl = calUrlWithLeadId(ctx.calUrl ?? null, lead?.id)  // v0.7.45: link rastreable por lead
  const brainBlock = await fetchBrainBlock(campaign, lead, { turn: fmStep })
  const systemPrompt = buildSystemPrompt({
    campaignPrompt: campaign.gemini_system_prompt,
    personaBlock: campaignPersonaBlock(campaign),
    brainBlock,
    type, exampleReply, calUrl,
    toneDirective: campaign.followup_tone_directive ?? null,  // modo relación: no empujar cita en el reply
    lastFuTemplate: ctx.lastFuTemplate ?? null,
    lastFuStepNum:  ctx.lastFuStepNum ?? null,
  })
  const userPrompt = buildReplyUserPrompt(lead, ctx.conversationHistory ?? [], calUrl)
  const maxChars = TYPE_RULES[type]?.maxChars ?? 700
  return await callLLM(systemPrompt, userPrompt, maxChars, opts)
}

// ============================================================================
// Post-Prospecting (v0.9): calificar posts + redactar comentarios value-first
// ============================================================================

// ── JSON mode con fallback de proveedor (clasificación, p.ej. qualifyPost) ───────
// Pide JSON y parsea el objeto. NO aplica guard anti-placeholder ni truncación (eso es
// para DMs). Mismo patrón Groq-primario/Gemini-fallback que callLLM.
async function callGroqJsonRaw(systemPrompt, userPrompt, opts) {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('GROQ_API_KEY missing')
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      temperature: opts.temperature ?? 0.2,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    }),
  })
  const j = await resp.json()
  if (j.error) throw new Error(`groq_${resp.status}: ${j.error.message || JSON.stringify(j.error)}`)
  return (j.choices?.[0]?.message?.content ?? '').trim()
}

async function callGeminiJsonRaw(systemPrompt, userPrompt, opts) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY missing')
  const ai = new GoogleGenAI({ apiKey })
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    config: {
      systemInstruction: systemPrompt,
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: 300,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: 'application/json',
    },
    contents: userPrompt,
  })
  return (response.text ?? '').trim()
}

function callProviderJsonRaw(provider, systemPrompt, userPrompt, opts) {
  if (provider === 'groq')   return callGroqJsonRaw(systemPrompt, userPrompt, opts)
  if (provider === 'gemini') return callGeminiJsonRaw(systemPrompt, userPrompt, opts)
  return Promise.reject(new Error(`unknown LLM provider: ${provider}`))
}

async function callLLMJson(systemPrompt, userPrompt, opts = {}) {
  const retries = opts.retries ?? 2
  const LLM_TIMEOUT_MS = opts.timeoutMs ?? 30_000
  const withLlmTimeout = (provider, p) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${provider}_timeout_${LLM_TIMEOUT_MS}ms`)), LLM_TIMEOUT_MS)),
  ])
  let lastError = 'no_llm_provider'
  for (let i = 0; i < LLM_PROVIDERS.length; i++) {
    const provider = LLM_PROVIDERS[i]
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        let text = await withLlmTimeout(provider, callProviderJsonRaw(provider, systemPrompt, userPrompt, opts))
        if (!text) { lastError = `${provider}: empty_response`; continue }
        // Por si el modelo envuelve en ```json ... ```
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
        try {
          const data = JSON.parse(text)
          if (i > 0) console.warn(`[ai] ✅ JSON generado con fallback '${provider}'`)
          return { data }
        } catch {
          lastError = `${provider}: json_parse_error`
          if (attempt < retries) { await new Promise(r => setTimeout(r, 600)); continue }
        }
      } catch (err) {
        lastError = `${provider}: ${err.message ?? String(err)}`
        if (attempt < retries) await new Promise(r => setTimeout(r, 1500 * attempt))
      }
    }
    console.warn(`[ai] ⚠️ JSON proveedor '${provider}' falló: ${lastError}${i < LLM_PROVIDERS.length - 1 ? ' → fallback' : ''}`)
  }
  return { error: lastError }
}

/**
 * 🚪 SENSOR DE SALIDA: ¿el contacto cerró la puerta ("no gracias", "no me interesa")?
 * Devuelve { exit: boolean, reason: string } o { error }.
 *
 * El caller hace FAIL-OPEN (ante { error } sigue el flujo normal): un falso positivo
 * mata un lead real y es irreversible; un falso negativo solo cuesta un mensaje de más.
 * Por eso el prompt es asimétrico — ante la duda, exit=false.
 *
 * @param {string} lastInbound  - último mensaje del contacto (lo que se clasifica)
 * @param {string} lastOutbound - nuestro último mensaje; contexto para desambiguar un "no"
 *                                a una propuesta de horario vs un "no" a la conversación.
 */
export async function detectExitIntent(lastInbound, lastOutbound = '', opts = {}) {
  const text = String(lastInbound ?? '').trim()
  if (!text) return { exit: false, reason: 'empty_inbound' }

  const systemPrompt = [
    'Eres un clasificador de intención en conversaciones de prospección B2B por LinkedIn.',
    'Decide si el ÚLTIMO MENSAJE DEL CONTACTO cierra la puerta de forma DEFINITIVA.',
    '',
    'exit=true si el contacto rechaza la conversación o la oferta:',
    '- "no gracias", "no me interesa", "no estoy interesado", "no es para mí"',
    '- ya tiene proveedor / lo resuelve internamente y NO quiere alternativas',
    '- pide que no lo contacten más, que lo saquen de la lista, o se molesta por el contacto',
    '- declina CORTÉSMENTE sin dejar puerta abierta: "gracias, no por el momento", "por ahora no, gracias"',
    '',
    'exit=false si:',
    '- muestra interés, hace una pregunta, o pide info/precio',
    '- pospone DEJANDO PUERTA ABIERTA explícita al futuro: "escríbeme en 3 meses", "el próximo',
    '  trimestre sí", "búscame en enero", "más adelante lo vemos", "ahorita ando saturado, luego te busco"',
    '- rechaza SOLO el horario/canal propuesto, no la conversación ("el martes no puedo", "mejor por correo")',
    '- deriva con otra persona del equipo',
    '- responde algo ambiguo, corto o de cortesía ("ok", "gracias", "jaja")',
    '',
    'DISCRIMINADOR entre rechazo cortés y aplazamiento — es la distinción más importante:',
    '¿el contacto deja una PUERTA ABIERTA EXPLÍCITA al futuro (un horizonte, o una invitación a',
    'volver a escribirle)? SÍ → exit=false. NO → exit=true, aunque lo diga con mucha amabilidad.',
    'En español de negocios el "no" viene envuelto en cortesía: "gracias, no por el momento. Saludos"',
    'es un RECHAZO (exit=true), no un aplazamiento — no invita a nada. "Escríbeme en 3 meses" SÍ invita.',
    'CUENTA COMO PUERTA ABIERTA (exit=false) que el propio contacto se comprometa a re-contactar,',
    'aunque sea vago o suene a cortesía: "te comento en algunos meses", "en caso de requerir te busco",',
    '"yo te aviso", "cualquier cosa te escribo". Si menciona CUALQUIER horizonte futuro ("en unos meses",',
    '"el otro trimestre") → exit=false. Solo cierra cuando NO hay ninguna referencia al futuro.',
    '',
    '⚠️ CLASIFICA SOLO LA POSTURA DEL CONTACTO HACIA NUESTRA PROPUESTA. Si el contacto es quien OFRECE',
    'algo (una intro, un referido, su propio servicio) y se retira cortésmente de SU oferta, eso NO es',
    'un rechazo a nosotros → exit=false. Ejemplo: "si prefieres que no te refiera con inversionistas,',
    'dime y no te molesto más" = él ofrece y pregunta; NO nos está rechazando. No confundas quién',
    'rechaza a quién ni tomes un "no te molesto más" dicho por el contacto sobre SU propia oferta',
    'como si fuera una petición de no contactarlo.',
    '',
    'REGLA CRÍTICA: fuera de ese discriminador, ante la duda exit=false. NO infieras rechazo por',
    'tono seco, por un mensaje corto, ni por silencio.',
    '',
    'Responde SOLO un objeto JSON con exactamente estas llaves:',
    '{"exit": boolean, "reason": "frase corta en español citando qué lo indica"}',
  ].join('\n')

  const userPrompt = [
    lastOutbound ? `NUESTRO ÚLTIMO MENSAJE (solo contexto, NO lo clasifiques):\n"""${String(lastOutbound).slice(0, 600)}"""` : null,
    `ÚLTIMO MENSAJE DEL CONTACTO (esto es lo que clasificas):\n"""${text.slice(0, 1000)}"""`,
  ].filter(Boolean).join('\n\n')

  const res = await callLLMJson(systemPrompt, userPrompt, { temperature: 0, ...opts })
  if (res.error) return { error: res.error }
  const d = res.data ?? {}
  // Tolerante a proveedores que devuelven el bool como string; cualquier otra cosa → false (fail-open).
  const exit = d.exit === true || String(d.exit).toLowerCase() === 'true'
  return { exit, reason: String(d.reason ?? '').slice(0, 300) }
}

/**
 * Califica si un post de LinkedIn es una oportunidad real para nuestro servicio.
 * Devuelve { relevant: boolean, score: int(0-10), reason: string } o { error }.
 * El umbral (score >= qualify_min_score) lo compara el caller (bridge/scheduler).
 *
 * @param {string} postText - texto del post scrapeado
 * @param {string} serviceDescription - qué vendemos (post_campaigns.service_description)
 */
export async function qualifyPost(postText, serviceDescription, opts = {}) {
  const text = String(postText ?? '').trim()
  if (!text) return { relevant: false, score: 0, reason: 'empty_post' }

  const systemPrompt = [
    'Eres un filtro de relevancia comercial estricto. Tu trabajo es decidir si el autor de un post de LinkedIn',
    'está ACTIVAMENTE buscando, pidiendo o necesitando el servicio que ofrecemos — AHORA, no hipotéticamente.',
    '',
    `SERVICIO QUE OFRECEMOS:\n"""${String(serviceDescription ?? '').slice(0, 600)}"""`,
    '',
    'CRITERIO:',
    '- score 8-10: el autor pide explícitamente una recomendación/proveedor/ayuda que calza con nuestro servicio.',
    '- score 5-7: necesidad implícita o tangencial; podría encajar pero no lo pide directo.',
    '- score 0-4: solo menciona el tema, comparte contenido, busca empleo, o no tiene nada que ver.',
    'Sé ESTRICTO: ante la duda, baja el score. Preferimos NO comentar que comentar en un post irrelevante (riesgo de spam).',
    '',
    'Responde SOLO un objeto JSON con exactamente estas llaves:',
    '{"relevant": boolean, "score": number (0-10 entero), "reason": "frase corta en español explicando"}',
  ].join('\n')

  const userPrompt = `POST A EVALUAR:\n"""${text.slice(0, 1500)}"""`
  const res = await callLLMJson(systemPrompt, userPrompt, { temperature: 0.2, ...opts })
  if (res.error) return { error: res.error }
  const d = res.data ?? {}
  const score = Math.max(0, Math.min(10, Math.round(Number(d.score) || 0)))
  return {
    relevant: Boolean(d.relevant) && score > 0,
    score,
    reason: String(d.reason ?? '').slice(0, 300),
  }
}

/**
 * Extrae el nombre de la EMPRESA de una lista de headlines de LinkedIn, en UN solo call LLM (por lote).
 * items = [{ key, headline }] → array [{ key, company: string|null }] en éxito, o { error } si el LLM falla.
 * Gate anti-alucinación (reformulación de NO_INVENT_COMPANY_RULE a modo extracción): devuelve null si el
 * headline no trae una empresa EXPLÍCITA y clara, y NUNCA usa el cargo/título como empresa. El caller
 * escribe '' (centinela "revisado, sin empresa") cuando company=null; en { error } NO escribe → reintenta.
 */
export async function extractCompaniesFromHeadlines(items, opts = {}) {
  const clean = (items ?? [])
    .map((it, i) => ({ n: i + 1, key: it.key, h: String(it.headline ?? '').trim().slice(0, 200) }))
    .filter(x => x.h)
  if (clean.length === 0) return (items ?? []).map(it => ({ key: it.key, company: null }))

  const systemPrompt = [
    'Extraes el nombre de la EMPRESA a partir de headlines de LinkedIn. Devuelves SOLO JSON.',
    '',
    'REGLA CRÍTICA (anti-invención):',
    '- Extrae la empresa SOLO si aparece EXPLÍCITA y CLARA en el headline.',
    '- NUNCA inventes, adivines ni completes un nombre. Ante la duda → null.',
    '- NUNCA uses el cargo/título/rol (ej. "Director de Ventas", "CEO", "Founder", "Gerente")',
    '  como si fuera la empresa. Es un error grave.',
    '- No incluyas el cargo en el nombre: de "Founder & CEO INCOMEDIA SRL" la empresa es',
    '  "INCOMEDIA SRL", NO "Founder & CEO INCOMEDIA SRL".',
    '- Si el headline es solo un cargo, una descripción, fechas o texto sin un nombre de',
    '  empresa reconocible → null.',
    '- Copia el nombre tal cual aparece; corrige una errata SOLO si es obvia.',
    '',
    'FORMATO: objeto JSON con la llave "r" = array. Un elemento por CADA headline recibido,',
    'con su mismo número "k": {"k": <número>, "c": <string empresa | null>}.',
    'Ejemplo: {"r":[{"k":1,"c":"INCOMEDIA SRL"},{"k":2,"c":null}]}',
  ].join('\n')

  const userPrompt = 'HEADLINES:\n' + clean.map(x => `${x.n}: ${x.h}`).join('\n')

  const res = await callLLMJson(systemPrompt, userPrompt, { temperature: 0.2, ...opts })
  if (res.error) return { error: res.error }

  const rows = Array.isArray(res.data?.r) ? res.data.r : []
  const byN = new Map()
  for (const row of rows) {
    const n = Number(row?.k)
    if (!Number.isInteger(n)) continue
    let c = row?.c == null ? null : String(row.c).trim()
    // ponytail: gate de basura simple (largo + "debe tener letra") — descarta cargos-sueltos raros,
    // fechas y vacíos; sube el techo de 60 si aparecen empresas legítimas más largas.
    if (c && (c.length < 2 || c.length > 60 || !/[a-zA-ZÀ-ÿ]/.test(c))) c = null
    byN.set(n, c || null)
  }
  // n presente en items pero ausente del output del LLM → null (se marcará como revisado con '')
  const found = new Map(clean.map(x => [x.key, byN.get(x.n) ?? null]))
  return (items ?? []).map(it => ({ key: it.key, company: found.has(it.key) ? found.get(it.key) : null }))
}

/**
 * Redacta un comentario PÚBLICO value-first para un post.
 * Devuelve { message } o { error }. NUNCA recibe ni usa el pitch_note (eso es privado).
 * Reusa callGemini → guard anti-placeholder + truncación + cierre garantizado.
 *
 * @param {object} post - { author_name, author_headline, post_text }
 * @param {object} postCampaign - { gemini_system_prompt, comment_rules, service_description }
 */
export async function generatePostComment(post, postCampaign, opts = {}) {
  const typeConf = TYPE_RULES.post_comment
  const sections = [
    postCampaign.gemini_system_prompt
      || 'Eres un profesional con experiencia técnica real que comenta de forma genuina y útil en LinkedIn, en español.',
    '',
    `TIPO DE MENSAJE: ${typeConf.description}`,
    `LÍMITE: máximo ${typeConf.maxChars} caracteres.`,
    `CIERRE OBLIGATORIO: termina SIEMPRE con puntuación cerrada. Nunca dejes una frase a medias.`,
    '',
    'REGLAS:',
    ...typeConf.rules.map(r => `- ${r}`),
  ]
  if (postCampaign.comment_rules) {
    sections.push('', 'GUÍA ADICIONAL DEL CLIENTE PARA EL COMENTARIO:', postCampaign.comment_rules.slice(0, 800))
  }
  sections.push('', 'FORMATO DE RESPUESTA: SOLO el comentario a publicar, texto plano. Sin comillas envolventes, sin prefijos, sin firma.')
  sections.push('', '🚫 PROHIBIDO: corchetes [ ], llaves { }, placeholders, links, menciones a tu empresa/servicio, o cualquier CTA. El comentario debe quedar 100% listo para publicarse tal cual.')
  const systemPrompt = sections.join('\n')

  const userParts = [
    `POST DEL AUTOR (responde DIRECTAMENTE a lo que pide):`,
    `- Autor: ${post.author_name ?? '(desconocido)'}`,
  ]
  if (post.author_headline) userParts.push(`- Headline del autor: ${post.author_headline}`)
  userParts.push('', 'CONTENIDO DEL POST:', '"""', String(post.post_text ?? '').slice(0, 1500), '"""')
  userParts.push('', 'Escribe un comentario público breve y genuinamente útil sobre lo que pide. Aporta valor real, sin vender.')

  return await callLLM(systemPrompt, userParts.join('\n'), typeConf.maxChars, { temperature: 0.8, ...opts })
}
