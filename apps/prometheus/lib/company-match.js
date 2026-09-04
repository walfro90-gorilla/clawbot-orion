// Verificación de lo que trae el scraper, en el ingest.
//   · headlineNamesCompany — post-mortem 2026-08-17 (Aduanas Infinity)
//   · isCardChrome         — post-mortem 2026-09-04 (Josh / SalesNav)
//
// Verificación de empresa — post-mortem 2026-08-17 (Aduanas Infinity).
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

// ── Chrome de la tarjeta de búsqueda — post-mortem 2026-09-04 (Josh / SalesNav) ──────
//
// Los dos scrapers ADIVINAN el headline: recogen el textContent de todos los span/div de
// la tarjeta y eligen por regex. Los paneles de la propia UI entran a esa sopa como
// candidatos de primera clase. Medido sobre 2.838 leads:
//   · 39 filas "Experiencia: 2017 - 2022 ( 5 años ) ABB Director de marketing" — casa el
//     regex de rol LEGÍTIMAMENTE. Es un puesto PASADO en una empresa PASADA: pasa el
//     whitelist, saca seniority alta y se lleva un turno de invitación (medido:
//     "… Siemens CEO Executive Assistant" ⇒ lead_score 85, invite_sent).
//   · 28 filas "6 contactos en común" — el regex de rol de content.js no lleva `\b`, así
//     que `cto` casa dentro de "conta-CTO-s" y gana como match POSITIVO.
//   · 15 filas "N mil seguidores" — en las CUATRO cuentas, no solo en SalesNav.
// 19 de esos leads recibieron contacto real (12 invite_sent, 4 follow_up_sent, 1 replied).
//
// El dato FALSO es peor que el ausente: los guards de aguas abajo están escritos para
// "sin dato" (passesTitleFilters pasa con headline vacío, toDefer captura el nulo), así
// que el chrome se cuela justo por donde el hueco se difiere para revisión.
//
// Chokepoint hermano de matchesCampaignGeo/headlineNamesCompany (ADR-0006): server-side,
// cubre free Y SalesNav, y protege a las cuentas con la extensión rezagada de versión.
//
// "Experiencia:" y "Acerca de:" van ANCLADOS al inicio a propósito: sueltos tumbaban un
// headline humano REAL de la cuenta Rosy ("FVL Gerente Sr. | Experiencia: Mazda + Glovis
// + Isuzu + BMW Group"). Medido contra las 2.838 filas antes de aceptar el patrón.
//
// ponytail: blocklist de las cadenas de UI medidas en prod, no un clasificador. Panel
// nuevo de LinkedIn (o cuenta con la UI en inglés) ⇒ entrada nueva aquí. El fix de raíz
// —que el extractor lea el nodo del titular en vez de adivinar— vive en la extensión y
// no puede cubrir las versiones ya instaladas; este guard sí.
const CARD_CHROME_RE = /contactos?\s+(m[aá]s\s+)?en\s+com[uú]n|grupos?\s+en\s+com[uú]n|^\s*(acerca de|experiencia)\s*:|guarda este posible cliente|[uú]ltima conexi[oó]n de|^\s*\d[\d.,]*\s*(mil\s+)?(seguidores?|followers?)\s*$/i

/** ¿El texto es chrome de la tarjeta de búsqueda en vez de un dato del perfil? */
export function isCardChrome(text) {
  return CARD_CHROME_RE.test(String(text ?? ''))
}
