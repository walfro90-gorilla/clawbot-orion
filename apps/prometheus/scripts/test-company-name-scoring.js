// Self-check del scoring de páginas de empresa (content.js _nameScore + background.js
// coreCompanyName). Correr: node apps/prometheus/scripts/test-company-name-scoring.js
// (copia fiel: son funciones de la extensión, que no se puede importar desde Node.
//  Si cambias una, cambia la otra.)
import assert from 'node:assert/strict'

const GENERIC_NAME_TOKENS = new Set([
  'internacional', 'international', 'mexico', 'mexicana', 'mexicano', 'latam',
  'grupo', 'group', 'holding', 'holdings', 'company', 'corporativo', 'corporation',
  'servicios', 'services', 'solutions', 'soluciones', 'industrias', 'industries',
  'comercial', 'global', 'sapi', 'srl', 'inc', 'ltd', 'llc', 'sade', 'de', 'cv',
])

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

function coreCompanyName(name) {
  return norm(name).split(/[^a-z0-9]+/).filter(t => t.length > 2 && !GENERIC_NAME_TOKENS.has(t)).join(' ')
}

function nameScore(wantedTokens, title, slug) {
  let score = 0
  for (const t of wantedTokens) {
    if (!title.includes(t) && !slug.includes(t)) continue
    score += GENERIC_NAME_TOKENS.has(t) ? 1 : 10
  }
  return score
}

const tokensOf = (n) => norm(n).split(/[^a-z0-9]+/).filter(t => t.length > 3)

// El caso real que rompió: "durulte alimentos" ganó la búsqueda de "mondelez
// internacional" compartiendo solo la palabra genérica, y con más seguidores.
const t = tokensOf('mondelez internacional')
const mondelez = nameScore(t, 'mondelez internacional comercio al por mayor', 'mondelez-internacional')
const durulte = nameScore(t, 'durulte alimentos fabricacion internacional', 'durulte-alimentos')
assert.ok(mondelez > durulte, 'la página con el nombre real debe ganar')
assert.equal(durulte, 1, 'compartir solo relleno corporativo vale 1')
assert.equal(nameScore(t, 'nada que ver', 'nada'), 0, 'sin tokens comunes → descartable')

// Nombre núcleo: quita el relleno para reintentar la búsqueda.
assert.equal(coreCompanyName('mondelez internacional'), 'mondelez')
assert.equal(coreCompanyName('Grupo Mexico Transportes'), 'transportes')
assert.equal(coreCompanyName('MOLEX'), 'molex')
// Sin relleno, el núcleo es el nombre completo → no se gasta una segunda navegación.
assert.equal(coreCompanyName('Prida Consorcio Aduanal'), 'prida consorcio aduanal')
// Acentos fuera, para que "Mondelēz" y "Mondelez" sean el mismo token.
assert.equal(coreCompanyName('Mondelēz Internacional'), 'mondelez')

// ── Regresión con datos REALES del probe del 3-ago ──────────────────────────
// El texto del ancla trae nombre + rubro + ciudad + descripción comercial. Puntuar sobre
// todo eso le regalaba el match a proveedores que presumen al cliente en su descripción.
const dbl = (t) => {
  const max = Math.floor(t.length / 2)
  for (let k = max; k >= 3; k--) if (t.slice(0, k) === t.slice(k, 2 * k)) return t.slice(0, k).trim()
  return ''
}
const slugWords = (s) => { try { s = decodeURIComponent(s) } catch {} return norm(s.replace(/[-_]+/g, ' ')) }

const reales = [
  { anchor: 'mondelez internacionalmondelez internacionalcomercio al por menorcuritiba, prseguir77 seguidores', slug: 'mondel%C4%93z-internacional', esperado: 11 },
  { anchor: 'durulte alimentos durulte alimentos fabricacion de alimentosmontevideoseguir…multinacionales mondelez', slug: 'durulte-alimentos', esperado: 0 },
  { anchor: 'aviator spainaviator spainimportacion y exportacionbarcelonaseguir…mars, ferrero, mondelez international, henkel', slug: 'aviator-spain', esperado: 0 },
  { anchor: 'branding merchandising branding merchandising publicidadbuenos airesseguir…unilever, mondelez argentina', slug: 'branding-merchandising', esperado: 0 },
]
for (const c of reales) {
  const sw = slugWords(c.slug)
  const nameOnly = dbl(norm(c.anchor)) || sw
  assert.equal(nameScore(t, nameOnly, sw), c.esperado, `${c.slug} debía puntuar ${c.esperado}`)
}
// El nombre filtra; entre las válidas decide el tamaño. Si ordenara por parecido de
// nombre, la duplicada "mondelez internacional" (2 tokens, 77 seguidores) le ganaría
// para siempre a la real "mondelez international" (1 token, 3.4M).
const duplicada = { score: 11, followers: 77 }
const corporativa = { score: 10, followers: 3400000 }
const DISTINCTIVE_HIT = 10
const gana = (a, b) => {
  const va = a.score >= DISTINCTIVE_HIT, vb = b.score >= DISTINCTIVE_HIT
  if (va !== vb) return va
  return a.followers > b.followers
}
assert.ok(gana(corporativa, duplicada), 'la corporativa gana a la duplicada regional')

// Entre páginas del MISMO nombre decide el tamaño (corporativa vs duplicada regional).
const molexTok = tokensOf('MOLEX')
const real = { score: nameScore(molexTok, 'molex fabricacion de productos', 'molex'), followers: 346000 }
const sub = { score: nameScore(molexTok, 'molex india business services', 'molex-india'), followers: 3000 }
assert.equal(real.score, sub.score, 'mismo nombre → empatan en score')
assert.ok(real.followers > sub.followers, 'desempata seguidores')

console.log('✅ nameScore + coreCompanyName OK')
