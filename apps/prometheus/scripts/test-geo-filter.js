// Self-check de matchesCampaignGeo (extension-bridge.js) — el filtro que descarta al ingest
// los leads fuera del país de la campaña (multinacionales de la lista surfacean extranjeros).
// Correr: node apps/prometheus/scripts/test-geo-filter.js
// (copia fiel: extension-bridge.js importa lib/supabase.js que exige env; se replica la
//  función pura aquí para no arrastrar esa dependencia a un test de strings.)
import assert from 'node:assert/strict'

const _stripGeo = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
const COUNTRY_CANON = {
  'estados unidos':'us','united states':'us','usa':'us',
  'republica dominicana':'do','costa rica':'cr','el salvador':'sv','puerto rico':'pr',
  'paises bajos':'nl','holanda':'nl','netherlands':'nl',
  'reino unido':'uk','inglaterra':'uk','united kingdom':'uk','gran bretana':'uk',
  'arabia saudita':'sa','emiratos arabes':'ae','nueva zelanda':'nz','corea del sur':'kr','corea':'kr',
  'mexico':'mx','colombia':'co','espana':'es','spain':'es','chile':'cl','peru':'pe','panama':'pa',
  'argentina':'ar','uruguay':'uy','paraguay':'py','bolivia':'bo','ecuador':'ec','venezuela':'ve',
  'guatemala':'gt','honduras':'hn','nicaragua':'ni','cuba':'cu',
  'brasil':'br','brazil':'br','canada':'ca','alemania':'de','germany':'de','francia':'fr','france':'fr',
  'italia':'it','italy':'it','portugal':'pt','irlanda':'ie','belgica':'be','suiza':'ch','switzerland':'ch',
  'austria':'at','polonia':'pl','suecia':'se','noruega':'no','dinamarca':'dk','finlandia':'fi',
  'rusia':'ru','turquia':'tr','india':'in','china':'cn','japon':'jp','singapur':'sg','israel':'il',
  'australia':'au','sudafrica':'za','egipto':'eg','nigeria':'ng','marruecos':'ma',
}
const COUNTRY_KEYS = Object.keys(COUNTRY_CANON).sort((a, b) => b.length - a.length)
function matchesCampaignGeo(profileLoc, geoRaw) {
  const geoCanon = new Set(String(geoRaw ?? '').split(',').map(s => COUNTRY_CANON[_stripGeo(s)]).filter(Boolean))
  if (geoCanon.size === 0) return true
  const loc = _stripGeo(profileLoc)
  if (!loc) return true
  const mentioned = COUNTRY_KEYS.filter(k => loc.includes(k)).map(k => COUNTRY_CANON[k])
  if (mentioned.length === 0) return true
  return mentioned.some(c => geoCanon.has(c))
}

const CAFE_GEO = 'Mexico, Estados Unidos'

// Los leads REALES que se colaron a Café (deben DESCARTARSE):
assert.equal(matchesCampaignGeo('Sao Paulo, San Pablo, Brasil', CAFE_GEO), false)
assert.equal(matchesCampaignGeo('Bengaluru, Karnataka, India', CAFE_GEO), false)
assert.equal(matchesCampaignGeo('Bremerhaven, Brema, Alemania', CAFE_GEO), false)
assert.equal(matchesCampaignGeo('Weggis, Lucerna, Suiza', CAFE_GEO), false)
assert.equal(matchesCampaignGeo('Chile', CAFE_GEO), false)

// Los válidos de Café (deben CONSERVARSE):
assert.equal(matchesCampaignGeo('Área metropolitana de Ciudad de México', CAFE_GEO), true)
assert.equal(matchesCampaignGeo('San Pedro Garza García, Nuevo León, México', CAFE_GEO), true)
assert.equal(matchesCampaignGeo('Laredo, Texas, Estados Unidos', CAFE_GEO), true)
assert.equal(matchesCampaignGeo('Monterrey, Nuevo León, México', CAFE_GEO), true)

// Beneficio de la duda: ubicación vacía o desconocida → se conserva (el facet ya garantiza
// la empresa; no perdemos leads por dato faltante).
assert.equal(matchesCampaignGeo('', CAFE_GEO), true)
assert.equal(matchesCampaignGeo(null, CAFE_GEO), true)

// CLAVE (bug del cleanup naive): ciudad/región mexicana SIN el país en la cadena → CONSERVAR
// (no nombra ningún país conocido → beneficio de la duda, no asumir extranjero).
assert.equal(matchesCampaignGeo('Área metropolitana de San Luis Potosí', CAFE_GEO), true)
assert.equal(matchesCampaignGeo('Guadalajara y alrededores', CAFE_GEO), true)
assert.equal(matchesCampaignGeo('Monterrey, Nuevo León', CAFE_GEO), true)
// pero si nombra explícitamente un país extranjero → descartar aunque tenga ciudad
assert.equal(matchesCampaignGeo('Área metropolitana de Bogotá, Colombia', CAFE_GEO), false)

// Sin geo configurada → no filtra (campaña sin país objetivo).
assert.equal(matchesCampaignGeo('Sao Paulo, Brasil', ''), true)

// Alias en/es: un perfil en inglés no debe escaparse.
assert.equal(matchesCampaignGeo('Dallas, Texas, United States', CAFE_GEO), true)

// Geo LATAM de Josh: conserva su región, descarta fuera.
const JOSH_GEO = 'Mexico, Colombia, España, Chile, Perú, Panamá, Argentina, Costa Rica, Uruguay, Paraguay, El Salvador, Bolivia'
assert.equal(matchesCampaignGeo('Bogotá, Colombia', JOSH_GEO), true)
assert.equal(matchesCampaignGeo('Madrid, España', JOSH_GEO), true)
assert.equal(matchesCampaignGeo('Hyderabad, Telangana, India', JOSH_GEO), false)
assert.equal(matchesCampaignGeo('Amsterdam, Países Bajos', JOSH_GEO), false)

console.log('✅ matchesCampaignGeo OK')
