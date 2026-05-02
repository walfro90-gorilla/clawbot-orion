/**
 * test-fu-stress.mjs — Stress test de generateFollowUpMessage()
 *
 * Corre Gemini con los datos REALES de 3 leads conectados.
 * NO abre LinkedIn, NO envía nada.
 *
 * Usage: node test-fu-stress.mjs
 */

import dotenv from 'dotenv'
dotenv.config()

import { generateFollowUpMessage } from './ai.js'

// ── Leads reales (datos del DB) ───────────────────────────────────────────────
const LEADS = [
  {
    full_name:    'Julio Orizaba',
    profile_data: { headline: 'Director Finanzas CBG México', location: 'Área metropolitana de Ciudad de México' },
    invite_msg:   null,
    prev_fu:      [],
  },
  {
    full_name:    'Juan José González Heredia',
    profile_data: { headline: 'Director de administración y finanzas en Happyland México', location: 'Zapopan, Jalisco, México' },
    invite_msg:   null,
    prev_fu:      [],
  },
  {
    full_name:    'Carlos Castañeda',
    profile_data: { headline: 'Director de Finanzas y Operaciones (CFO/COO) México & Colombia.', location: 'Ciudad de México, México' },
    invite_msg:   null,
    prev_fu:      [],
  },
]

// ── Flags de calidad ──────────────────────────────────────────────────────────
const FORBIDDEN = [
  'linkedin', 'notificaci', 'mensaje anterior', 'automatiz', 'sistema',
  'cal.com', 'orion', 'agenda una', 'agendar una', 'sesión de 20',
  'estimado', 'espero que', 'este mensaje te encuentre',
]

function analyzeMessage(name, profileData, msg) {
  const lower = msg.toLowerCase()
  const wordCount = msg.split(/\s+/).length
  const flags = []

  // 1. Forbidden words
  for (const f of FORBIDDEN) {
    if (lower.includes(f)) flags.push(`🚨 PROHIBIDO: contiene "${f}"`)
  }

  // 2. Length check (FU1 = Turno 0 = máx ~80 palabras)
  if (wordCount > 100) flags.push(`⚠️  LARGO: ${wordCount} palabras (máx recomendado ~80)`)
  if (wordCount < 10)  flags.push(`⚠️  MUY CORTO: ${wordCount} palabras`)

  // 3. Name check — should contain the lead's first name
  const firstName = name.split(' ')[0].toLowerCase()
  if (!lower.includes(firstName)) flags.push(`⚠️  NO USA EL NOMBRE del lead (esperado: "${name.split(' ')[0]}")`)

  // 4. Anti-hallucination: inventó datos que no están en el perfil?
  const inventionNumbers = [
    /\d+\s*%/g,
    /\d+\s*(clientes|empresas|proyectos|empleados|millones)/g,
  ]
  for (const re of inventionNumbers) {
    const m = msg.match(re)
    if (m) flags.push(`🤔 POSIBLE ALUCINACIÓN: inventó número/estadística: "${m[0]}" (verificar)`)
  }

  // 5. Invented corporate events (hallucination patterns)
  const inventionPatterns = [
    { re: /\bexpansión\b/i,           label: 'expansión' },
    { re: /\blanzamiento\b/i,         label: 'lanzamiento' },
    { re: /\blanzaron\b/i,            label: 'lanzaron' },
    { re: /\badquisici/i,             label: 'adquisición' },
    { re: /\bfusión\b/i,              label: 'fusión' },
    { re: /\bcrecimiento reciente\b/i,label: 'crecimiento reciente' },
    { re: /felicidades por/i,         label: 'felicidades por [evento]' },
    // Only flag if "Vi que [company/ellos] está/están creciendo" — not generic questions
    { re: /vi que\s+(?:la empresa|tu empresa|están|están)\s+(?:creciendo|expandiéndose)/i, label: 'crecimiento inventado' },
    { re: /muy activos con/i,         label: 'actividad no confirmada' },
  ]
  const hasAbout = (profileData.about?.length ?? 0) > 0
  if (!hasAbout) {
    for (const { re, label } of inventionPatterns) {
      if (re.test(msg)) flags.push(`🚨 ALUCINACIÓN: inventó "${label}" — no está en el perfil`)
    }
  }

  // 6. Firma / despedida formal
  const firmaPatterns = [/[¡!]?saludos[!¡]?\s*$/i, /atentamente,?\s*$/i, /\[tu nombre\]/i, /cordialmente/i, /un abrazo\s*$/i, /hasta pronto\s*$/i]
  for (const p of firmaPatterns) {
    if (p.test(msg.trim())) flags.push(`⚠️  FIRMA al final del mensaje — eliminar`)
  }

  // 7. Question check — should contain a question
  if (!msg.includes('?')) flags.push(`⚠️  SIN PREGUNTA — FU1 debe terminar con pregunta abierta`)

  return { wordCount, flags }
}

