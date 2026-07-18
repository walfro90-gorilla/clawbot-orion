// Seatbelt de funciones PURAS críticas. Corre con `npm test` (node --test, sin framework).
// Atrapa la clase de regresión de la sesión 06-jul-2026: whitelist matching, persona gating,
// guard de placeholder y semver del guard de versión de extensión.
import { test } from 'node:test'
import assert from 'node:assert/strict'

// supabase.js (import transitivo de extension-dispatch) exige env no-placeholder para cargar.
process.env.SUPABASE_URL ||= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'dummy_key_for_test'

const { passesTitleFilters, meetsVersion } = await import('../lib/extension-dispatch.js')
const { campaignPersonaBlock, hasLeftoverPlaceholder, detectExitIntent, resolveProvider } = await import('../lib/ai-message.js')

test('passesTitleFilters — substring whitelist, junk, vacío, acentos, blacklist', () => {
  const wl = ['Director de Ventas', 'CEO', 'Director de Logística', 'Gerente General']
  assert.equal(passesTitleFilters('Director de Ventas en Acme', wl, []), true, 'match directo')
  assert.equal(passesTitleFilters('Procurement Specialist', wl, []), false, 'junk NO pasa')
  assert.equal(passesTitleFilters('', wl, []), true, 'headline vacío PASA (search ya filtró)')
  assert.equal(passesTitleFilters('Director de Logistica en X', wl, []), true, 'acento-insensible (í→i)')
  assert.equal(passesTitleFilters('Junior Director', ['Director'], ['junior']), false, 'blacklist tiene prioridad')
})

test('meetsVersion — semver simple + fail-closed en versión desconocida', () => {
  assert.equal(meetsVersion('0.9.15', '0.9.15'), true, 'igual pasa')
  assert.equal(meetsVersion('0.9.14', '0.9.15'), false, 'menor bloquea')
  assert.equal(meetsVersion('0.10.0', '0.9.15'), true, '10 > 9 (no string compare)')
  assert.equal(meetsVersion('1.0.0', '0.9.15'), true)
  assert.equal(meetsVersion(null, '0.9.15'), false, 'null = demasiado vieja')
  assert.equal(meetsVersion('', '0.9.15'), false)
})

test('campaignPersonaBlock — dispara solo con persona/contexto + caps anti-bloat', () => {
  const full = { ai_sender_persona: 'Soy Joshua de EBOOMS', ai_company_context: 'Empresa de IA', ai_tone: 'casual' }
  const b = campaignPersonaBlock(full)
  assert.ok(b && b.includes('Joshua') && b.includes('Empresa de IA') && b.includes('TONO OBJETIVO: casual'), 'inyecta los 3')
  assert.equal(campaignPersonaBlock({ ai_tone: 'casual' }), null, 'tono SOLO no dispara (no afecta campañas ya OK)')
  assert.equal(campaignPersonaBlock({}), null, 'vacío → null')
  assert.equal(campaignPersonaBlock(null), null, 'null → null')
  const big = campaignPersonaBlock({ ai_sender_persona: 'X'.repeat(3000) })
  assert.ok(big.includes('X'.repeat(2000)) && !big.includes('X'.repeat(2001)), 'persona capada a 2000')
  // target_audience: dispara solo (fix §7.1 — antes se seleccionaba sin interpolar) y va capeado a 800
  const ta = campaignPersonaBlock({ target_audience: 'Directores de logística en MX' })
  assert.ok(ta && ta.includes('A QUIÉN LE ESCRIBES') && ta.includes('Directores de logística'), 'target_audience solo SÍ dispara')
  const bigTa = campaignPersonaBlock({ target_audience: 'Y'.repeat(1200) })
  assert.ok(bigTa.includes('Y'.repeat(800)) && !bigTa.includes('Y'.repeat(801)), 'target_audience capado a 800')
})

test('hasLeftoverPlaceholder — detecta corchetes y llaves sin resolver', () => {
  assert.equal(hasLeftoverPlaceholder('hola [Nombre], un gusto'), true)
  assert.equal(hasLeftoverPlaceholder('hola {empresa}'), true)
  assert.equal(hasLeftoverPlaceholder('hola Juan, un gusto conectar'), false)
})

// Sensor de salida: la parte OFFLINE (el guard que decide si se llama al LLM).
// Invariante: un inbound vacío/nulo NUNCA puede matar un lead — y no debe gastar un call.
// La calidad del clasificador es LLM y se mide aparte: `node scripts/test-exit-sensor.mjs`.
test('detectExitIntent — inbound vacío corta antes del LLM y no dispara exit', async () => {
  for (const empty of ['', '   ', null, undefined]) {
    const r = await detectExitIntent(empty, 'nuestro último mensaje')
    assert.deepEqual(r, { exit: false, reason: 'empty_inbound' }, `vacío (${JSON.stringify(empty)}) → sin exit`)
  }
})

// Registro de proveedores LLM (fallback sin Gemini): resolveProvider mapea nombre→config.
// La llamada real necesita API key (no testeable en local); esto fija el ruteo de la cadena.
test('resolveProvider — proveedores OpenAI-compat + desconocidos', () => {
  const g = resolveProvider('groq')
  assert.ok(g && g.baseUrl.includes('groq.com') && g.keyEnv === 'GROQ_API_KEY' && g.model, 'groq resuelve')
  const c = resolveProvider('cerebras')
  assert.ok(c && c.baseUrl.includes('cerebras.ai') && c.keyEnv === 'CEREBRAS_API_KEY', 'cerebras resuelve (fallback sin Gemini)')
  assert.equal(resolveProvider('GROQ'), g, 'case-insensitive')
  assert.equal(resolveProvider('  groq '), g, 'trim')
  assert.equal(resolveProvider('gemini'), null, 'gemini NO es OpenAI-compat (caso especial en callProviderRaw)')
  assert.equal(resolveProvider('desconocido'), null, 'desconocido → null')
  assert.equal(resolveProvider(null), null, 'null → null (no lanza)')
})
