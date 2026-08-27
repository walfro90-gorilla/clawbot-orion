// Puntuación de leads (26-ago-2026) — reparte las ~25 invitaciones diarias.
//
// El techo anti-ban es fijo: da igual cuántos leads entren, se invita a ~25 al día. Lo
// único que mueve la aguja es GASTAR ESAS 25 EN LOS MEJORES. Antes el orden vivía suelto
// dentro del picker (`fromList > seniorityRank > FIFO`), se recalculaba cada tick y se
// tiraba; no había forma de ver por qué se eligió a alguien ni de filtrar por calidad en
// el CRM. Esto lo vuelve un número persistido con su desglose.
//
// ponytail: SOLO señales que ya están en la mano en el momento del ingest. Cero llamadas
// LLM nuevas, cero navegación extra. El upgrade (si hace falta finura: idiomas raros,
// títulos inventados) es puntuar con el LLM en el pass de enriquecimiento y sobrescribir
// `lead_score` ahí — la forma de la fila no cambia.
//
// La escala es 0..100 para que se lea sin tabla de conversión. Los pesos NO están
// calibrados con datos (no los hay todavía): son el orden que ya usaba el picker, escrito
// explícito. Recalibrar contra tasa de aceptación cuando haya historia.
//
// ⚠️ `fromList` (el lead salió de una empresa de la lista del cliente) NO entra aquí a
// propósito. En el picker es la llave PRIMARIA y la seniority solo desempata dentro de
// ella — el flujo company-scoped congelado lo garantiza así ("primero los de la lista, y
// dentro de la lista el de más responsabilidad"). Sumarlo como puntos rompía eso: un CEO
// fuera de la lista le ganaba a un coordinador de la lista. Esto mide CALIDAD DEL PERFIL;
// la pertenencia a la lista es targeting y se queda donde estaba.
import { seniorityRank } from './extension-dispatch.js'

// Mismo normalizador permisivo que `passesTitleFilters` (substring, insensible a acentos,
// preserva la ñ descompuesta). Se copia y no se importa porque allá es privado; si cambia
// uno, cambia el otro.
const _stripAcc = (s) => (s ?? '').toLowerCase().normalize('NFD').replace(/[́̈]/g, '')

export const WEIGHTS = {
  seniorityPerTier: 15, // 0..5 → 0..75. La señal dominante, igual que en el picker viejo.
  companyCertain:   10, // facet currentCompany: LinkedIn GARANTIZA la empresa (dato duro)
  preferred:        15, // cazó un término de campaigns.title_preferred
}

/**
 * Puntúa un lead con lo disponible en el ingest.
 * @param {object} p
 * @param {string} [p.headline]          headline scrapeado
 * @param {boolean} [p.companyIsCertain] true solo si la búsqueda llevó facet currentCompany
 * @param {string[]} [p.preferred]       campaigns.title_preferred — SUMA, nunca rechaza
 * @returns {{score:number, reasons:object}}
 */
export function scoreLead({ headline = '', companyIsCertain = false, preferred = [] } = {}) {
  const seniority = seniorityRank(headline)
  const hasHeadline = (headline ?? '').trim().length > 0

  // El preferido es el opuesto exacto del whitelist: ordena en vez de matar. Sin headline
  // no hay nada que cazar — no se inventa un match.
  const hn = _stripAcc(headline)
  const preferredHits = hasHeadline
    ? (preferred ?? []).filter(w => w && hn.includes(_stripAcc(w)))
    : []

  // Sin headline el score es 0 y el lead cae al desempate FIFO del picker — exactamente
  // lo que ya le pasaba con seniorityRank 0. No se mata, se manda al final de la fila.
  // Importa: ~33-44% de los perfiles de Café 57 salen sin headline (bug del scraper, abierto).
  const score =
    seniority * WEIGHTS.seniorityPerTier +
    (companyIsCertain ? WEIGHTS.companyCertain : 0) +
    (preferredHits.length ? WEIGHTS.preferred : 0)

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons: {
      seniority,
      companyCertain: !!companyIsCertain,
      preferred: preferredHits,
      hasHeadline, // diagnóstico: distingue "sin evidencia" de "evidencia sin jerarquía"
    },
  }
}

/**
 * Puntúa desde una fila de `leads` ya guardada. Se usa como red del picker: los leads
 * anteriores a esta feature (y los que entran por importación CSV) tienen `lead_score`
 * NULL, y ordenar por NULL los mandaría al fondo para siempre. Con esto el picker se
 * auto-cura sin backfill.
 */
export function scoreLeadRow(lead, preferred = []) {
  const pd = lead?.profile_data ?? {}
  return scoreLead({
    headline: pd.headline ?? '',
    // `currentCompany` solo se estampa igual a `targetCompany` cuando la búsqueda llevó
    // facet (ingestSearch). Si el LLM de tryEnrichCompanies lo dedujo del headline, será
    // otro string (o '') y NO cuenta como evidencia dura.
    companyIsCertain: !!pd.currentCompany && pd.currentCompany === pd.targetCompany,
    preferred,
  })
}
