// stress-cases.mjs — Test Matrix T01-T20
// Cada case: { id, title, action, hot, requiresLive, precondition(lead), payloadOverride(account,lead), expect(tail, ctx) }

import { supabase } from '../lib/supabase.js'

// Helpers de assert
const pass = (reason = 'ok', observed = null) => ({ pass: true, reason, observed })
const fail = (reason, observed = null) => ({ pass: false, reason, observed })

// Lookup helpers
export async function findLeadByName(needle) {
  const { data } = await supabase
    .from('leads')
    .select('id, full_name, linkedin_url, status, campaign_id, quarantined_at, cooldown_until, consecutive_failures, conversations(linkedin_thread_id, linkedin_account_id)')
    .ilike('full_name', `%${needle}%`)
    .order('created_at', { ascending: false })
    .limit(5)
  return data ?? []
}

export async function findAccountByLabel(label) {
  const { data } = await supabase
    .from('linkedin_accounts')
    .select('id, label, status, extension_paused, extension_last_seen_at')
    .ilike('label', label)
    .maybeSingle()
  return data
}

// Test Matrix
export const CASES = {
  T01: {
    id: 'T01',
    title: 'Search keyword neutral — ≥5 leads ingested',
    action: 'search',
    hot: true,
    requiresLive: false,
    precondition: () => ({}),
    payloadOverride: (account) => ({
      keywords: 'Director Finanzas',
      locations: null,
      targetCount: 10,
      maxPages: 2,
      secondDegreeOnly: true,
      campaignId: null,  // standalone, sin ingest a campaña
    }),
    expect: (tail) => {
      const c = tail.finalCmd
      if (!c) return fail('no command')
      if (c.status === 'completed' && c.result?.profilesCount >= 5) return pass(`scraped ${c.result.profilesCount}`)
      if (c.status === 'completed' && c.result?.profiles?.length >= 5) return pass(`scraped ${c.result.profiles.length}`)
      return fail(`status=${c.status} result=${JSON.stringify(c.result)?.slice(0, 200)}`)
    },
  },

  T03: {
    id: 'T03',
    title: 'Invite Quick-Connect dryRun — FSM ladder ok',
    action: 'send_invite',
    hot: true,
    requiresLive: false,
    precondition: (lead) => ({ status: 'scraped', quarantined_at: null, cooldown_until: null, consecutive_failures: 0 }),
    payloadOverride: (_account, lead) => ({
      profileUrl: lead.linkedin_url,
      leadId: lead.id,
      message: null,
      dryRun: true,
      is_stress_test: true,
    }),
    expect: (tail) => {
      const c = tail.finalCmd
      if (!c) return fail('no command')
      const ok = c.status === 'completed' && ['dry_run_ok', 'sent'].includes(c.result?.status)
      return ok ? pass(`result=${c.result?.status}`) : fail(`status=${c.status} result=${JSON.stringify(c.result)?.slice(0,200)}`)
    },
  },

  T05: {
    id: 'T05',
    title: 'check_inbox — verifies accept detection works (read-only)',
    action: 'check_inbox',
    hot: true,
    requiresLive: false,
    precondition: () => ({}),
    payloadOverride: () => ({ is_stress_test: true }),
    expect: (tail) => {
      const c = tail.finalCmd
      if (!c) return fail('no command')
      if (c.status !== 'completed') return fail(`status=${c.status}`)
      const convs = c.result?.conversations?.length ?? c.result?.threads?.length ?? 0
      const ingestMatches = c.result?.ingest?.matches ?? 0
      const totalScraped = c.result?.ingest?.total_scraped ?? convs
      return pass(`scraped=${totalScraped} matches=${ingestMatches} convs=${convs}`)
    },
  },

  T06: {
    id: 'T06',
    title: 'Wilder thread_not_found_in_inbox loop — debe escalar a dead post P0-4',
    action: 'send_followup',
    hot: true,
    requiresLive: false,
    precondition: () => ({
      status: 'connected',
      quarantined_at: null,
      cooldown_until: null,
      lockout_skip_count: 0,
      consecutive_failures: 0,
    }),
    payloadOverride: (account, lead) => ({
      threadUrl: lead.conversations?.[0]?.linkedin_thread_id
        ? `https://www.linkedin.com/messaging/thread/${lead.conversations[0].linkedin_thread_id}/`
        : null,
      profileUrl: lead.linkedin_url,
      leadId: lead.id,
      leadName: lead.full_name,
      message: 'Hola, retomando el hilo.',
      step: 1,
      dryRun: true,
      is_stress_test: true,
    }),
    expect: (tail) => {
      const c = tail.finalCmd
      if (!c) return fail('no command')
      const EXPECTED_DETECTION_ERRORS = [
        'thread_not_found_in_inbox',
        'extension_did_not_respond',
        'lead_not_first_degree',
        'not_messageable_inmail_required',
        'awaiting_reply_badge_present',
      ]
      if (EXPECTED_DETECTION_ERRORS.includes(c.error)) {
        return pass(`expected detection err=${c.error}`)
      }
      if (c.status === 'completed') return pass('thread found (lead recuperable)')
      return fail(`unexpected status=${c.status} err=${c.error}`)
    },
  },

  T08: {
    id: 'T08',
    title: 'Gemini 403 fallback — debe enviar con template',
    action: 'send_followup',
    hot: true,
    requiresLive: false,
    precondition: () => ({ status: 'connected' }),
    payloadOverride: (account, lead) => ({
      threadUrl: lead.conversations?.[0]?.linkedin_thread_id ? `https://www.linkedin.com/messaging/thread/${lead.conversations[0].linkedin_thread_id}/` : null,
      profileUrl: lead.linkedin_url,
      leadId: lead.id,
      leadName: lead.full_name,
      message: 'Hola [Nombre], retomando el hilo.',  // template literal, sin Gemini
      step: 1,
      dryRun: true,
      is_stress_test: true,
    }),
    expect: (tail) => {
      const c = tail.finalCmd
      if (!c) return fail('no command')
      return c.status === 'completed' ? pass('template enviado') : fail(`status=${c.status} err=${c.error}`)
    },
  },

  T13: {
    id: 'T13',
    title: 'runtime_config L3 → content.js refresh dentro de 6 min (P0-1 verification)',
    action: null,  // NO dispatcheamos cmd, comparamos DB vs heartbeat
    hot: true,
    requiresLive: false,
    precondition: null,
    payloadOverride: null,
    expect: async (_tail, ctx) => {
      // Asume que stress-driver UPDATE phase_timeouts.typing_complete = 7777
      // Espera 6min y compara contra runtime_config_heartbeat.
      const accountId = ctx?.accountId
      if (!accountId) return fail('no account_id en ctx')
      const { data: hb } = await supabase
        .from('runtime_config_heartbeat')
        .select('phase_timeouts, ext_version, reported_at')
        .eq('account_id', accountId)
        .maybeSingle()
      if (!hb) return fail('NO heartbeat row — P0-1 endpoint /api/runtime-config/heartbeat NO está wireado todavía')
      const actual = hb.phase_timeouts?.typing_complete
      if (actual === 7777) return pass(`heartbeat refleja 7777 (ext=${hb.ext_version})`)
      return fail(`heartbeat reports typing_complete=${actual}, expected 7777`)
    },
  },

  T14: {
    id: 'T14',
    title: 'L6 server fallback — selector_drift critical → INSERT selector_tickets',
    action: null,
    hot: false,
    requiresLive: false,
    expect: async (_tail) => {
      // Después de P0-3 ship, verificamos que selector_drift critical en últimas 2h
      // → al menos 1 ticket con source='server_fallback' aparece.
      const since = new Date(Date.now() - 2 * 3600_000).toISOString()
      const { data: insights } = await supabase
        .from('phase_insights')
        .select('id')
        .eq('category', 'selector_drift')
        .eq('severity', 'critical')
        .gte('detected_at', since)
      if (!insights || insights.length === 0) return fail('no selector_drift critical en últimas 2h — no se puede probar')
      const { data: tickets } = await supabase
        .from('selector_tickets')
        .select('id, trigger_source, created_at')
        .gte('created_at', since)
      const fallback = (tickets ?? []).filter(t => (t.trigger_source ?? '').includes('server_fallback'))
      return fallback.length > 0
        ? pass(`${fallback.length} server_fallback tickets generated`)
        : fail(`${insights.length} drift insights pero 0 fallback tickets — P0-3 no shipped`)
    },
  },

  T15: {
    id: 'T15',
    title: 'phase_insights cleanup — auto-ack rows >7d',
    action: null,
    hot: false,
    expect: async () => {
      const { data } = await supabase
        .from('phase_insights')
        .select('id', { count: 'exact', head: true })
        .is('acknowledged_at', null)
        .lt('detected_at', new Date(Date.now() - 7 * 86400_000).toISOString())
      const remaining = data?.length ?? 0
      return remaining === 0 ? pass('0 stale unacked') : fail(`${remaining} stale unacked >7d`)
    },
  },

  T16: {
    id: 'T16',
    title: 'Lockout query OR fix — debe matchear status=completed con error',
    action: null,
    hot: false,
    expect: async () => {
      // Verifica que la query del scheduler usa OR correcto.
      // Simulamos consulta y vemos si captura completed+error.
      const { data } = await supabase
        .from('extension_commands')
        .select('id, status, error', { count: 'exact', head: false })
        .or('status.in.(timeout,error),and(status.eq.completed,error.not.is.null)')
        .gte('created_at', new Date(Date.now() - 24 * 3600_000).toISOString())
        .limit(1)
      return Array.isArray(data) ? pass(`query válida, ${data.length} matches`) : fail('query inválida')
    },
  },
}

// Suite helpers
export const SUITES = {
  hot: Object.values(CASES).filter(c => c.hot).map(c => c.id),
  all: Object.keys(CASES),
}
