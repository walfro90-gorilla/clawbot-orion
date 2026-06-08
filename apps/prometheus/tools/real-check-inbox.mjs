#!/usr/bin/env node
// real-check-inbox.mjs — dispatch REAL check_inbox (production, no stress flag).
// Validates inbox parser fix v0.7.18: threadId/profileUrl null rate.

import { supabase } from '../lib/supabase.js'
import { dispatchCommand } from '../lib/extension-dispatch.js'

const argv = process.argv.slice(2)
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`)
  if (i === -1) return d
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const label = flag('account', 'Wal')
const { data: account } = await supabase
  .from('linkedin_accounts')
  .select('id, label, ext_version, extension_paused')
  .eq('label', label)
  .maybeSingle()
if (!account) { console.error(`Account ${label} no encontrada`); process.exit(1) }
if (account.extension_paused) { console.error(`Account ${label} PAUSED`); process.exit(1) }
console.log(`Account: ${account.label} (${account.id.slice(0,8)}) ext=${account.ext_version}`)

const payload = {
  limit: parseInt(flag('limit', '30'), 10),
  deepScrape: flag('deep', 'false') === 'true',
  captureThreads: true,
  maxCaptures: parseInt(flag('captures', '15'), 10),
  // NO is_stress_test → real prod
}
console.log('Dispatching REAL check_inbox…')
const cmdId = await dispatchCommand(account.id, 'check_inbox', payload, { expiresInMinutes: 5 })
console.log(`cmd: ${cmdId}`)
process.exit(0)
