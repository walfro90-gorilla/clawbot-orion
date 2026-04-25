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
export async function generateReplyDraft({
  leadName,
  leadProfileData = {},
  conversationHistory = [],
  inboundMessage,
  calUrl,
  turnCount = 0,
  aiTone = 'casual',
  senderPersona = null,
  companyContext = null,
  exampleMessages = null,
} = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const ai = new GoogleGenAI({ apiKey });

  // Profile data — scraped at connection time, may be outdated
  const profile = leadProfileData ?? {};
  const profileSnippet = [
    profile.headline        ? `Cargo/Headline: ${profile.headline}` : null,
    (profile.headlineCompany ?? profile.company) ? `Empresa (al momento del scraping, puede haber cambiado): ${profile.headlineCompany ?? profile.company}` : null,
    profile.currentPosition ? `Posición actual (scraping): ${profile.currentPosition}` : null,
    profile.about           ? `Sobre él/ella: ${profile.about.slice(0, 300)}` : null,
    profile.location        ? `Ubicación: ${profile.location}` : null,
  ].filter(Boolean).join('\n') || 'Sin datos de perfil.';

  // Full conversation history — outbound + inbound chronologically
  const historyBlock = conversationHistory.length > 0
    ? conversationHistory
        .map(e => {
          const speaker = e.direction === 'outbound' ? 'NOSOTROS' : leadName ?? 'LEAD';
          return `[${speaker}]: ${(e.content ?? '').slice(0, 600)}`;
        })
        .join('\n')
    : '(sin historial previo)';

  // Turn-based strategy — only applies when no situational rule triggers
  let strategyBlock;
  if (turnCount === 0) {
    strategyBlock = `ESTRATEGIA TURNO 0 — RAPPORT (si no aplica ninguna situación especial):
- Reconoce su mensaje específicamente. NO repitas el mismo saludo genérico del historial.
- Menciona UN detalle de su perfil o empresa (SOLO si el historial no lo contradice).
- Haz UNA pregunta abierta sobre su trabajo o desafío actual.
- NO menciones ORION. NO incluyas Cal.com. Máx 80 palabras.`;
  } else if (turnCount <= 2) {
    strategyBlock = `ESTRATEGIA TURNO ${turnCount} — PROFUNDIZAR (si no aplica ninguna situación especial):
- Responde DIRECTAMENTE a lo que dijo. Demuestra que leíste su mensaje con atención.
- Si hace pregunta técnica, responde con contexto de EBOOMS/ORION.
- Si muestra interés, ofrece llamada 20 min${calUrl ? ` — link: ${calUrl}` : ''}.
- Si sigue neutral, haz otra pregunta de discovery. Máx 100 palabras.`;
  } else {
    strategyBlock = `ESTRATEGIA TURNO ${turnCount} — CIERRE (si no aplica ninguna situación especial):
- Respuesta breve y cálida. Ofrece sesión 20 min directamente.
${calUrl ? `- Link natural: ${calUrl}` : '- Pregunta disponibilidad directamente.'}
- Si rechaza, acepta con gracia. Sin insistir. Máx 80 palabras.`;
  }

  const prompt = `${EBOOMS_CONTEXT}

---

PERFIL DEL LEAD — ${leadName ?? 'Lead'} (datos del momento del scraping, PUEDEN estar desactualizados):
${profileSnippet}

⚠️ REGLA CRÍTICA: El historial de la conversación es tu ÚNICA fuente de verdad.
Si el lead menciona en el chat que ya no trabaja en algún lugar, que cambió de empresa, o que no es el contacto correcto → CREE AL HISTORIAL, no al perfil de arriba.

---

HISTORIAL COMPLETO DE LA CONVERSACIÓN (en orden cronológico):
${historyBlock}

ÚLTIMO MENSAJE DE ${leadName ?? 'el lead'}:
"${inboundMessage ?? ''}"

---

PASO 1 — ANTES DE ESCRIBIR, identifica en qué situación estás:

🔴 SITUACIÓN A: El lead dice que ya no trabaja en la empresa / cambió de trabajo
   → Reconoce el cambio con naturalidad. NO sigas preguntando sobre la empresa anterior.
   → Pregunta brevemente dónde trabaja ahora o en qué está enfocado. Máx 35 palabras.
   → Ejemplo: "Ah, entiendo! ¿Y actualmente en qué proyecto o empresa estás?"

🔴 SITUACIÓN B: El lead dice que no es el contacto correcto / que te refieras a otra persona
   → Agradece la aclaración. Pregunta cómo llegar a la persona correcta, o despídete con calidez.
   → Máx 35 palabras. Sin insistir.

🔴 SITUACIÓN C: El lead rechaza claramente (no le interesa, no tiene tiempo, no aplica)
   → Acepta con gracia. Deja la puerta abierta con una frase amable. Sin argumentar.
   → Máx 25 palabras.

🟡 SITUACIÓN D: El lead hizo una pregunta directa
   → Respóndela primero. Luego aplica la estrategia de turno.

🟡 SITUACIÓN E: El lead corrigió algo que dijiste o aclaró un malentendido
   → Reconócelo brevemente ("Claro, entiendo.") y ajusta el rumbo. NO repitas el error.

✅ SITUACIÓN F: Conversación normal (sin situaciones especiales)
   → Aplica la estrategia de turno:

${strategyBlock}

---

REGLA GLOBAL: Si el lead pregunta precio, disponibilidad, cómo funciona → responde con contexto EBOOMS y ofrece reunión 20 min${calUrl ? ` (${calUrl})` : ''}.

PROHIBIDO: Mencionar "LinkedIn", "notificaciones", "mensajes enviados antes de tiempo", o cualquier referencia al sistema técnico. El lead no debe saber que hay automatización.

Responde ÚNICAMENTE con el texto del mensaje. Sin comillas, sin prefijos, sin markdown.`;

  // Build tone instruction
  const toneGuide = {
    casual:       'Tono casual y amigable. Como si hablaras con un colega. Frases cortas, naturales. Puedes usar humor suave.',
    professional: 'Tono profesional y confiable. Claro, sin jerga. Respeto mutuo entre pares del mismo nivel.',
    executive:    'Tono ejecutivo y conciso. Ve al punto. Sin relleno. Hablas como C-level a C-level.',
    technical:    'Tono técnico y preciso. Puedes usar terminología del sector. Demuestra conocimiento profundo.',
  }
  const toneInstruction = toneGuide[aiTone] ?? toneGuide.casual

  // Company context: use custom if provided, else fallback to EBOOMS default
  const activeCompanyContext = companyContext?.trim() || EBOOMS_CONTEXT

  // Sender persona block
  const personaBlock = senderPersona?.trim()
    ? `QUIÉN ERES (escribe SIEMPRE con esta voz, no con voz genérica):
${senderPersona.trim()}`
    : `QUIÉN ERES: Un SDR experto representando a la empresa descrita abajo.`

  // Example messages block
  const examplesBlock = exampleMessages?.trim()
    ? `\nEJEMPLOS DE TU ESTILO DE ESCRITURA (replica este tono y longitud exactamente):
${exampleMessages.trim()}\n`
    : ''

  const finalPrompt = `${activeCompanyContext}

---

${personaBlock}

TONO DE COMUNICACIÓN: ${toneInstruction}
${examplesBlock}
---

PERFIL DEL LEAD — ${leadName ?? 'Lead'} (datos del scraping, PUEDEN estar desactualizados):
${profileSnippet}

⚠️ REGLA CRÍTICA: El historial de la conversación es tu ÚNICA fuente de verdad.
Si el lead menciona en el chat que ya no trabaja en algún lugar, que cambió de empresa, o que no es el contacto correcto → CREE AL HISTORIAL, no al perfil de arriba.

---

HISTORIAL COMPLETO DE LA CONVERSACIÓN (cronológico):
${historyBlock}

ÚLTIMO MENSAJE DE ${leadName ?? 'el lead'}:
"${inboundMessage ?? ''}"

---

PASO 1 — ANTES DE ESCRIBIR, identifica en qué situación estás:

🔴 SITUACIÓN A: El lead dice que ya no trabaja en la empresa / cambió de trabajo
   → Reconoce el cambio con naturalidad. NO sigas preguntando sobre la empresa anterior.
   → Pregunta brevemente dónde trabaja ahora o en qué está enfocado. Máx 35 palabras.

🔴 SITUACIÓN B: El lead dice que no es el contacto correcto / te refiere a alguien más
   → Agradece la aclaración. Pregunta cómo llegar a la persona correcta, o despídete con calidez.
   → Máx 35 palabras. Sin insistir.

🔴 SITUACIÓN C: El lead rechaza claramente (no le interesa, no tiene tiempo, no aplica)
   → Acepta con gracia. Deja la puerta abierta. Sin argumentar. Máx 25 palabras.

🟡 SITUACIÓN D: El lead hizo una pregunta directa → Respóndela primero.

🟡 SITUACIÓN E: El lead corrigió algo → Reconócelo brevemente y ajusta el rumbo.

✅ SITUACIÓN F: Conversación normal → Aplica la estrategia de turno:

${strategyBlock}

---

REGLA GLOBAL: Si el lead pregunta precio, disponibilidad, cómo funciona → responde con contexto de la empresa y ofrece reunión 20 min${calUrl ? ` (${calUrl})` : ''}.

PROHIBIDO: Mencionar "LinkedIn", "notificaciones", "mensajes enviados antes de tiempo", o cualquier referencia al sistema técnico.

Responde ÚNICAMENTE con el texto del mensaje. Sin comillas, sin prefijos, sin markdown.`

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: `Eres el asistente de escritura de un SDR. Tu trabajo es escribir mensajes de LinkedIn que suenen exactamente como la persona descrita en "QUIÉN ERES". SIEMPRE lees el historial completo antes de responder. Adaptas la respuesta a la situación real, no a un script.`,
      temperature: 0.8,
      maxOutputTokens: 350,
      thinkingConfig: { thinkingBudget: 0 },
    },
    contents: finalPrompt,
  });

  return response.text.trim();
}

