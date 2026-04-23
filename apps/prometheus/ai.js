import { GoogleGenAI } from '@google/genai';

// ── Build system prompt from a message_template DB row ───────────────────
// Falls back to hardcoded defaults if template fields are null.
function buildSystemPrompt(template = {}, blacklist = []) {
  const maxChars = template.max_chars || 150;
  const blacklistRule = blacklist.length > 0
    ? `\n- El puesto/headline contiene alguna de estas palabras clave a ignorar: ${blacklist.map(b => `"${b}"`).join(', ')}.`
    : '';

  const qualificationRules = (template.qualification_rules || `Descalifica el lead (isQualified: false) SOLO si se cumple UNA de estas condiciones:
- La persona está fallecida o el perfil es un memorial/tributo.
- La cuenta es administrada por terceros "en memoria de" alguien.
- El perfil indica explícitamente que la persona está retirada y sin actividad profesional.
- El nombre sugiere que es una cuenta ficticia, bot, o empresa disfrazada de persona.
- Los campos "headline", "about" Y "currentPosition" son los TRES null al mismo tiempo.
IMPORTANTE: Si "headline" tiene cualquier texto (aunque "about" y "currentPosition" sean null), el lead ES calificado.`) + blacklistRule;

  const messageRules = template.message_rules || `Redacta UN mensaje de conexión. Menciona un detalle específico de su rol o empresa. Tono casual. CERO lenguaje corporativo. Termina con una pregunta corta y abierta. Si dudas entre dos versiones, elige la más corta.`;

  const openingHint = template.opening_hint
    ? `\nCOMO EMPEZAR: ${template.opening_hint}`
    : '';

  const exampleGood = template.example_good
    ? `\nEJEMPLO IDEAL: "${template.example_good}"`
    : '';

  const exampleBad = template.example_bad
    ? `\nEVITAR: "${template.example_bad}"`
    : '';

  return `Eres un SDR experto y un analista de datos. Analizarás el perfil JSON proporcionado.

REGLA 1 (Calificación): ${qualificationRules}

REGLA 2 (Mensaje): Si el lead ES calificado, ${messageRules}
- LÍMITE ABSOLUTO: ${maxChars} CARACTERES MÁXIMO (cuenta uno por uno antes de responder — si supera ${maxChars}, recorta).${openingHint}${exampleGood}${exampleBad}

REGLA 2b (Asunto InMail): Genera también un asunto corto para InMail de MÁXIMO 60 caracteres.
- Debe parecer natural, NO spam, NO clickbait.
- Relacionado directamente con su rol o empresa.

REGLA 3 (Formato): Tu respuesta DEBE ser ÚNICAMENTE un objeto JSON válido con esta estructura exacta, sin texto adicional, sin markdown:
{
  "isQualified": boolean,
  "disqualificationReason": "string o null",
  "generatedSubject": "Asunto máx 60 chars o null",
  "generatedMessage": "Mensaje máx ${maxChars} chars o null"
}`.trim();
}

