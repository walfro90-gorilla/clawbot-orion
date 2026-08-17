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

const { isMetaOutput, inboundRoleBlock, buildSystemPrompt, resolveProvider } = await import('../lib/ai-message.js')

// ── 0. Rarezas por proveedor que NO se pueden "limpiar" sin romper el envío ─────
// Kimi devuelve 400 con cualquier temperature != 1, y sus tokens de razonamiento se
// comen el cap de max_tokens (JSON truncado → vacío). Ambos campos son obligatorios.
const kimi = resolveProvider('moonshot')
assert.equal(kimi?.fixedTemperature, 1, 'kimi solo acepta temperature=1')
assert.ok((kimi?.tokenMultiplier ?? 1) > 1, 'kimi necesita presupuesto extra por el razonamiento')
assert.ok(kimi.baseUrl.includes('moonshot.ai'), 'el host .cn rechaza la key')

// ── 1. Anti-meta: lo que NO es un mensaje ──────────────────────────────────────
assert.equal(isMetaOutput('User Safety: safe.'), true, 'el caso real de prod debe bloquearse')
assert.equal(isMetaOutput('user safety: unsafe'), true)
assert.equal(isMetaOutput('Respuesta: Hola Nicolas, un gusto conectar contigo por aquí.'), true, 'prefijo meta')
assert.equal(isMetaOutput('Output: mensaje'), true)
assert.equal(isMetaOutput(''), true)
assert.equal(isMetaOutput(null), true)
assert.equal(isMetaOutput('Claro, te comparto.'), true, 'demasiado corto para ser un DM real')

// ── 2. …y lo que SÍ debe pasar (mensajes reales de prod) ───────────────────────
const REALES = [
  'Hola Nicolas, un gusto conectar. Trabajo en temas de tecnología e innovación y me gusta ir sumando a mi red a personas con trayectorias como la tuya.',
  '¡Hola Jesús! Gracias por tu respuesta. Vi que estás en el Bajío y manejas logística con RochaXLogistics. ¿Cómo están resolviendo hoy el transporte?',
  'Te entiendo, y muchas gracias. Quedamos atentos a cualquier duda. ¡Saludos!',
  'Me alegra que hayas respondido, Gerardo. ¿En qué te gustaría conversar hoy?',
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

console.log('✅ test-reply-guards: anti-meta + rol del inbound (recruiter/vendor/prospect) OK')
