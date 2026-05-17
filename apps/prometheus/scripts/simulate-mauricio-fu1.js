/**
 * simulate-mauricio-fu1.js — Simula EXACTAMENTE el FU1 que recibiría Mauricio
 *
 * Carga el mismo contexto que tendría el scheduler en producción:
 *   - profile_data del lead
 *   - invite enviada (si existe)
 *   - previousFollowUps (vacío, primer FU)
 *   - calUrl de la cuenta
 *   - ai_tone, ai_sender_persona, ai_company_context, ai_example_messages
 *   - templateGuide del campaign.follow_up_message
 *
 * NO envía nada. Solo muestra el mensaje final.
 */
import 'dotenv/config'
import { supabase } from '../lib/supabase.js'
import { generateFollowUpMessage } from '../ai.js'

const LEAD_ID     = '11dfe597-0e43-4872-8b3c-93b7b54f2020'
const CAMPAIGN_ID = '8eda7e17-00db-431b-b67e-7cbdcbf6fc94'
const ACCOUNT_ID  = '2ea4a7f2-eb0a-40d0-a7af-3a3066829aeb'

const { data: lead } = await supabase
  .from('leads')
  .select('full_name, profile_data, sent_at, status')
  .eq('id', LEAD_ID).single()

const { data: campaign } = await supabase
  .from('campaigns')
  .select('name, follow_up_message, ai_tone, ai_sender_persona, ai_company_context, ai_example_messages')
  .eq('id', CAMPAIGN_ID).single()

const { data: account } = await supabase
  .from('linkedin_accounts')
  .select('label, cal_com_url')
  .eq('id', ACCOUNT_ID).single()

// El mensaje del invite (si ya se hubiera enviado). En este caso aún no se ha
// enviado, así que pasamos el mensaje que Gemini generaría en el DRY_RUN.
const inviteMessage = 'Mauricio, vi tu perfil como Digital Business Regional Director LATAM — el tipo de trayectoria que me da curiosidad conocer.'

console.log('═'.repeat(72))
console.log('  SIMULACIÓN — FU1 que recibirá Mauricio al aceptar la conexión')
console.log('═'.repeat(72))

console.log('\n📋 CONTEXTO DEL FLUJO:')
console.log(`  Lead:     ${lead.full_name}`)
console.log(`  Cuenta:   ${account.label}`)
console.log(`  Campaña:  ${campaign.name}`)
console.log(`  Cal.com:  ${account.cal_com_url ?? '(sin configurar)'}`)
console.log(`  Tono IA:  ${campaign.ai_tone}`)

console.log('\n📋 PERFIL DEL LEAD (lo que Gemini tiene como input):')
console.log(JSON.stringify(lead.profile_data, null, 2))

console.log('\n📋 INVITE PREVIO (registrado en el hilo):')
console.log(`  "${inviteMessage}"`)

console.log('\n📋 TEMPLATE BASE (campaign.follow_up_message):')
console.log('─'.repeat(72))
console.log(campaign.follow_up_message)
console.log('─'.repeat(72))
console.log(`(${campaign.follow_up_message.length} chars)`)

console.log('\n⏳ Generando FU1 con Gemini...\n')

const finalMsg = await generateFollowUpMessage({
  leadName:        lead.full_name,
  leadProfileData: lead.profile_data ?? {},
  inviteMessage,
  previousFollowUps: [],            // primer FU, no hay previos
  followUpStep:    1,
  calUrl:          account?.cal_com_url,
  aiTone:          campaign.ai_tone ?? 'casual',
  senderPersona:   campaign.ai_sender_persona,
  companyContext:  campaign.ai_company_context,
  exampleMessages: campaign.ai_example_messages,
  templateGuide:   campaign.follow_up_message,
})

console.log('═'.repeat(72))
console.log('  📨 ESTE ES EL MENSAJE QUE MAURICIO RECIBIRÍA:')
console.log('═'.repeat(72))
console.log(finalMsg)
console.log('═'.repeat(72))
console.log(`(${finalMsg.length} chars vs template ${campaign.follow_up_message.length} chars — ${((finalMsg.length / campaign.follow_up_message.length - 1) * 100).toFixed(0)}% diff)`)

// Checklist anti-bot
console.log('\n🔍 VERIFICACIÓN ANTI-BOT (¿conserva propuesta del template?):')
const checks = [
  ['Menciona "decisores" o números (15/600)',     /15|600|decisor/i],
  ['Menciona "20 min"',                           /20 min|20.minutos/i],
  ['Menciona "B2B" o "empresas"',                 /B2B|empresas/i],
  ['Tu equipo solo cierra (o equivalente)',       /cierr|cerrar|equipo/i],
  ['Pregunta abierta al final (?)',               /\?\s*$/],
  ['Sin firma/despedida',                          /^(?!.*(saludos|atentamente|abrazo))/i],
]
for (const [name, re] of checks) {
  console.log(`  ${re.test(finalMsg) ? '✅' : '❌'} ${name}`)
}
