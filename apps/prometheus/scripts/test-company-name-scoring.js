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

// Entre páginas del MISMO nombre decide el tamaño (corporativa vs duplicada regional).
const molexTok = tokensOf('MOLEX')
const real = { score: nameScore(molexTok, 'molex fabricacion de productos', 'molex'), followers: 346000 }
const sub = { score: nameScore(molexTok, 'molex india business services', 'molex-india'), followers: 3000 }
assert.equal(real.score, sub.score, 'mismo nombre → empatan en score')
assert.ok(real.followers > sub.followers, 'desempata seguidores')

console.log('✅ nameScore + coreCompanyName OK')
