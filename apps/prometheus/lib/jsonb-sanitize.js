// Saneo de valores antes de escribirlos en una columna jsonb.
// (21-ago-2026) Postgres no admite el carácter NUL (\u0000) dentro de un valor jsonb, y un
// surrogate UTF-16 suelto rompe el encoding del body. PostgREST responde
// "Empty or invalid json" — un mensaje que suena a body vacío y manda a buscar el
// problema donde no está. Caso Josh: 18 de 20 check_connections se perdían por esto
// (400+ nombres scrapeados de LinkedIn, basta uno envenenado), la fila se quedaba en
// `dispatched` hasta expirar y la accept-detection se daba por muerta. Se exporta para
// el self-check: scripts/test-jsonb-sanitize.js.
export function sanitizeForJsonb(value) {
  let stripped = 0
  const clean = (s) => {
    // NUL + resto de controles C0 (salvo \t \n \r) + surrogates sin pareja.
    const out = s
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
      .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    if (out.length !== s.length) stripped++
    return out
  }
  const walk = (v) => {
    if (typeof v === 'string') return clean(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const o = {}
      for (const [k, val] of Object.entries(v)) o[clean(k)] = walk(val)
      return o
    }
    return v
  }
  return { value: walk(value), stripped }
}
