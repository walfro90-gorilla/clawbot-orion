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
const clean = v => (v && String(v).trim()) ? String(v).trim() : ''

// El nombre de empresa puede venir del array que el usuario teclea en el Centro de
// Control ("home depot"), así que en el reporte al cliente sale en minúsculas junto
// a las que sí vienen bien ("MOLEX", "FORVIA HELLA"). Solo se capitaliza cuando NO
// hay ninguna mayúscula — así no se destroza un acrónimo ni un CamelCase legítimo.
const TITLE_MINOR = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'of', 'the', 'and'])
function prettyCompany(name) {
  const s = clean(name)
  if (!s || /[A-ZÁÉÍÓÚÑÜ]/.test(s)) return s
  return s.split(/(\s+)/).map((w, i) => {
    if (/^\s+$/.test(w)) return w
    if (i > 0 && TITLE_MINOR.has(w)) return w
    return w.charAt(0).toUpperCase() + w.slice(1)
  }).join('')
}

// ── Paleta / tipografía del reporte ──────────────────────────────────────────
const RED   = '#C8102E'
const INK   = '#111111'
const MUTED = '#666666'
const RULE  = '#e6e6e6'
const SANS  = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const MONO  = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace"

// Aplana los grupos a una lista ordenada del MÁS RECIENTE al más antiguo.
// El reporte numera descendente (#N … #1), así que el orden de entrada (que
// daily-digest trae ascendente por connected_at) se invierte aquí.
export function flattenRows(groups) {
  const out = []
  for (const [label, byCampaign] of groups) {
    for (const [camp, rows] of byCampaign) {
      for (const r of rows) out.push({ ...r, _account: label, _campaign: camp })
    }
  }
  return out.sort((a, b) => String(b.connected_at ?? '').localeCompare(String(a.connected_at ?? '')))
}

function kpiCell(value, label, width) {
  return `<td width="${width}%" style="border:1px solid ${RULE};padding:16px 10px;text-align:center;vertical-align:middle">`
    + `<div style="font-family:${SANS};font-size:26px;font-weight:800;color:${RED};line-height:1.1">${esc(value)}</div>`
    + `<div style="font-family:${SANS};font-size:10.5px;color:${MUTED};margin-top:6px;line-height:1.35">${esc(label)}</div>`
    + `</td>`
}

// Un lead: #N · Empresa · Nombre · Puesto · contacto (mono) · dirección (itálica)
function leadBlock(r, num) {
  const ci = (r.contact_info && typeof r.contact_info === 'object') ? r.contact_info : {}
  const pd = (r.profile_data && typeof r.profile_data === 'object') ? r.profile_data : {}

  const company = prettyCompany(clean(ci.company) || clean(pd.currentCompany) || clean(pd.targetCompany)) || '—'
  const name    = clean(r.full_name) || '—'
  const role    = clean(pd.headline)
  // phones/address ya los produce el scraper desde ext 0.10.40 (pares etiqueta→valor del
  // overlay). `ci.phone` en singular se mantiene por si alguna fila vieja lo trae.
  const phones  = Array.isArray(ci.phones) ? ci.phones.filter(Boolean) : (clean(ci.phone) ? [clean(ci.phone)] : [])
  const email   = clean(ci.email)
  const address = clean(ci.address)

  const nameHtml = r.linkedin_url
    ? `<a href="${esc(r.linkedin_url)}" style="color:${RED};text-decoration:none">${esc(name)}</a>`
    : esc(name)

  const contactBits = [
    // El tipo ("(móvil)"/"(trabajo)") lo quita el scraper, así que NO lo demos por móvil:
    // el primer teléfono real que llegó era de trabajo.
    ...phones.map(p => esc(p)),
    email ? `<a href="mailto:${esc(email)}" style="color:#333;text-decoration:none">${esc(email)}</a>` : '',
  ].filter(Boolean)

  return `<tr>`
    + `<td width="56" valign="top" style="padding:14px 0 14px 0;border-top:1px solid ${RULE}">`
      + `<div style="font-family:${SANS};font-size:15px;font-weight:700;color:#c9c9c9">#${num}</div>`
    + `</td>`
    + `<td valign="top" style="padding:14px 0;border-top:1px solid ${RULE}">`
      + `<div style="font-family:${SANS};font-size:15px;font-weight:700;color:${INK};line-height:1.3">${esc(company)}</div>`
      + `<div style="font-family:${SANS};font-size:13.5px;font-weight:700;color:${RED};margin-top:2px;line-height:1.3">${nameHtml}</div>`
      + (role ? `<div style="font-family:${SANS};font-size:12.5px;color:${MUTED};margin-top:4px;line-height:1.4">${esc(role)}</div>` : '')
      + (contactBits.length
          ? `<div style="font-family:${MONO};font-size:12px;color:#444;margin-top:6px;line-height:1.5">${contactBits.join('&nbsp;&nbsp;|&nbsp;&nbsp;')}</div>`
          : '')
      + (address ? `<div style="font-family:${SANS};font-style:italic;font-size:11.5px;color:#555;margin-top:4px;line-height:1.4">Dirección: ${esc(address)}</div>` : '')
    + `</td>`
    + `</tr>`
}

