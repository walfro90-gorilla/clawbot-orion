#!/usr/bin/env node
// stress-driver.mjs — CLI principal del stress test harness Orion v0.7.13
//
// Uso:
//   node tools/stress-driver.mjs --list
//   node tools/stress-driver.mjs T03                    # dryRun default
//   node tools/stress-driver.mjs T03 --lead Marco       # override lead
//   node tools/stress-driver.mjs T03 --account Wal      # override account
//   node tools/stress-driver.mjs T03 --no-restore
//   node tools/stress-driver.mjs T20 --live --lead Marco
//   node tools/stress-driver.mjs --suite hot
//   node tools/stress-driver.mjs T13 --teach            # aplica fix learning-side on pass

import { supabase } from '../lib/supabase.js'
import { dispatchCommand } from '../lib/extension-dispatch.js'
import { takeSnapshot, restoreSnapshot, recordOutcome, setPrecondition, leadDiff } from './stress-snapshot.mjs'
import { tailCommand, summarize } from './stress-tail.mjs'
import { CASES, SUITES, findLeadByName, findAccountByLabel } from './stress-cases.mjs'

const argv = process.argv.slice(2)

function flag(name, def = null) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return def
  const val = argv[i + 1]
  return val && !val.startsWith('--') ? val : true
}

function hasFlag(name) { return argv.includes(`--${name}`) }

const LOCK_TTL_MS = 5 * 60 * 1000
const HOLD_LOCK_TTL_MS = 30 * 60 * 1000  // hold-lock dura 30min

