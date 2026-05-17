// Smoke test del FU1 híbrido — genera un mensaje real sin enviarlo.
import 'dotenv/config'
import { supabase } from '../lib/supabase.js'
import { generateFollowUpMessage } from '../ai.js'

const LEAD_ID  = '11dfe597-0e43-4872-8b3c-93b7b54f2020'   // Mauricio Perez Prieto
const CAMPAIGN_ID = '8eda7e17-00db-431b-b67e-7cbdcbf6fc94' // Directores Generales/CEO

const { data: lead } = await supabase
  .from('leads')
  .select('full_name, profile_data')
  .eq('id', LEAD_ID).single()

const { data: campaign } = await supabase
  .from('campaigns')
  .select('follow_up_message, ai_tone, ai_sender_persona, ai_company_context, ai_example_messages')
  .eq('id', CAMPAIGN_ID).single()

const { data: account } = await supabase
  .from('linkedin_accounts')
  .select('cal_com_url')
  .eq('id', '2ea4a7f2-eb0a-40d0-a7af-3a3066829aeb').single()

console.log('═'.repeat(70))
console.log('PRUEBA: FU1 HÍBRIDO (Gemini usa template como guía)')
console.log('═'.repeat(70))
console.log('\nLEAD:', lead.full_name)
console.log('PROFILE_DATA:', JSON.stringify(lead.profile_data, null, 2))
console.log('\nTEMPLATE BASE configurado en /campaigns/edit:')
console.log('─'.repeat(70))
console.log(campaign.follow_up_message)
console.log('─'.repeat(70))

// Generar 3 veces para ver variación (anti-uniformidad)
for (let i = 1; i <= 3; i++) {
  console.log(`\n🤖 GEMINI INTENTO ${i}/3:`)
  console.log('─'.repeat(70))
  const msg = await generateFollowUpMessage({
    leadName:        lead.full_name,
    leadProfileData: lead.profile_data ?? {},
    inviteMessage:   null,
    previousFollowUps: [],
    followUpStep:    1,
    calUrl:          account?.cal_com_url,
    aiTone:          campaign.ai_tone ?? 'casual',
    senderPersona:   campaign.ai_sender_persona,
    companyContext:  campaign.ai_company_context,
    exampleMessages: campaign.ai_example_messages,
    templateGuide:   campaign.follow_up_message,  // ← clave: template como guía
  })
  console.log(msg)
  console.log(`(${msg.length} chars)`)
}

console.log('\n' + '═'.repeat(70))
console.log('Comparación:')
console.log('- Template literal sería ÚNICO mensaje, idéntico para todos los leads')
console.log('- Híbrido: cada lead recibe variación distinta basada en su perfil')
console.log('═'.repeat(70))