export async function generateMessage(profileData, { retries = 3, retryDelayMs = 10000, template = null, blacklist = [] } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY no está definida en .env');
  }

  const ai = new GoogleGenAI({ apiKey });
  const systemPrompt = buildSystemPrompt(template || {}, blacklist);
  const userPrompt = `Aquí está el JSON del perfil de LinkedIn:\n\n${JSON.stringify(profileData, null, 2)}`;

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.9,
          maxOutputTokens: 400,
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: 'application/json',
        },
        contents: userPrompt,
      });

      const raw = response.text.trim();
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`Gemini devolvió JSON inválido:\n${raw}`);
      }
    } catch (err) {
      lastError = err;
      const is429 = err?.status === 429 || err?.message?.includes('429') || err?.message?.includes('RESOURCE_EXHAUSTED');
      if (is429 && attempt < retries) {
        // Extract retry delay from error message if available
        const match = err.message?.match(/retry in ([\d.]+)s/i);
        const wait = match ? Math.ceil(parseFloat(match[1])) * 1000 + 1000 : retryDelayMs;
        console.warn(`[CEREBRO] Rate limit hit (attempt ${attempt}/${retries}). Retrying in ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

// ── EBOOMS persona + FAQ context for reply drafts ────────────────────────────
const EBOOMS_CONTEXT = `
IDENTIDAD Y EMPRESA:
Representas a EBOOMS. Somos una agencia de automatización B2B especializada en LinkedIn.
Ayudamos a empresas a generar prospectos calificados de forma predecible mediante campañas automatizadas.
Nuestro sistema se llama ORION — opera en LinkedIn todos los días en piloto automático.

PROPUESTA DE VALOR CLAVE:
- Un equipo comercial dedica en promedio solo 48 de sus 160 horas mensuales a atraer negocio nuevo.
- ORION resuelve eso: identifica decisores, abre conversaciones y entrega prospectos calificados.
- Primer mes: ~100 conexiones con decisores reales, entre 2 y 3 citas calificadas.
- A partir del tercer mes: entre 5 y 10 citas mensuales con empresas nuevas.
- Sin permanencia forzada — mes a mes.
- Costo: menos que contratar un vendedor de medio tiempo.

OBJETIVO DE LA CONVERSACIÓN:
Siempre llevar al prospecto a agendar una sesión estratégica de 20 minutos.
No cerrar venta en LinkedIn — solo conseguir la cita.

PREGUNTAS FRECUENTES — CÓMO RESPONDER:
P: ¿Cuánto cuesta? → No dar precio exacto; invitar a la reunión de 20 min para calcular ROI juntos.
P: ¿Esto realmente funciona? → El sistema ya opera para empresas en su industria; mostrar datos reales en reunión.
P: Estoy muy ocupado → Exactamente el problema que ORION resuelve; solo 20 minutos esta semana.
P: Ya tenemos equipo de ventas → ORION no reemplaza al equipo, le da prospectos calificados. ¿Cuántos genera LinkedIn hoy?
P: No confío en IA → Está entrenado con propuesta de valor del cliente, no improvisa; el prospecto siente que hay persona real.
P: En mi industria LinkedIn no funciona → Los decisores B2B están activos en LinkedIn aunque no publiquen. ¿Cuántos hay en su región?
P: Mándame información por correo → Un PDF no muestra datos reales; 20 minutos sí. ¿Cuándo tienen disponibilidad?
P: ¿Hay casos de éxito? → Sí, aunque confidencial por nombre; mostrar en reunión con industrias similares.
P: No me interesa → Respetar decisión; preguntar qué hace que no sea relevante en este momento.
P: Lo voy a pensar → Sin presión; ¿qué genera la duda? Quizás se puede resolver ahora.
P: ¿Hay contrato? → Sin permanencia forzada, mes a mes. Explicar en reunión de 20 min.
P: ¿No me restringen la cuenta de LinkedIn? → Controles de volumen diseñados para comportamiento humano natural. Tasa de restricciones prácticamente cero.
P: ¿Garantizan resultados? → Garantizamos el sistema funcionando; resultados dependen de industria y propuesta de valor.
P: ¿Cuánto tarda en arrancar? → 5-7 días hábiles. Semana 1 ya con conversaciones activas.
P: ¿Cómo me genera ventas? → ORION no cierra ventas, abre puertas. Tu equipo cierra.
`.trim();

// ── Generate AI reply draft using Gemini — multi-turn conversation engine ──────
// Called fire-and-forget from inbox.js when a lead replies.
// The draft is stored in conversations.ai_reply_draft for human approval or auto-send.
export async function generateReplyDraft({
  leadName,
  leadProfileData = {},
  conversationHistory = [],
  inboundMessage,
  calUrl,
  turnCount = 0,
} = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const ai = new GoogleGenAI({ apiKey });

  // Extract key fields from profile_data JSONB
  const profile = leadProfileData ?? {};
  const profileSnippet = JSON.stringify({
    headline:        profile.headline        ?? null,
    company:         profile.headlineCompany ?? profile.company ?? null,
    currentPosition: profile.currentPosition ?? null,
    about:           profile.about           ?? null,
    location:        profile.location        ?? null,
  }, null, 2);

  // Build full conversation history block (inbound + outbound)
  const historyBlock = conversationHistory.length > 0
    ? conversationHistory
        .map(e => {
          const speaker = e.direction === 'outbound' ? 'Nosotros' : (leadName ?? 'Lead');
          return `[${speaker}]: ${(e.content ?? '').slice(0, 500)}`;
        })
        .join('\n')
    : '(primera interacción — sin historial previo)';

  // Turn-based strategy instructions
  let strategyBlock;
  if (turnCount === 0) {
    strategyBlock = `PRIMERA RESPUESTA — TURNO 0
OBJETIVO: Crear rapport genuino. NO vender. NO mencionar ORION todavía.
- Reconoce su mensaje de forma específica y personal.
- Menciona UN detalle concreto de su perfil o empresa que sea relevante.
- Haz UNA sola pregunta abierta sobre su negocio o desafío actual.
- NO incluyas link de Cal.com.
- Máx 80 palabras. Tono casual, como entre colegas.`;
  } else if (turnCount <= 2) {
    strategyBlock = `CONVERSACIÓN EN CURSO — TURNO ${turnCount}
OBJETIVO: Profundizar, mostrar valor sutilmente.
- Responde directamente a lo que dijo. Muestra que leíste con atención.
- Si hizo una pregunta técnica, respóndela usando el contexto de EBOOMS/ORION.
- Si muestra interés claro o curiosidad, puedes mencionar que ayudamos a empresas similares.
- Si su tono es positivo o hace preguntas sobre cómo funciona: ofrece una llamada de 20 min${calUrl ? ` usando ${calUrl}` : ''}.
- Si sigue neutral o exploratorio, haz otra pregunta de discovery sobre su proceso comercial.
- Máx 100 palabras.`;
  } else {
    strategyBlock = `TURNO AVANZADO — TURNO ${turnCount}
OBJETIVO: Cerrar la reunión de 20 minutos.
- Responde su mensaje brevemente y con calidez.
- Ofrece la sesión estratégica de 20 min de forma directa pero sin presión.
${calUrl ? `- Incluye el link de forma natural: ${calUrl}` : '- Pregunta directamente cuándo tiene disponibilidad.'}
- Si rechaza claramente, acepta con gracia y deja la puerta abierta. Sin insistir.
- Máx 80 palabras.`;
  }

  const prompt = `${EBOOMS_CONTEXT}

---

PERFIL DEL LEAD (${leadName ?? 'Lead'}):
${profileSnippet}

HISTORIAL COMPLETO DE LA CONVERSACIÓN:
${historyBlock}

ÚLTIMO MENSAJE RECIBIDO DE ${leadName ?? 'el lead'}:
"${inboundMessage ?? ''}"

---

${strategyBlock}

REGLA GLOBAL: Si el lead directamente pregunta por precio, disponibilidad, cómo funciona el sistema o quiere saber más →
responde con contexto de EBOOMS y ofrece la reunión de 20 min${calUrl ? ` con ${calUrl}` : ''} SIN importar el turno.

Responde ÚNICAMENTE con el texto del mensaje. Sin comillas, sin prefijos, sin markdown.`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: 'Eres un SDR experto en ventas B2B. Escribe respuestas breves, humanas, personalizadas y estratégicas.',
      temperature: 0.85,
      maxOutputTokens: 350,
      thinkingConfig: { thinkingBudget: 0 },
    },
    contents: prompt,
  });

  return response.text.trim();
}