async function setStressLock(accountId, caseId, ttlMs = LOCK_TTL_MS) {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString()
  const value = { active: true, account_id: accountId, case_id: caseId, expires_at: expiresAt, taken_at: new Date().toISOString() }
  const { error } = await supabase
    .from('runtime_config')
    .upsert({ key: 'stress_test_lock', value, updated_by: `stress:${caseId}`, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  if (error) throw new Error(`setStressLock: ${error.message}`)
  return expiresAt
}

async function clearStressLock() {
  const { error } = await supabase
    .from('runtime_config')
    .upsert({ key: 'stress_test_lock', value: { active: false }, updated_by: 'stress:cleared', updated_at: new Date().toISOString() }, { onConflict: 'key' })
  if (error) console.warn(`clearStressLock: ${error.message}`)
}

// v0.7.17 P0 lock-leak fix: --hold-lock keeps lock active across cmds.
// Set once at start of session with --hold, refreshed by each runCase, cleared only with --clear-lock.
async function holdStressLock(accountId, caseId = 'hold-session') {
  return setStressLock(accountId, caseId, HOLD_LOCK_TTL_MS)
}

async function isLockHeld() {
  const { data } = await supabase.from('runtime_config').select('value').eq('key', 'stress_test_lock').maybeSingle()
  const v = data?.value
  if (!v?.active) return false
  if (v.expires_at && new Date(v.expires_at).getTime() < Date.now()) return false
  return v
}

function logHeader(line) {
  console.log(`\n${'═'.repeat(80)}\n  ${line}\n${'═'.repeat(80)}`)
}

async function runCase(caseId, opts) {
  const c = CASES[caseId]
  if (!c) throw new Error(`Case ${caseId} no existe. --list para ver disponibles.`)

  logHeader(`${caseId} — ${c.title}${opts.live ? ' [LIVE]' : ' [dry]'}`)

  // 1. Resolver account + lead
  const accountLabel = opts.account ?? 'Wal'
  const account = await findAccountByLabel(accountLabel)
  if (!account) throw new Error(`Account "${accountLabel}" no encontrada`)
  if (account.extension_paused) console.warn(`⚠ account ${account.label} extension_paused=true — dispatch puede esperar`)

  let lead = null
  if (c.action !== null) {
    if (opts.lead) {
      const leads = await findLeadByName(opts.lead)
      if (!leads.length) throw new Error(`Lead "${opts.lead}" no encontrado`)
      lead = leads[0]
    } else if (c.action !== 'search' && c.action !== 'check_inbox') {
      // T03/T06/T08 necesitan lead. Para search/check_inbox no.
      throw new Error(`Caso ${caseId} requiere --lead <name>`)
    }
    if (lead) console.log(`  lead: ${lead.full_name} (${lead.id}) status=${lead.status}`)
  }
  console.log(`  account: ${account.label} (${account.id})`)

  // 2. Snapshot (si hay lead)
  let snapshotId = null
  if (lead) {
    const snap = await takeSnapshot(caseId, lead.id, account.id, `automated stress run`)
    snapshotId = snap.snapshotId
    console.log(`  snapshot: #${snapshotId}`)
  }

  // 3. Pre-condición
  if (lead && c.precondition) {
    const patch = c.precondition(lead)
    if (Object.keys(patch).length > 0) {
      await setPrecondition(lead.id, patch)
      console.log(`  preconditions applied: ${JSON.stringify(patch).slice(0, 200)}`)
    }
  }

  // 4. Lock + dispatch
  let tail = { finalCmd: null, elapsedMs: 0, newInsights: [] }
  let commandId = null

  if (c.action) {
    // v0.7.17 P0 lock-leak fix: en hold mode, NO clear entre cmds (extend TTL).
    const ttl = opts.holdLock ? HOLD_LOCK_TTL_MS : LOCK_TTL_MS
    await setStressLock(account.id, caseId, ttl)
    console.log(`  stress_test_lock set (TTL ${ttl/1000}s, hold=${opts.holdLock ? 'yes' : 'no'})`)

    const reloadedLead = lead ? (await supabase.from('leads').select('*, conversations(linkedin_thread_id, linkedin_account_id)').eq('id', lead.id).maybeSingle()).data : null
    const payload = c.payloadOverride(account, reloadedLead ?? lead)
    payload.is_stress_test = true  // siempre, para evitar applyLeadAttemptOutcome
    console.log(`  dispatching ${c.action}…`)
    try {
      commandId = await dispatchCommand(account.id, c.action, payload, {
        relatedLeadId: lead?.id ?? null,
        expiresInMinutes: 5,
      })
      console.log(`  command id: ${commandId}`)

      tail = await tailCommand(commandId, { timeoutMs: 180_000, pollMs: 1000, silent: false })
      summarize(`${caseId} cmd result`, tail)
    } catch (err) {
      console.error(`  dispatch failed: ${err.message}`)
    } finally {
      // v0.7.17 P0 lock-leak fix: en hold mode NO limpiar — explicit --clear-lock requerido
      if (!opts.holdLock) await clearStressLock()
    }
  }

  // 5. Expect assertion
  const ctx = { account, lead, accountId: account.id }
  let result
  try {
    result = await c.expect(tail, ctx)
  } catch (err) {
    result = { pass: false, reason: `expect threw: ${err.message}` }
  }

  const verdict = result.pass ? '🟢 PASS' : '🔴 FAIL'
  console.log(`\n  ${verdict} — ${result.reason}`)

  // 6. Diff + restore
  if (snapshotId && lead) {
    const { data: afterLead } = await supabase
      .from('leads')
      .select('*')
      .eq('id', lead.id)
      .maybeSingle()
    const diff = leadDiff(lead, afterLead)
    if (Object.keys(diff).length) console.log(`  diff: ${JSON.stringify(diff).slice(0, 300)}`)
    await recordOutcome(snapshotId, { after: afterLead, result, pass: result.pass, notes: null })

    if (!opts.noRestore) {
      const rest = await restoreSnapshot(snapshotId)
      console.log(`  restored: ${JSON.stringify(rest)}`)
    } else {
      console.log(`  --no-restore: lead queda en post-state`)
    }
  }

  return { caseId, pass: result.pass, reason: result.reason, commandId, snapshotId }
}

async function main() {
  if (hasFlag('list')) {
    console.log('Casos disponibles:')
    for (const [id, c] of Object.entries(CASES)) {
      const tag = c.hot ? '[HOT]' : '     '
      const live = c.requiresLive ? '[LIVE]' : ''
      console.log(`  ${id} ${tag} ${live} — ${c.title}`)
    }
    console.log('\nSuites: hot, all')
    console.log('\nLock control (v0.7.17 P0 leak fix):')
    console.log('  --hold-lock --account Josh   (hold lock activo entre cmds, TTL 30min)')
    console.log('  --clear-lock                 (release lock manualmente)')
    console.log('  --lock-status                (mostrar estado actual del lock)')
    return
  }

  // v0.7.17 P0 lock-leak utilities
  if (hasFlag('clear-lock')) {
    await clearStressLock()
    console.log('🔓 stress_test_lock cleared')
    return
  }
  if (hasFlag('lock-status')) {
    const held = await isLockHeld()
    if (!held) {
      console.log('🔓 stress_test_lock: free')
    } else {
      const remaining = Math.round((new Date(held.expires_at).getTime() - Date.now()) / 1000)
      console.log(`🔒 stress_test_lock: held by ${held.case_id} for account ${held.account_id?.slice(0,8)}, expires in ${remaining}s`)
    }
    return
  }
  if (hasFlag('hold-lock') && !argv.some(a => /^T\d+$/i.test(a)) && !flag('suite')) {
    const acctLabel = flag('account', 'Josh')
    const acct = await findAccountByLabel(acctLabel)
    if (!acct) { console.error(`Account ${acctLabel} no encontrada`); process.exit(1) }
    await holdStressLock(acct.id)
    console.log(`🔒 stress_test_lock HELD for ${acct.label} (${acct.id.slice(0,8)}) — TTL 30min. Release con --clear-lock`)
    return
  }

  const opts = {
    lead: flag('lead'),
    account: flag('account', 'Wal'),
    live: hasFlag('live'),
    noRestore: hasFlag('no-restore'),
    teach: hasFlag('teach'),
    holdLock: hasFlag('hold-lock'),
  }

  const suiteName = flag('suite')
  const ids = suiteName ? SUITES[suiteName] : argv.filter(a => /^T\d+$/i.test(a))
  if (!ids?.length) {
    console.error('No case especificado. Uso: node tools/stress-driver.mjs <T01|T03|...> | --suite hot | --list')
    process.exit(1)
  }

  const results = []
  for (const id of ids) {
    try {
      const r = await runCase(id.toUpperCase(), opts)
      results.push(r)
    } catch (err) {
      console.error(`\n🔴 ${id} CRASHED: ${err.message}\n${err.stack}`)
      results.push({ caseId: id, pass: false, reason: `crashed: ${err.message}` })
    }
  }

  logHeader('SUMMARY')
  const pass = results.filter(r => r.pass).length
  const fail = results.length - pass
  for (const r of results) {
    console.log(`  ${r.pass ? '🟢' : '🔴'} ${r.caseId} — ${r.reason}`)
  }
  console.log(`\n  ${pass}/${results.length} pass, ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}\n${err.stack}`)
  process.exit(2)
})
