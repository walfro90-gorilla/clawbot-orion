// Self-check del clasificador puesto-vs-ubicación del scraper de búsqueda
// (ext 0.10.31, 21-ago-2026).
// (copia fiel de `looksLikeLocation` de content.js: son funciones de la extensión, que no
//  se puede importar desde Node. Si cambias una, cambia la otra.)
//
// El bug que cierra: `commas >= 2` daba por UBICACIÓN cualquier texto con una lista, y en
// LinkedIn los headlines son listas. "Director (VP) Supply Chain, Logistics,
// Transportation, Imports" (4 comas) se clasificaba como lugar ⇒ el headline se anulaba
// (queda null) Y acababa guardado en `location`. Efecto en cadena: sin headline,
// tryEnrichCompanies no tiene de dónde sacar la empresa ⇒ el lead sale en el reporte al
// cliente sin puesto y sin empresa.
//
// Los dos sentidos:
//  - FALSO POSITIVO (puesto tomado por lugar): pierde el puesto Y la empresa. Es el bug.
//  - FALSO NEGATIVO (lugar tomado por puesto): mete una ciudad en el headline, que luego
//    el LLM intentaría leer como empresa. Por eso las frases geográficas fuertes mandan.
import assert from 'node:assert/strict'

function looksLikeLocation(t) {
  if (!t) return false
  const lower = t.toLowerCase()
  const looksLikeRole = /\b(?:director|gerente|manager|chief|ceo|cto|cio|cfo|cmo|coo|vp|founder|fundador|head of|jefe|lead|consultor|consultant|analista|analyst|especialista|specialist|engineer|ingenier|developer|president|owner|socio|supervisor|coordinador|buyer|comprador|planner|planeador|sourcing|procurement|logistic|log[ií]stic|supply chain)/i.test(t)
    || t.includes('|')
  const strongGeoPhrases = [
    'área metropolitana', 'metropolitan area', 'greater ', ' area',
    'estado de', 'cdmx', 'ciudad de méxico', 'ciudad de mexico',
    'mexico city', 'buenos aires', 'são paulo', 'sao paulo',
  ]
  if (strongGeoPhrases.some(g => lower.includes(g))) return true
  const standalonePlaces = [
    'méxico', 'mexico', 'argentina', 'chile', 'colombia', 'peru', 'perú',
    'spain', 'españa', 'usa', 'united states', 'brasil', 'brazil',
    'monterrey', 'guadalajara', 'tijuana', 'puebla', 'querétaro', 'queretaro',
    'tabasco', 'jalisco', 'nuevo león', 'nuevo leon', 'tamaulipas',
    'sonora', 'sinaloa', 'chihuahua', 'veracruz', 'yucatán', 'yucatan',
    'nayarit', 'oaxaca', 'guerrero', 'michoacán', 'michoacan',
    'aguascalientes', 'morelos', 'coahuila', 'durango', 'zacatecas',
    'hidalgo', 'tlaxcala', 'campeche', 'quintana roo', 'baja california',
    'colima', 'nuevo laredo', 'mérida', 'merida', 'cancún', 'cancun',
    'cabo san lucas', 'tuxtla', 'culiacán', 'culiacan', 'mexicali',
    'león', 'leon', 'san luis potosí',
  ]
  const commas = (t.match(/,/g) || []).length
  const trimmed = t.trim().toLowerCase()
  if (trimmed.length < 40 && standalonePlaces.some(p => trimmed === p || trimmed.startsWith(p + ',') || trimmed.endsWith(', ' + p))) return true
  if (looksLikeRole) return false
  if (commas >= 2) return true
  if (standalonePlaces.some(g => lower.includes(g)) && commas >= 1) return true
  if (/^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+([\s\-]+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*(,\s*[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+$/.test(t)) return true
  return false
}

// ── NO son ubicación: headlines REALES que el bug mandaba a `location` ───────
// (sacados de extension_commands de los últimos 7 días)
const HEADLINES_REALES = [
  'Project Consultant | Logistics, Supply Chain, Transformations, Governance, Program Management',
  'Director de Transformación y Tecnología para México, Centroamérica y el Caribe',
  'Purchasing Manager / Director North America, Investment Specialist, Strategic Sourcing & MRO',
  'Production Manager, Manufacturing Enginnering, Quality Managment System',
  'Gerente de operaciones almacen logistica en MAZDA LOGISTICA DE MEXICO, S.A. DE C.V.',
  'Air & Ocean Procurement/Pricing Manager, RFP/ RFQ Manager, Inside Sales Management',
  'Gerente de Ventas Industria Automotriz y mercados alternos | Ventas OEM, Tier 1, 2',
  'Lean Manufacturing, industrial engineering, supply chain.',
  'Director (VP) Supply Chain, Logistics, Transportation, Imports',
  'Gerente de Tecnologías de la Información, Transformación Digital, Sistemas Corporativos',
]
for (const h of HEADLINES_REALES) {
  assert.equal(looksLikeLocation(h), false, `headline tomado por ubicación: "${h}"`)
}

// ── SÍ son ubicación: no se puede romper la detección real ──────────────────
const UBICACIONES_REALES = [
  'Monterrey, Nuevo León, México',
  'Saltillo, Coahuila de Zaragoza, México',
  'Bogotá, Distrito Capital, Colombia',
  'Área metropolitana de Querétaro',
  'Ciudad de México, México',
  'México',
  'Heroica Matamoros, Tamaulipas, México',
  'Irapuato, Guanajuato, México',
  'Sao Paulo, San Pablo, Brasil',
  'Vinh Phuc, Vietnam',
]
for (const l of UBICACIONES_REALES) {
  assert.equal(looksLikeLocation(l), true, `ubicación NO detectada: "${l}"`)
}

// ── Los sufijos que exigieron quitar el \b de cierre ────────────────────────
assert.equal(looksLikeLocation('Lean Manufacturing, industrial engineering, supply chain.'), false)
assert.equal(looksLikeLocation('Leading Operations, Logistics, Warehousing'), false)
assert.equal(looksLikeLocation('Logística, Transporte, Aduanas'), false)

// ── El pipe: separador de headline, nunca de ciudad ─────────────────────────
assert.equal(looksLikeLocation('Ventas | Compras | Almacén'), false)

// ── Casos borde ────────────────────────────────────────────────────────────
assert.equal(looksLikeLocation(''), false)
assert.equal(looksLikeLocation(null), false)
// Sin señal de rol y con 2+ comas sigue siendo ubicación (comportamiento previo intacto).
assert.equal(looksLikeLocation('Tres Rios, Cartago, Costa Rica'), true)
// ⚠️ LÍMITE CONOCIDO: una frase geográfica fuerte gana aunque el texto sea un puesto.
// Es deliberado (perder una ubicación real es peor) y raro en headlines, pero queda
// escrito para que nadie lo lea como un fallo nuevo.
assert.equal(looksLikeLocation('Gerente de Ventas en Área metropolitana de Monterrey'), true)

console.log('✅ profile-fields OK (headline con comas ya no se toma por ubicación)')