// ── Test runner ───────────────────────────────────────────────────────────────
async function runTest(lead, runIndex) {
  const t0 = Date.now()
  let msg
  try {
    msg = await generateFollowUpMessage({
      leadName:        lead.full_name,
      leadProfileData: lead.profile_data,
      inviteMessage:   lead.invite_msg,
      previousFollowUps: lead.prev_fu,
      followUpStep:    1,
      calUrl:          'https://cal.com/jorge-joshua-sanchez-dominguez-8mtqse/30min',
      aiTone:          'casual',
      senderPersona:   null,
      companyContext:  null,
      exampleMessages: null,
      playbookExamples: '',
    })
  } catch (err) {
    return { error: err.message }
  }
  const ms = Date.now() - t0
  const { wordCount, flags } = analyzeMessage(lead.full_name, lead.profile_data, msg)
  return { msg, ms, wordCount, flags }
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log('═'.repeat(70))
console.log('🧪  STRESS TEST — generateFollowUpMessage() FU Step 1')
console.log('   Datos REALES de leads. Sin LinkedIn. Sin envíos.')
console.log('═'.repeat(70))
console.log()

let totalFlags = 0
let totalPassed = 0

for (const lead of LEADS) {
  console.log(`\n${'─'.repeat(70)}`)
  console.log(`👤  ${lead.full_name}`)
  console.log(`    Headline: ${lead.profile_data.headline ?? 'N/A'}`)
  console.log(`    Location: ${lead.profile_data.location ?? 'N/A'}`)
  console.log(`    Invite msg: ${lead.invite_msg ? `"${lead.invite_msg.slice(0, 60)}..."` : '(ninguno — perfil solo)'}`)
  console.log()

  // Run 2x para verificar varianza
  for (let i = 1; i <= 2; i++) {
    process.stdout.write(`  [Run ${i}/2] Generando...`)
    const result = await runTest(lead, i)

    if (result.error) {
      console.log(` ❌ ERROR: ${result.error}`)
      totalFlags++
      continue
    }

    console.log(` ✓ (${result.ms}ms, ${result.wordCount} palabras)`)
    console.log()
    console.log(`  ┌─ MENSAJE ${'─'.repeat(54)}`)
    const wrapped = result.msg.replace(/(.{65})/g, '$1\n  │ ').trimEnd()
    console.log(`  │ ${wrapped}`)
    console.log(`  └${'─'.repeat(61)}`)
    console.log()

    if (result.flags.length === 0) {
      console.log(`  ✅ Sin flags de calidad`)
      totalPassed++
    } else {
      for (const f of result.flags) {
        console.log(`  ${f}`)
        totalFlags++
      }
    }

    if (i < 2) {
      console.log()
      // Small delay between calls to avoid rate limiting
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

// ── Resumen ───────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(70)}`)
console.log(`📊  RESUMEN`)
console.log(`    Runs exitosos sin flags: ${totalPassed}/6`)
console.log(`    Total flags detectados:  ${totalFlags}`)
console.log()
if (totalFlags === 0) {
  console.log('  🟢 PASS — Gemini no alucinó, mensajes limpios y seguros.')
} else if (totalFlags <= 3) {
  console.log('  🟡 WARN — Algunos flags menores. Revisar antes de producción.')
} else {
  console.log('  🔴 FAIL — Revisar prompt antes de correr en producción.')
}
console.log('═'.repeat(70))
