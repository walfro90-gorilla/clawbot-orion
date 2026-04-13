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

// ── Generate AI reply draft using Gemini ──────────────────────────────────────
// Called fire-and-forget from inbox.js when a lead replies.
// The draft is stored in conversations.ai_reply_draft for human approval in Orion.
export async function generateReplyDraft({ leadName, outboundHistory, inboundMessage, calUrl } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const ai = new GoogleGenAI({ apiKey });

  const historyBlock = outboundHistory?.length
    ? outboundHistory.map(m => `- [Nosotros]: ${m}`).join('\n')
    : '(sin historial previo)';

  const calBlock = calUrl
    ? `\nTenemos disponibilidad para una llamada en: ${calUrl}\nSi la conversación lo permite, invítale a agendar una llamada de 20 minutos usando ese link.`
    : '';

  const prompt = `Eres un SDR experto en ventas B2B, redactas respuestas naturales y humanas.

El lead "${leadName ?? 'el lead'}" nos respondió en LinkedIn.

Historial de mensajes que le enviamos:
${historyBlock}

Mensaje recibido del lead:
"${inboundMessage ?? ''}"
${calBlock}

Redacta UN borrador de respuesta que:
1. Reconozca su mensaje de forma genuina y personalizada (no genérica).
2. Ofrezca valor concreto relacionado con lo que dijo.
3. Sea breve y natural (máx 150 palabras). Sin lenguaje corporativo.
4. Termine con una sola pregunta corta o un CTA claro.
5. NO suene a plantilla.${calUrl ? '\n6. Incluya el link de Cal.com de forma natural si el contexto lo permite.' : ''}

Responde ÚNICAMENTE con el texto del mensaje, sin comillas, sin prefijos, sin markdown.`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: 'Eres un SDR experto. Escribe respuestas de ventas breves, humanas y personalizadas.',
      temperature: 0.85,
      maxOutputTokens: 300,
      thinkingConfig: { thinkingBudget: 0 },
    },
    contents: prompt,
  });

  return response.text.trim();
}