/**
 * Reporte ORION — Leads Generados.
 * @param {Map} groups  Map(cuenta → Map(campaña → rows)), de groupRows()
 * @param {object} opts
 *   dateLabel  fecha legible del envío
 *   total      nº de leads del período
 *   brand      marca del encabezado (default EBOOMS)
 *   intro      línea descriptiva bajo el título
 *   kpis       [{value,label}] — máx 3. Si no se pasan, se derivan de los rows.
 *   notice     {title, body} — caja de aviso opcional (no se pinta sin ella)
 */
export function buildDigestHtml(groups, { dateLabel, total, brand = 'EBOOMS', intro, kpis, notice } = {}) {
  const rows = flattenRows(groups ?? new Map())
  const accounts  = [...new Set(rows.map(r => r._account))]
  const campaigns = [...new Set(rows.map(r => r._campaign))]

  const eyebrow = ['SISTEMA ORION', 'PROSPECCIÓN LINKEDIN', ...accounts.map(a => a.toUpperCase())].join(' · ')

  const conEmail = rows.filter(r => clean(r.contact_info?.email)).length
  const cards = (Array.isArray(kpis) && kpis.length ? kpis : [
    { value: String(total ?? rows.length), label: 'Conexiones totales generadas' },
    { value: String(conEmail), label: 'Contactos con email identificado' },
    { value: String(campaigns.length), label: campaigns.length === 1 ? 'Campaña activa' : 'Campañas activas' },
  ]).slice(0, 3)
  const w = Math.floor(100 / cards.length)

  const leadsHtml = rows.length
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">`
        + rows.map((r, i) => leadBlock(r, rows.length - i)).join('')
      + `</table>`
    : `<p style="font-family:${SANS};font-size:13.5px;color:${MUTED};margin:0">Sin conexiones nuevas desde el último reporte.</p>`

  return `<div style="background:#f4f4f5;padding:24px 10px;margin:0">`
    + `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;max-width:720px;margin:0 auto;background:#ffffff">`
    + `<tr><td style="padding:34px 40px 40px 40px">`

      // Encabezado
      + `<div style="font-family:${SANS};font-size:19px;font-weight:800;color:${RED};letter-spacing:.6px">${esc(brand)}</div>`
      + `<div style="font-family:${SANS};font-size:10.5px;font-weight:700;color:${INK};letter-spacing:.7px;margin-top:3px">${esc(eyebrow)}</div>`
      + `<h1 style="font-family:${SANS};font-size:27px;font-weight:800;color:${INK};margin:14px 0 7px;line-height:1.2">Reporte ORION — Leads Generados</h1>`
      + `<p style="font-family:${SANS};font-size:13.5px;color:#555;margin:0;line-height:1.5">`
        + esc(intro || 'Contactos y oportunidades identificadas por el sistema desde su activación.')
      + `</p>`
      + `<div style="border-top:2px solid ${RED};margin-top:18px;font-size:0;line-height:0">&nbsp;</div>`

      // KPIs
      + `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:20px 0 0">`
        + `<tr>${cards.map(c => kpiCell(c.value, c.label, w)).join('')}</tr>`
      + `</table>`

      // Aviso opcional
      + (notice?.body
          ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:20px 0 0;background:#FDF4E0">`
            + `<tr><td style="border-left:4px solid #E0A03A;padding:14px 18px">`
              + (notice.title
                  ? `<div style="font-family:${SANS};font-size:11.5px;font-weight:700;color:#B07D18;letter-spacing:.5px">■ ${esc(notice.title)}</div>`
                  : '')
              + `<div style="font-family:${SANS};font-size:12.5px;color:#4a4a4a;margin-top:8px;line-height:1.6">${esc(notice.body)}</div>`
            + `</td></tr></table>`
          : '')

      // Sección de leads
      + `<div style="font-family:${SANS};font-size:11.5px;font-weight:700;color:${RED};letter-spacing:.7px;margin:28px 0 6px">LEADS GENERADOS</div>`
      + `<p style="font-family:${SANS};font-size:13px;color:#555;margin:0 0 6px;line-height:1.5">`
        + (rows.length
            ? `Detalle de los ${rows.length} contactos identificados, del más reciente al primero.`
            : 'Sin novedades en este período.')
      + `</p>`
      + leadsHtml

      // Pie
      + `<div style="border-top:1px solid ${RULE};margin-top:28px;padding-top:14px">`
        + `<p style="font-family:${SANS};font-size:11px;color:#999;margin:0;line-height:1.6">`
          + `${esc(dateLabel ?? '')} · Enviado automáticamente por Orion Lead Connections.<br>`
          + `El email y el teléfono aparecen cuando el contacto los hace visibles a su red (1er grado).`
        + `</p>`
      + `</div>`

    + `</td></tr></table></div>`
}
