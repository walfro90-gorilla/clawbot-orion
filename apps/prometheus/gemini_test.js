import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

// ── Mock profile JSON (output from the extraction phase) ──────────────────────
const mockProfile = {
  profileUrl: 'https://www.linkedin.com/in/williamhgates/',
  scrapedAt: '2026-04-01T12:00:00.000Z',
  name: 'Bill Gates',
  headline: 'Co-chair, Bill & Melinda Gates Foundation',
  location: 'Seattle, Washington, United States',
  about:
    'Co-chair of the Bill & Melinda Gates Foundation. ' +
    'Technologist, business leader, and philanthropist. ' +
    'Focused on global health, development, and climate change.',
  currentPosition: 'Co-chair',
  currentCompany: 'Bill & Melinda Gates Foundation',
};

// ── System prompt (Ebooms SDR rules) ─────────────────────────────────────────
const SYSTEM_PROMPT = `
Eres un experto en desarrollo de negocios B2B (SDR).
Tu objetivo es iniciar una conversación casual en LinkedIn.
Reglas ESTRICTAS:
1) Lee el JSON del perfil provisto.
2) Redacta un mensaje de conexión de MÁXIMO 50 palabras.
3) Menciona un detalle específico de su experiencia o "Acerca de" para demostrar que leíste su perfil.
4) Tono casual, como si le hablaras a un colega tomando un café. CERO lenguaje corporativo.
5) NO intentes vender nada en este primer mensaje.
6) Termina obligatoriamente con una pregunta corta y abierta relacionada con su rol actual para invitar a la respuesta.
`.trim();

async function generateMessage(profileData) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[CEREBRO] ERROR: GEMINI_API_KEY no está definida en .env');
    process.exit(1);
  }

  const ai = new GoogleGenAI({ apiKey });

  const userPrompt = `Aquí está el JSON del perfil de LinkedIn:\n\n${JSON.stringify(profileData, null, 2)}`;

  console.log('[CEREBRO] Enviando perfil a Gemini 2.5 Flash...\n');

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.9,
      maxOutputTokens: 300,
      // Deshabilitar thinking: gemini-2.5-flash piensa por defecto y
      // consume tokens de output, cortando el mensaje antes de terminar
      thinkingConfig: { thinkingBudget: 0 },
    },
    contents: userPrompt,
  });

  return response.text;
}

async function run() {
  console.log('[CEREBRO] ── Perfil de entrada (Mock) ────────────────────────');
  console.log(JSON.stringify(mockProfile, null, 2));
  console.log('[CEREBRO] ──────────────────────────────────────────────────────\n');

  const message = await generateMessage(mockProfile);

  console.log('[CEREBRO] ── Mensaje generado por Gemini ─────────────────────');
  console.log(message);
  console.log('[CEREBRO] ──────────────────────────────────────────────────────');

  const wordCount = message.trim().split(/\s+/).length;
  console.log(`\n[CEREBRO] Conteo de palabras: ${wordCount}/50`);
  if (wordCount > 50) {
    console.warn('[CEREBRO] ADVERTENCIA: El mensaje supera el límite de 50 palabras. Ajusta el prompt o maxOutputTokens.');
  }
}

run().catch((err) => {
  console.error('[CEREBRO] Fatal error:', err.message ?? err);
  process.exit(1);
});
