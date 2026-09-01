// Self-check de los guards del auto-reply (17-ago-2026). Dos incidentes reales:
//   1. "User Safety: safe." — el veredicto del clasificador de Groq/llama se envió CRUDO
//      a un lead (Nicolas Cuevas, cuenta Wal): pasaba placeholder-guard, cap y puntuación.
//   2. A un reclutador técnico el FM le contestó como candidato INVENTANDO experiencia,
//      porque el prompt asumía "prospecto" para todo inbound.
// Correr: node apps/prometheus/scripts/test-reply-guards.js
// (importa las funciones REALES; stubea las env de Supabase porque lib/supabase.js las
//  exige al importar — createClient no hace red, así que el stub es inocuo.)
import assert from 'node:assert/strict'

process.env.SUPABASE_URL ||= 'https://selfcheck.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'selfcheck-key-not-real'

const { isMetaOutput, inboundRoleBlock, buildSystemPrompt, resolveProvider, findUnapprovedContact } = await import('../lib/ai-message.js')

// ── 0. Rarezas por proveedor que NO se pueden "limpiar" sin romper el envío ─────
// Kimi devuelve 400 con cualquier temperature != 1, y sus tokens de razonamiento se
// comen el cap de max_tokens (JSON truncado → vacío). Ambos campos son obligatorios.
const kimi = resolveProvider('moonshot')
assert.equal(kimi?.fixedTemperature, 1, 'kimi solo acepta temperature=1')
assert.ok((kimi?.tokenMultiplier ?? 1) > 1, 'kimi necesita presupuesto extra por el razonamiento')
assert.ok(kimi.baseUrl.includes('moonshot.ai'), 'el host .cn rechaza la key')

// Groq quedó en la misma situación que Kimi: su catálogo ya solo tiene modelos de
// razonamiento, y con el cap de 500 tokens devolvía `content` vacío 233 de 233 veces
// (primario de paga muerto 3 días, cadena cayendo a los gratuitos).
const groq = resolveProvider('groq')
assert.ok((groq?.tokenMultiplier ?? 1) > 1, 'gpt-oss gasta el presupuesto razonando')
assert.equal(groq?.reasoningEffort, 'low', 'sin esto vuelve a devolver vacío')

// ── 1. Anti-meta: lo que NO es un mensaje ──────────────────────────────────────
assert.equal(isMetaOutput('User Safety: safe.'), true, 'el caso real de prod debe bloquearse')
assert.equal(isMetaOutput('user safety: unsafe'), true)
assert.equal(isMetaOutput('Respuesta: Hola Nicolas, un gusto conectar contigo por aquí.'), true, 'prefijo meta')
assert.equal(isMetaOutput('Output: mensaje'), true)
assert.equal(isMetaOutput(''), true)
assert.equal(isMetaOutput(null), true)
assert.equal(isMetaOutput('Claro, te comparto.'), true, 'demasiado corto para ser un DM real')

// ── 1b. Razonamiento filtrado — los 4 textos que SÍ llegaron a leads reales ────
// 23/24-ago-2026: `openrouter/free` rutea a un modelo gratis distinto por llamada y
// varios vuelcan su análisis en `content`. Se enviaron tal cual porque la truncación
// corría ANTES del guard: se quedaba con la cabeza (el análisis) y tiraba la respuesta.
const FILTRADOS_REALES = [
  'We need to produce a single response (max 320 characters including spaces). Must be plain text, no quotes, no placeholders, ends with punctuation . ? ! . Must address the lead\'s statement: "Yo vendo inversión forestal y certificados de carbono, eso es un mercado muy específico y muy limitado de qué fuente ustedes?',
  'Vamos a analizar la situación paso a paso.\n\n1. **Historial de la conversación:**\n   - Yo envié un primer mensaje a Javier.',
  'We need to produce a personalized LinkedIn connection message in Spanish, max 150 characters, warm and direct, no emojis, no generic phrases like "espero que estés bien".',
  'Okay, the user is Joshua, who sells AI automation. The lead asked for his contact details to share with people who see this.',
]
for (const m of FILTRADOS_REALES)
  assert.equal(isMetaOutput(m), true, `razonamiento que se envió a un lead: "${m.slice(0, 45)}…"`)

// El markdown es señal por sí solo: LinkedIn no lo renderiza, así que unas **negritas**
// en un DM son estructura de análisis, no un mensaje escrito para una persona.
assert.equal(isMetaOutput('Hola Javier, te comparto **tres ideas** que podrían servirte para el equipo comercial.'), true, 'markdown en un DM')

// ── 2. …y lo que SÍ debe pasar (mensajes reales de prod) ───────────────────────
const REALES = [
  'Hola Nicolas, un gusto conectar. Trabajo en temas de tecnología e innovación y me gusta ir sumando a mi red a personas con trayectorias como la tuya.',
  '¡Hola Jesús! Gracias por tu respuesta. Vi que estás en el Bajío y manejas logística con RochaXLogistics. ¿Cómo están resolviendo hoy el transporte?',
  'Te entiendo, y muchas gracias. Quedamos atentos a cualquier duda. ¡Saludos!',
  'Me alegra que hayas respondido, Gerardo. ¿En qué te gustaría conversar hoy?',
  // Frontera del detector: arrancan parecido a un análisis pero son mensajes legítimos.
  'Vamos a lo concreto: ayudo a equipos comerciales a automatizar seguimiento y prospección. ¿Te late una llamada corta?',
  'Primero que nada gracias por responder, Andreas. Los contactos salen de búsquedas públicas en LinkedIn, nada comprado.',
  'Okey, entiendo tu punto y lo respeto. Si más adelante lo vuelves a evaluar, aquí ando. ¡Saludos!',
]
for (const m of REALES) assert.equal(isMetaOutput(m), false, `falso positivo: "${m.slice(0, 40)}…"`)