// ── Qualify an inbound message — is this a potential lead or a vendor/spam? ──
// Fast, cheap call. Returns { qualified, reason, signal }
// signal: 'lead' | 'vendor' | 'spam' | 'recruiter' | 'unknown'
export async function qualifyInboundMessage({ senderName, messageText, accountContext = '' }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `Analiza este mensaje de LinkedIn y clasifícalo.

REMITENTE: ${senderName ?? 'Desconocido'}
MENSAJE:
"${messageText ?? ''}"

${accountContext ? `CONTEXTO DE LA CUENTA RECEPTORA: ${accountContext}` : ''}

Clasifica el mensaje en UNA de estas categorías:
- "lead": Persona que puede ser un cliente potencial. Muestra interés, curiosidad, hace preguntas sobre los servicios, es un decisor, o simplemente quiere conectar (dar el beneficio de la duda a mensajes cortos como "Hola").
- "vendor": Alguien que quiere VENDERNOS algo. Señales: "te ofrezco", "ofrecemos", "somos una agencia/empresa", "podemos ayudarte a", propuestas comerciales.
- "recruiter": Headhunter o reclutador buscando contratar.
- "spam": Mensaje genérico masivo, sin personalización, copy-paste evidente.
- "unknown": No se puede determinar con la información disponible.

Regla: ante la duda entre "lead" y "unknown", clasifica como "lead".

Responde ÚNICAMENTE con JSON válido:
{"signal": "lead|vendor|recruiter|spam|unknown", "qualified": true|false, "reason": "una frase corta explicando la clasificación"}

qualified = true solo si signal es "lead".`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      config: {
        temperature: 0.3,
        maxOutputTokens: 100,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
      },
      contents: prompt,
    });
    return JSON.parse(response.text.trim());
  } catch {
    return { signal: 'unknown', qualified: true, reason: 'No se pudo clasificar — asumiendo lead por defecto' };
  }
}
