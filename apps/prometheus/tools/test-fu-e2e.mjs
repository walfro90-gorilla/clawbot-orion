// E2E test del motor de FU dinámico (v0.8).
//
// Ejercita la función REAL `tryFollowupsForCampaign()` en DRY_RUN (cero mutación
// de comandos, cero envíos) contra una campaña de prueba AISLADA (is_active=false
// → el scheduler vivo nunca la toca). Prueba: carga de pasos, FU1, avance a FU2,
// respeto del delay, secuencia agotada (frozen) y RESUME al agregar un paso nuevo.
//
// Uso:  cd apps/prometheus && node tools/test-fu-e2e.mjs
//
// Seguro de correr en prod: campaña inactiva + lead ficticio + DRY_RUN + teardown.

process.env.DRY_RUN = 'true'
process.env.SCHED_NO_AUTORUN = 'true'

const { tryFollowupsForCampaign, loadFollowupSteps } = await import('../scheduler-extension.js')
const { supabase } = await import('../lib/supabase.js')

const ACCOUNT_ID = '85b0f757-9d1a-4d66-8b1e-ac57e4e729b3' // Wal (solo lectura)
const TAG = 'E2E-FU-TEST'
const hoursAgo = h => new Date(Date.now() - h * 3600_000).toISOString()

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name} ${detail}`)
  cond ? pass++ : fail++
}

// Limpia restos de corridas previas
async function purgeByTag() {
  const { data: old } = await supabase.from('campaigns').select('id').eq('name', TAG)
  for (const c of old ?? []) {
    await supabase.from('leads').delete().eq('campaign_id', c.id)
    await supabase.from('campaign_followups').delete().eq('campaign_id', c.id)
    await supabase.from('campaigns').delete().eq('id', c.id)
  }
}

let camp, lead, account
try {
  console.log('▶ Setup: campaña de prueba aislada (is_active=false) + lead ficticio')
  await purgeByTag()

  const { data: c, error: cErr } = await supabase.from('campaigns').insert({
    name: TAG, linkedin_account_id: ACCOUNT_ID, is_active: false,
    gemini_system_prompt: '', follow_up_paused: false,
  }).select('*').single()
  if (cErr) throw new Error('crear campaña: ' + cErr.message)
  camp = c

  // 5 pasos: FU1 delay 0h, FU2-5 delay 1h (template-only, sin Gemini → determinista)
  const steps5 = [1, 2, 3, 4, 5].map(s => ({
    campaign_id: camp.id, step: s, message: `Test FU${s} para {nombre}`,
    delay_value: s === 1 ? 0 : 1, delay_unit: 'hours', jitter_hours: 0, enabled: true,
  }))
  const { error: sErr } = await supabase.from('campaign_followups').insert(steps5)
  if (sErr) throw new Error('insertar pasos: ' + sErr.message)

  const { data: a } = await supabase.from('linkedin_accounts').select('*').eq('id', ACCOUNT_ID).single()
  account = a

  const { data: l, error: lErr } = await supabase.from('leads').insert({
    campaign_id: camp.id, full_name: 'E2E Test Persona', status: 'connected', followup_step: 0,
    linkedin_url: 'https://www.linkedin.com/in/e2e-fu-test-persona/',
    connected_at: hoursAgo(100), profile_data: { headline: 'QA', currentCompany: 'TestCo' },
  }).select('*').single()
  if (lErr) throw new Error('crear lead: ' + lErr.message)
  lead = l

  const reloadCampaign = async () => (await supabase.from('campaigns').select('*').eq('id', camp.id).single()).data
  const setLead = patch => supabase.from('leads').update(patch).eq('id', lead.id)
  const run = async () => {
    const res = await tryFollowupsForCampaign(await reloadCampaign(), account)
    console.log(`      → ${JSON.stringify(res)}`)
    return res
  }

  console.log('\n▶ Test 0: loadFollowupSteps lee la secuencia de campaign_followups')
  const loaded = await loadFollowupSteps(camp.id)
  check('carga 5 pasos ordenados 1..5', loaded.length === 5 && loaded[0].step === 1 && loaded[4].step === 5,
    `(n=${loaded.length})`)

  console.log('\n▶ Test 1: lead connected (followup_step=0) → dispara FU1')
  let r = await run()
  check('DRY_RUN dispatch step 1', r.dryRun === true && r.step === 1, `(step=${r.step})`)

  console.log('\n▶ Test 2: followup_step=1 con delay cumplido (100h) → avanza a FU2')
  await setLead({ status: 'follow_up_sent', followup_step: 1, last_followup_at: hoursAgo(100), connected_at: hoursAgo(120) })
  r = await run()
  check('DRY_RUN dispatch step 2', r.dryRun === true && r.step === 2, `(step=${r.step})`)

  console.log('\n▶ Test 3: followup_step=1 con last_followup_at reciente (6min) → NO dispara (respeta delay)')
  await setLead({ followup_step: 1, last_followup_at: hoursAgo(0.1) })
  r = await run()
  check('no dispara por delay no cumplido', !r.dispatched && !r.dryRun, `(reason=${r.reason})`)

  console.log('\n▶ Test 4: followup_step=5 con solo 5 pasos → secuencia agotada (frozen)')
  await setLead({ followup_step: 5, last_followup_at: hoursAgo(100) })
  r = await run()
  check('frozen: no_followups_due', !r.dispatched && r.reason === 'no_followups_due', `(reason=${r.reason})`)

  console.log('\n▶ Test 5: agregar FU6 → el lead agotado RESUME y dispara FU6')
  await supabase.from('campaign_followups').insert({
    campaign_id: camp.id, step: 6, message: 'Test FU6 para {nombre}',
    delay_value: 1, delay_unit: 'hours', jitter_hours: 0, enabled: true,
  })
  r = await run()
  check('RESUME: DRY_RUN dispatch step 6', r.dryRun === true && r.step === 6, `(step=${r.step})`)

} catch (e) {
  console.error('💥 Error en el test:', e.message)
  fail++
} finally {
  console.log('\n▶ Teardown')
  await purgeByTag()
  console.log(`\n━━━ RESULTADO: ${pass} pass · ${fail} fail ━━━`)
  process.exit(fail === 0 ? 0 : 1)
}
