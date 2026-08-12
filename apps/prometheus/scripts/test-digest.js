// Self-check del digest diario (lib/daily-digest.js).
// Correr:
//   node scripts/test-digest.js                    → asserts puros (fixtures, sin tocar DB)
//   node scripts/test-digest.js --dry-run          → query real + HTML a stdout (no envía, no toca estado)
//   node scripts/test-digest.js --send-to=a@b.com  → envía el HTML real SOLO a ese email (no avanza estado)
// Los asserts puros NO requieren .env (importan digest-format.js); los modos
// --dry-run/--send-to sí (importan daily-digest.js dinámicamente → supabase).
import assert from 'node:assert/strict'
import { groupRows, buildDigestHtml, startOfYesterdayIso } from '../lib/digest-format.js'

// ── Asserts puros ────────────────────────────────────────────────────────────
const mkRow = (label, camp, over = {}) => ({
  id: 'x', full_name: 'Ana Pérez', linkedin_url: 'https://linkedin.com/in/ana',
  profile_data: { headline: 'CFO en Acme', currentCompany: 'Acme' },
  contact_info: null, connected_at: '2026-08-10T15:00:00Z',
  campaigns: { name: camp, linkedin_accounts: { label } },
  ...over,
})

// Agrupación 2 cuentas × 2 campañas
const rows = [
  mkRow('Wal', 'Café'), mkRow('Wal', 'Café'), mkRow('Wal', 'Fintech'),
  mkRow('Josh', 'LATAM'),
]
const groups = groupRows(rows)
assert.equal(groups.size, 2)
assert.equal(groups.get('Wal').size, 2)
assert.equal(groups.get('Wal').get('Café').length, 2)
assert.equal(groups.get('Josh').get('LATAM').length, 1)

// Sin contact_info → email/tel en "—"; empresa cae a profile_data.currentCompany
let html = buildDigestHtml(groups, { dateLabel: 'lunes 10 de agosto', total: 4 })
assert.ok(html.includes('Acme'))
assert.ok(html.includes('CFO en Acme'))
assert.ok(html.includes('—'))
assert.ok(html.includes('href="https://linkedin.com/in/ana"'))
assert.ok(!html.includes('mailto:'))

// Con contact_info → email como mailto, phones unidos, company de contact_info gana
const rich = mkRow('Wal', 'Café', {
  contact_info: { email: 'ana@acme.com', phones: ['+52 55 1234 5678'], company: 'Acme Corp' },
})
html = buildDigestHtml(groupRows([rich]), { dateLabel: 'x', total: 1 })
assert.ok(html.includes('mailto:ana@acme.com'))
assert.ok(html.includes('+52 55 1234 5678'))
assert.ok(html.includes('Acme Corp'))

// Centinela {} (visitado, sin datos) → "—", sin crash
html = buildDigestHtml(groupRows([mkRow('Wal', 'Café', { contact_info: {} })]), { dateLabel: 'x', total: 1 })
assert.ok(!html.includes('mailto:'))

// 0 conexiones → mensaje vacío explícito
html = buildDigestHtml(new Map(), { dateLabel: 'x', total: 0 })
assert.ok(html.includes('Sin conexiones nuevas'))

// Escape de HTML en datos del perfil (headline hostil)
html = buildDigestHtml(groupRows([mkRow('Wal', 'Café', {
  full_name: 'X <script>alert(1)</script>', profile_data: { headline: 'a & b' },
})]), { dateLabel: 'x', total: 1 })
assert.ok(!html.includes('<script>'))
assert.ok(html.includes('a &amp; b'))

// Digest POR-CAMPAÑA: 1 sola campaña → un grupo, un nombre de campaña renderizado
const oneCamp = groupRows([mkRow('Wal', 'Fintech'), mkRow('Wal', 'Fintech')])
assert.equal(oneCamp.size, 1)
assert.equal(oneCamp.get('Wal').size, 1)
assert.equal(oneCamp.get('Wal').get('Fintech').length, 2)
html = buildDigestHtml(oneCamp, { dateLabel: 'x', total: 2 })
assert.ok(html.includes('Fintech'))
assert.ok(!html.includes('Sin conexiones nuevas'))

// startOfYesterdayIso: instante válido, entre 24h y 49h atrás (medianoche local de ayer)
const since = new Date(startOfYesterdayIso('America/Mexico_City')).getTime()
const ageH = (Date.now() - since) / 3_600_000
assert.ok(ageH >= 24 && ageH <= 49, `startOfYesterdayIso fuera de rango: ${ageH.toFixed(1)}h`)

console.log('✅ daily-digest OK (groupRows/buildDigestHtml/startOfYesterdayIso)')

// ── Modos con DB real ────────────────────────────────────────────────────────
const arg = process.argv.find(a => a === '--dry-run' || a.startsWith('--send-to='))
if (arg) {
  const { fetchDigestRows } = await import('../lib/daily-digest.js')
  const { sendEmail } = await import('../lib/send-email.js')
  const sinceIso = startOfYesterdayIso()
  const real = await fetchDigestRows(sinceIso)
  const realHtml = buildDigestHtml(groupRows(real), { dateLabel: `desde ${sinceIso}`, total: real.length })
  console.log(`\n${real.length} conexiones desde ${sinceIso}`)
  if (arg === '--dry-run') {
    console.log(realHtml)
  } else {
    const to = arg.split('=')[1]
    const res = await sendEmail({ to: [to], subject: `[TEST] 🤝 ClawBot digest — ${real.length} conexiones`, html: realHtml })
    console.log(res.ok ? `✅ enviado a ${to} (id ${res.id})` : `❌ envío falló: ${res.error}`)
    if (!res.ok) process.exit(1)
  }
}
