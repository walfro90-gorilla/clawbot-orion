// Self-check de scoreLead (lib/lead-score.js) — el número con el que el picker decide en
// qué se gastan las ~25 invitaciones diarias.
// Correr: node apps/prometheus/scripts/test-lead-score.js
// (env dummy: lead-score importa extension-dispatch → lib/supabase.js, que exige las
//  vars. No se abre ninguna conexión — solo se evalúan strings.)
process.env.SUPABASE_URL ||= 'http://localhost:54321'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'dummy-key-for-test'

import assert from 'node:assert/strict'
const { scoreLead, scoreLeadRow, WEIGHTS } = await import('../lib/lead-score.js')

const s = (o) => scoreLead(o).score
const r = (o) => scoreLead(o).reasons

// ── El score mide CALIDAD DEL PERFIL, no pertenencia a la lista ─────────────
// `fromList` sigue siendo la llave primaria del picker y NO entra al número. Si entrara,
// un CEO de fuera le ganaría a un coordinador de la lista y se rompería la garantía del
// flujo company-scoped congelado ("primero los de la lista"). Este test lo fija.
assert.equal(s({ headline: 'Director General' }), scoreLead({ headline: 'Director General' }).score)
assert.ok(!('fromList' in r({ headline: 'Director General' })),
  'el score NO conoce fromList — eso vive en el picker')

// ── Preserva el desempate por responsabilidad ──────────────────────────────
assert.ok(s({ headline: 'CEO & Founder' })      > s({ headline: 'Director General' }))
assert.ok(s({ headline: 'Director General' })   > s({ headline: 'Director de Compras' }))
assert.ok(s({ headline: 'Director de Compras' }) > s({ headline: 'Gerente de Compras' }))
assert.ok(s({ headline: 'Gerente de Compras' }) > s({ headline: 'Coordinador de Embarques' }))
assert.ok(s({ headline: 'Coordinador de Embarques' }) > s({ headline: 'Estudiante' }))

// ── El caso Infinity: el preferido ORDENA, no MATA ──────────────────────────
// "Gerente Nacional de Operaciones Mazda Mexico" caía con la whitelist vieja porque pedía
// "director de operaciones" literal (20 de 225 leads pasaban, 9%). Como término PREFERIDO
// suma y el lead sobrevive.
const mazda = 'Gerente Nacional de Operaciones Mazda Mexico'
assert.ok(s({ headline: mazda, preferred: ['operaciones'] }) > s({ headline: mazda, preferred: [] }),
  'un término preferido sube el score')
assert.ok(s({ headline: mazda, preferred: ['nada-que-ver'] }) > 0,
  'NO cazar un preferido nunca deja el lead en cero — no rechaza')
assert.equal(r({ headline: mazda, preferred: ['operaciones', 'compras'] }).preferred.length, 1,
  'solo cuenta los que de verdad cazan')
// El preferido no sustituye a la jerarquía: un director sin preferido sigue arriba de un
// coordinador con preferido (75 vs 15+15). Es lo que queremos: la whitelist blanda inclina,
// no manda.
assert.ok(s({ headline: 'Director de Compras' }) >
          s({ headline: 'Coordinador de Compras', preferred: ['compras'] }),
  'el preferido inclina, no manda sobre la responsabilidad')

// Substring e insensible a acentos, igual que passesTitleFilters.
assert.deepEqual(r({ headline: 'Director de Logística', preferred: ['logistica'] }).preferred, ['logistica'],
  'acentos: "logistica" caza "Logística"')
assert.deepEqual(r({ headline: 'Directores de Compras', preferred: ['director'] }).preferred, ['director'],
  'substring: "director" caza "Directores"')

// ── Headline vacío: cae al final, NO se mata ───────────────────────────────
// ~33-44% de los perfiles de Café 57 salen sin headline (bug del scraper, abierto). Con
// score 0 caen al desempate FIFO — exactamente lo que ya les pasaba con seniorityRank 0.
// Que NO se descarten es lo que impide que esa campaña se quede sin invitar a nadie.
assert.equal(s({ headline: '', companyIsCertain: true }), WEIGHTS.companyCertain,
  'sin headline pero con empresa confirmada, sigue puntuando')
assert.equal(r({ headline: '' }).hasHeadline, false)
assert.equal(r({ headline: '   ' }).hasHeadline, false, 'solo espacios cuenta como vacío')
assert.deepEqual(r({ headline: '', preferred: ['director'] }).preferred, [],
  'sin headline no se inventa un match de preferido')

// ── El facet vale más que el texto libre ───────────────────────────────────
// companyIsCertain solo es true con facet currentCompany: LinkedIn garantiza la empresa.
// En modo degradado (sin URN) el nombre viaja como texto y 46 de 104 leads de Infinity
// trabajaban en otra empresa — ese lead vale menos aunque el headline sea idéntico.
assert.ok(
  s({ headline: 'Director de Compras', companyIsCertain: true }) >
  s({ headline: 'Director de Compras', companyIsCertain: false }),
  'empresa confirmada por facet vale más que empresa inferida')

// ── Límites de la escala ───────────────────────────────────────────────────
assert.equal(s({ headline: 'CEO & Founder', companyIsCertain: true, preferred: ['ceo'] }), 100,
  'el techo es exactamente 100')
assert.equal(s({}), 0, 'sin ninguna señal, 0')
assert.equal(s({ headline: 'Estudiante' }), 0, 'headline sin jerarquía ni preferido: 0')

// ── scoreLeadRow: la red del picker para leads sin score persistido ────────
// Los 2.504 leads previos a esta feature tienen lead_score NULL. Sin esto el picker los
// mandaría al fondo para siempre y las campañas viejas dejarían de invitar.
assert.equal(
  scoreLeadRow({ profile_data: { headline: 'Director General' } }).score,
  s({ headline: 'Director General' }),
  'scoreLeadRow y scoreLead coinciden')
assert.equal(
  scoreLeadRow({ profile_data: { headline: 'Director', targetCompany: 'ISUZU', currentCompany: 'ISUZU' } }).reasons.companyCertain,
  true, 'currentCompany === targetCompany ⇒ vino del facet')
assert.equal(
  scoreLeadRow({ profile_data: { headline: 'Director', targetCompany: 'ISUZU', currentCompany: 'Otra SA' } }).reasons.companyCertain,
  false, 'currentCompany distinto (lo dedujo el LLM del headline) NO es evidencia de facet')
assert.equal(
  scoreLeadRow({ profile_data: { headline: 'Director', targetCompany: 'ISUZU', currentCompany: '' } }).reasons.companyCertain,
  false, "el centinela '' (revisado, sin empresa) no es evidencia")
assert.equal(scoreLeadRow({}).score, 0, 'fila sin profile_data no revienta')
assert.equal(scoreLeadRow(null).score, 0, 'fila null no revienta')
assert.deepEqual(
  scoreLeadRow({ profile_data: { headline: 'Gerente de Aduanas' } }, ['aduana']).reasons.preferred,
  ['aduana'], 'scoreLeadRow pasa el preferido')

console.log('✅ lead-score OK (mide calidad, no lista; el preferido inclina y no mata; sin headline cae al FIFO sin descartarse)')
process.exit(0)  // lib/supabase.js deja handles vivos → sin esto el test no termina
