// Verificación de empresa en el ingest — post-mortem 2026-08-17 (Aduanas Infinity).
//
// PROBLEMA: desde que LinkedIn dejó de exponer el company URN (12-ago), toda empresa nueva
// entra "degradada": sin URN no hay facet `currentCompany`, así que el nombre viaja como
// TEXTO LIBRE en la query. LinkedIn lo matchea de forma laxísima ⇒ el scoping de empresa
// queda DECORATIVO: devuelve a cualquiera que cuadre con el puesto y la geo.
// Medido en la campaña de Aduanas Infinity: de 104 leads con empresa objetivo, 46 trabajaban
// en otra (BWI, Sensata, Dana, Degas Café, Astemo, ISUZU, Merik, Samsung…) y solo 43 en la
// empresa pedida. El cliente recibió invitaciones a empresas que no son las suyas.
//
// `ingestSearch` ya distinguía el caso (`companyIsCertain`) pero solo lo usaba para decidir
// si estampaba `currentCompany`; no descartaba nada. Esto es el chokepoint que faltaba,
// hermano de `matchesCampaignGeo`: server-side, cubre free Y SalesNav, no toca los scrapers.
//
// ponytail: tokens + includes, no fuzzy matching. Si algún día hace falta distinguir
// "Ford" de "Ford Credit", ahí sí toca algo más listo.

// Mismos tokens genéricos que el scoring de la extensión (content.js `_nameScore` /
// background.js `coreCompanyName`). Si cambias uno, cambia el otro.
const GENERIC_NAME_TOKENS = new Set([
  'internacional', 'international', 'mexico', 'mexicana', 'mexicano', 'latam',
  'grupo', 'group', 'holding', 'holdings', 'company', 'corporativo', 'corporation',
  'servicios', 'services', 'solutions', 'soluciones', 'industrias', 'industries',
  'comercial', 'global', 'sapi', 'srl', 'inc', 'ltd', 'llc', 'sade', 'de', 'cv',
])

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

/** Tokens significativos del nombre de empresa (sin genéricos ni palabras de ≤2 letras). */
export function companyTokens(name) {
  return norm(name).split(/[^a-z0-9]+/).filter(t => t.length > 2 && !GENERIC_NAME_TOKENS.has(t))
}

/**
 * ¿El headline del perfil nombra la empresa objetivo?
 *
 * Exige TODOS los tokens significativos, no solo uno: con `some`, el objetivo
 * "General Motors de México" aceptaría "Gerente en ISUZU Motors de México" — que es
 * exactamente uno de los falsos positivos medidos.
 *
 * Devuelve true (conserva) cuando NO se puede juzgar: nombre de empresa 100% genérico.
 * Devuelve false (descarta) si no hay headline: en modo degradado no existe ninguna otra
 * evidencia de dónde trabaja, y la regla del proyecto es "mejor menos leads de la lista
 * que basura fuera de parámetros" (decisión 10-ago).
 */
export function headlineNamesCompany(headline, companyName) {
  const tokens = companyTokens(companyName)
  if (tokens.length === 0) return true
  const h = norm(headline)
  if (!h) return false
  return tokens.every(t => h.includes(t))
}
