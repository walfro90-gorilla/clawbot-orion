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

// Sin contact_info → sin mailto; empresa cae a profile_data.currentCompany
let html = buildDigestHtml(groups, { dateLabel: 'lunes 10 de agosto', total: 4 })
assert.ok(html.includes('Acme'))
assert.ok(html.includes('CFO en Acme'))
assert.ok(html.includes('href="https://linkedin.com/in/ana"'))
assert.ok(!html.includes('mailto:'))
assert.ok(html.includes('Reporte ORION'))
assert.ok(html.includes('EBOOMS'))
assert.ok(html.includes('LEADS GENERADOS'))

// Numeración DESCENDENTE y orden del más reciente al más antiguo.
const ordered = groupRows([
  mkRow('Wal', 'Café', { full_name: 'Viejo',  connected_at: '2026-08-01T10:00:00Z' }),
  mkRow('Wal', 'Café', { full_name: 'Nuevo',  connected_at: '2026-08-09T10:00:00Z' }),
  mkRow('Wal', 'Café', { full_name: 'Medio',  connected_at: '2026-08-05T10:00:00Z' }),
])
html = buildDigestHtml(ordered, { dateLabel: 'x', total: 3 })
assert.ok(html.indexOf('Nuevo') < html.indexOf('Medio'), 'el más reciente va primero')
assert.ok(html.indexOf('Medio') < html.indexOf('Viejo'))
// ojo: buscar '#1' a secas hace match dentro de los colores hex (#111111) —
// anclar al render real del número: >#N<
assert.ok(html.includes('>#3<') && html.includes('>#1<'), 'numera descendente')
assert.ok(html.indexOf('>#3<') < html.indexOf('>#1<'), 'el número más alto va primero')

// Con contact_info → email como mailto, teléfono en el bloque mono, company gana
const rich = mkRow('Wal', 'Café', {
  contact_info: { email: 'ana@acme.com', phones: ['+52 55 1234 5678'], company: 'Acme Corp' },
})
html = buildDigestHtml(groupRows([rich]), { dateLabel: 'x', total: 1 })
assert.ok(html.includes('mailto:ana@acme.com'))
assert.ok(html.includes('+52 55 1234 5678'))
assert.ok(html.includes('Acme Corp'))

// address → línea "Dirección:" en itálica (hoy el scraper no la produce; el
// reporte debe pintarla en cuanto exista)
html = buildDigestHtml(groupRows([mkRow('Wal', 'Café', {
  contact_info: { address: 'Privada Paraíso 106, Monterrey, NL.' },
})]), { dateLabel: 'x', total: 1 })
assert.ok(html.includes('Dirección: Privada Paraíso 106, Monterrey, NL.'))

// Centinela {} (visitado, sin datos) → sin mailto, sin crash, sin línea de contacto
html = buildDigestHtml(groupRows([mkRow('Wal', 'Café', { contact_info: {} })]), { dateLabel: 'x', total: 1 })
assert.ok(!html.includes('mailto:'))
assert.ok(!html.includes('Dirección:'))

// 0 conexiones → mensaje vacío explícito
html = buildDigestHtml(new Map(), { dateLabel: 'x', total: 0 })
assert.ok(html.includes('Sin conexiones nuevas'))

// notice: NO se pinta si no se pasa; se pinta (escapado) si se pasa
html = buildDigestHtml(groupRows([mkRow('Wal', 'Café')]), { dateLabel: 'x', total: 1 })
assert.ok(!html.includes('ESTATUS DEL SISTEMA'))
html = buildDigestHtml(groupRows([mkRow('Wal', 'Café')]), {
  dateLabel: 'x', total: 1,
  notice: { title: 'ESTATUS DEL SISTEMA — OPERANDO LIMITADO', body: 'Opera a 1ra velocidad <b>x</b>.' },
})
assert.ok(html.includes('ESTATUS DEL SISTEMA — OPERANDO LIMITADO'))
assert.ok(!html.includes('<b>x</b>'), 'el cuerpo del aviso se escapa')

// kpis explícitos ganan a los derivados
html = buildDigestHtml(groupRows([mkRow('Wal', 'Café')]), {
  dateLabel: 'x', total: 1,
  kpis: [{ value: '136', label: 'Conexiones totales generadas' }, { value: '26', label: 'Leads con respuesta / oportunidad' }, { value: '1ra', label: 'Velocidad actual del sistema' }],
})
assert.ok(html.includes('136') && html.includes('26') && html.includes('1ra'))
assert.ok(html.includes('Velocidad actual del sistema'))

// Empresa en minúsculas (tecleada en el Centro de Control) → Title Case; los
// acrónimos y CamelCase legítimos NO se tocan.
html = buildDigestHtml(groupRows([mkRow('Wal', 'Café', {
  profile_data: { targetCompany: 'home depot de mexico' },
})]), { dateLabel: 'x', total: 1 })
assert.ok(html.includes('Home Depot de Mexico'), 'capitaliza y respeta la minúscula de enlace')
for (const keep of ['MOLEX', 'FORVIA HELLA', 'thyssenkrupp Automotive', 'OPmobility (USA)']) {
  const h = buildDigestHtml(groupRows([mkRow('Wal', 'Café', { profile_data: { targetCompany: keep } })]), { dateLabel: 'x', total: 1 })
  assert.ok(h.includes(keep.replace(/&/g, '&amp;')), `no debe reescribir "${keep}"`)
}

// Escape de HTML en datos del perfil (headline hostil)
html = buildDigestHtml(groupRows([mkRow('Wal', 'Café', {
  full_name: 'X <script>alert(1)</script>', profile_data: { headline: 'a & b' },
})]), { dateLabel: 'x', total: 1 })
assert.ok(!html.includes('<script>'))
assert.ok(html.includes('a &amp; b'))

// La cuenta aparece en el eyebrow del encabezado
html = buildDigestHtml(groupRows([mkRow('Wal', 'Fintech')]), { dateLabel: 'x', total: 1 })
assert.ok(html.includes('WAL'), 'la cuenta va en el eyebrow, en mayúsculas')

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
