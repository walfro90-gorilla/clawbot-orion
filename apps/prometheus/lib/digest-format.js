// ── Funciones PURAS del digest diario (sin supabase/env) ─────────────────────
// Separadas de daily-digest.js para que scripts/test-digest.js pueda correr los
// asserts de formato sin exigir .env (mismo motivo que test-geo-filter.js).

const DEFAULT_TZ = 'America/Mexico_City'

// Offset (ms) de la tz en un instante dado — para calcular la medianoche LOCAL.
function tzOffsetMs(tz, date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map(p => [p.type, p.value]))
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second)
  return asUTC - date.getTime()
}

// Instante UTC (ISO) de las 00:00 de AYER en la tz — since del primer envío
// (sin high_water todavía): cubre exactamente el día de ayer local.
export function startOfYesterdayIso(tz = DEFAULT_TZ) {
  const y = new Date(Date.now() - 86_400_000)
  const [yy, mm, dd] = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(y).split('-').map(Number)
  const utcMidnight = Date.UTC(yy, mm - 1, dd)
  return new Date(utcMidnight - tzOffsetMs(tz, new Date(utcMidnight))).toISOString()
}

// rows → Map(label → Map(campaña → rows))
export function groupRows(rows) {
  const groups = new Map()
  for (const r of rows) {
    const label = r.campaigns?.linkedin_accounts?.label ?? '(sin cuenta)'
    const camp = r.campaigns?.name ?? '(sin campaña)'
    if (!groups.has(label)) groups.set(label, new Map())
    const byCampaign = groups.get(label)
    if (!byCampaign.has(camp)) byCampaign.set(camp, [])
    byCampaign.get(camp).push(r)
  }
  return groups
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const dash = v => (v && String(v).trim()) ? esc(v) : '—'

const TD = 'padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;vertical-align:top'
const TH = 'padding:6px 10px;border-bottom:2px solid #d1d5db;font-size:12px;text-align:left;color:#6b7280;text-transform:uppercase'

export function buildDigestHtml(groups, { dateLabel, total }) {
  let body = ''
  for (const [label, byCampaign] of groups) {
    body += `<h2 style="font-size:16px;margin:24px 0 4px">👤 ${esc(label)}</h2>`
    for (const [camp, rows] of byCampaign) {
      body += `<p style="margin:8px 0 4px;font-size:13px;color:#6b7280">Campaña: <strong>${esc(camp)}</strong> — ${rows.length} conexión${rows.length === 1 ? '' : 'es'}</p>`
      body += `<table style="border-collapse:collapse;width:100%;max-width:760px"><tr>`
        + `<th style="${TH}">Nombre</th><th style="${TH}">Empresa</th><th style="${TH}">Cargo</th>`
        + `<th style="${TH}">Email</th><th style="${TH}">Teléfono</th></tr>`
      for (const r of rows) {
        const ci = (r.contact_info && typeof r.contact_info === 'object') ? r.contact_info : {}
        const pd = (r.profile_data && typeof r.profile_data === 'object') ? r.profile_data : {}
        const name = r.linkedin_url
          ? `<a href="${esc(r.linkedin_url)}" style="color:#2563eb">${dash(r.full_name)}</a>`
          : dash(r.full_name)
        const phones = Array.isArray(ci.phones) ? ci.phones.filter(Boolean).join(', ') : ''
        body += `<tr><td style="${TD}">${name}</td>`
          + `<td style="${TD}">${dash(ci.company ?? pd.currentCompany)}</td>`
          + `<td style="${TD}">${dash(pd.headline)}</td>`
          + `<td style="${TD}">${ci.email ? `<a href="mailto:${esc(ci.email)}" style="color:#2563eb">${esc(ci.email)}</a>` : '—'}</td>`
          + `<td style="${TD}">${dash(phones)}</td></tr>`
      }
      body += `</table>`
    }
  }
  if (!total) body = `<p style="font-size:14px;color:#6b7280">Sin conexiones nuevas desde el último reporte.</p>`
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;padding:8px">`
    + `<h1 style="font-size:18px;margin:0 0 4px">🤝 ClawBot — conexiones aceptadas</h1>`
    + `<p style="margin:0 0 8px;font-size:13px;color:#6b7280">${esc(dateLabel)} · total: ${total}</p>`
    + body
    + `<p style="margin-top:24px;font-size:11px;color:#9ca3af">Enviado automáticamente por ClawBot Orion. Email/teléfono aparecen cuando el contacto los hace visibles a su red (1er grado).</p>`
    + `</div>`
}