// ── 3. Rol del inbound: conducta por quién escribe ─────────────────────────────
assert.equal(inboundRoleBlock('prospect'), null, 'prospecto = prompt idéntico al de siempre')
assert.equal(inboundRoleBlock('other'), null)
assert.equal(inboundRoleBlock(undefined), null)

const vendor = inboundRoleBlock('vendor')
assert.match(vendor, /PROVEEDOR\/VENDEDOR/)
assert.match(vendor, /PROHIBIDO pitchear de vuelta/)

const PERFIL = {
  cv_url: 'https://ejemplo.com/cv.pdf',
  portfolio_url: 'https://ejemplo.com',
  github_url: 'https://github.com/ejemplo',
  note: '8 años en backend, Node y Postgres.',
}
const rec = inboundRoleBlock('recruiter', PERFIL)
for (const url of [PERFIL.cv_url, PERFIL.portfolio_url, PERFIL.github_url])
  assert.ok(rec.includes(url), `falta el link ${url}`)
assert.match(rec, /NUNCA INVENTES/, 'el anti-alucinación es el núcleo de este bloque')
assert.match(rec, /PROHIBIDO vender/)
assert.ok(rec.includes(PERFIL.note))

// Sin materiales configurados: sigue siendo honesto, pero no promete links que no hay.
const recSinLinks = inboundRoleBlock('recruiter')
assert.match(recSinLinks, /NUNCA INVENTES/)
assert.ok(!recSinLinks.includes('http'), 'sin config no debe inventar URLs')

// ── 4. El bloque entra SOLO en replies, y al final (gana al pitch de la campaña) ─
const promptReply = buildSystemPrompt({ type: 'fm_reply_2', roleBlock: rec, calUrl: 'https://cal.com/x' })
assert.ok(promptReply.includes(PERFIL.github_url), 'el reply debe llevar el bloque de rol')
assert.ok(promptReply.trimEnd().endsWith(rec.trimEnd()), 'el bloque de rol va al FINAL del prompt')

const promptFu = buildSystemPrompt({ type: 'follow_up_1', roleBlock: rec })
assert.ok(!promptFu.includes(PERFIL.github_url), 'un FU outbound NUNCA lleva el bloque de rol')

// ── 5. Guard anti-contacto-inventado (01-sep-2026: "+52 1 81 5555 1234" a Jennifer) ─
// El corpus del guard = system+user prompt: todo dato legítimo YA viene ahí.
const CORPUS = [
  'LINK DE CALENDARIO: https://cal.com/jorge-joshua-sanchez-dominguez-8mtqse/30min?notes=LEAD_ID%3Dabc',
  'Historial: [lead] Gracias, favor de mándame email con tu Company Profile a carmedina@borgwarner.com',
  'Datos: tel comercial +52 81 1234 5678.',
].join('\n')

// El caso real: teléfono placeholder inventado → detectado
assert.equal(findUnapprovedContact('Mi número es +52 1 81 5555 1234; llámame.', CORPUS), '+52 1 81 5555 1234')
// El caso real #2: calendly fabricado con el nombre de la empresa → detectado
assert.ok(findUnapprovedContact('Reserva en https://calendly.com/cafe57/20min.', CORPUS))
// Teléfono que SÍ está en la config pasa, aunque cambie el formato
assert.equal(findUnapprovedContact('Márcanos al 81-1234-5678 cuando gustes.', CORPUS), null)
// Email que el LEAD dio en el hilo se puede repetir
assert.equal(findUnapprovedContact('Te envío el profile a carmedina@borgwarner.com.', CORPUS), null)
// Email inventado → detectado
assert.equal(findUnapprovedContact('Escríbeme a ventas@cafe57.mx.', CORPUS), 'ventas@cafe57.mx')
// El cal_url configurado pasa con sus parámetros por-lead
assert.equal(findUnapprovedContact('Agenda aquí: https://cal.com/jorge-joshua-sanchez-dominguez-8mtqse/30min?notes=LEAD_ID%3Dabc', CORPUS), null)
// Cifras normales de un DM NO son teléfonos: horas, rangos, años, porcentajes
assert.equal(findUnapprovedContact('¿Te parece 20-30 min el jueves a las 11:00? Llevamos desde 2001, 99% a tiempo.', CORPUS), null)
// Texto sin datos de contacto pasa limpio
assert.equal(findUnapprovedContact('Jennifer, hacemos ambos: cruces México-EE UU y doméstico.', CORPUS), null)

console.log('✅ test-reply-guards: anti-meta + rol del inbound (recruiter/vendor/prospect) + anti-contacto-inventado OK')
