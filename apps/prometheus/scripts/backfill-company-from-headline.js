#!/usr/bin/env node
/**
 * Backfill de `profile_data.currentCompany` extrayendo la empresa del headline vía LLM.
 * Reusa el MISMO wrapper (extractCompaniesFromHeadlines) y la MISMA centinela '' que el pass del
 * scheduler (tryEnrichCompanies) → idempotente y sin pisarse con él. Puro DB + LLM (sin Playwright).
 *
 * Uso:
 *   node scripts/backfill-company-from-headline.js --dry-run   # imprime headline → empresa, NO escribe (QA del gate)
 *   node scripts/backfill-company-from-headline.js             # escribe currentCompany (nombre real | '' centinela)
 *
 * Requiere .env con SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY (correr en prod).
 */
import 'dotenv/config'
import { supabase } from '../lib/supabase.js'
import { extractCompaniesFromHeadlines } from '../lib/ai-message.js'

const DRY = process.argv.includes('--dry-run')
const BATCH = parseInt(process.env.COMPANY_ENRICH_BATCH ?? '10')
const DRY_SAMPLE = 50   // en dry-run: cuántas muestras revisar antes de parar

async function fetchCandidates(limit) {
  const { data } = await supabase
    .from('leads')
    .select('id, profile_data')
    .filter('profile_data->>headline', 'not.is', null)       // headline presente
    .filter('profile_data->>currentCompany', 'is', null)     // '' (centinela) NO es null → excluido
    .limit(limit)
  // Defensa idéntica al pass: solo los que realmente faltan empresa
  return (data ?? []).filter(l => l.profile_data?.headline && l.profile_data?.currentCompany == null)
}

let processed = 0, withCompany = 0
console.log(`[backfill-company] modo=${DRY ? 'DRY-RUN (no escribe)' : 'APPLY'} batch=${BATCH}`)

if (DRY) {
  // Un solo fetch (hasta DRY_SAMPLE), troceado para el LLM, imprime, no escribe.
  const cands = await fetchCandidates(DRY_SAMPLE)
  console.log(`[backfill-company] DRY-RUN: ${cands.length} muestras (de un total mayor)\n`)
  for (let i = 0; i < cands.length; i += BATCH) {
    const chunk = cands.slice(i, i + BATCH)
    const out = await extractCompaniesFromHeadlines(chunk.map(l => ({ key: l.id, headline: l.profile_data.headline })))
    if (out.error) { console.error(`[backfill-company] LLM error: ${out.error}`); break }
    for (const { key, company } of out) {
      const lead = chunk.find(l => l.id === key)
      if (!lead) continue
      processed++; if (company) withCompany++
      console.log(`  ${company ? '✅ ' + company : '·  (none)'}\t←  ${String(lead.profile_data.headline).slice(0, 70)}`)
    }
  }
} else {
  // APPLY: loop hasta drenar (escribimos → los leads salen del set de candidatos).
  while (true) {
    const chunk = await fetchCandidates(BATCH)
    if (chunk.length === 0) break
    const out = await extractCompaniesFromHeadlines(chunk.map(l => ({ key: l.id, headline: l.profile_data.headline })))
    if (out.error) { console.error(`[backfill-company] LLM error: ${out.error} — parando (reintenta más tarde)`); break }
    for (const { key, company } of out) {
      const lead = chunk.find(l => l.id === key)
      if (!lead) continue
      processed++; if (company) withCompany++
      await supabase.from('leads')
        .update({ profile_data: { ...lead.profile_data, currentCompany: company ?? '' } })
        .eq('id', key)
    }
    if (processed % 50 === 0) console.log(`  … ${processed} procesados (${withCompany} con empresa)`)
  }
}

console.log(`\n[backfill-company] listo: ${processed} procesados, ${withCompany} con empresa real (${processed - withCompany} → 'tu empresa').${DRY ? ' (DRY-RUN, nada escrito)' : ''}`)
process.exit(0)
