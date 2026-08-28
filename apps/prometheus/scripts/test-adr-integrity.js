// Integridad del sistema de ADRs (28-ago-2026).
//
// Por qué existe: en las 24 h siguientes a crear docs/adr/ se colaron TRES averías de
// este tipo, y ninguna la habría atrapado un humano releyendo:
//   · ADR-0001 citaba `a68dfd3` como el commit que mató el title-only. Ese commit es
//     "feat(cerebro): modo propuesta". Los reales eran 89be071 y ecdad90.
//   · ADR-0001 anunciaba "cuatro reglas" y listaba siete, cinco días sin que nadie lo viera.
//   · Al archivar data-model.md quedó un enlace roto colgando de la skill clawbot-stack.
// Más una superficie nueva: el mapa archivo→ADR del hook puede desincronizarse del índice.
//
// Es ADR-0008 aplicado al propio sistema de ADRs: un self-check por clase de avería, con
// los casos reales. Si el ADR-0008 vale para el código, vale para esto.
//
// ponytail: cero dependencias, cero framework. Falla ruidoso con exit 1.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, resolve, relative } from 'node:path'

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const ADR_DIR = join(ROOT, 'docs/adr')
const HOOK = join(ROOT, '.claude/hooks/protect-stable.sh')
const CLAUDE_MD = join(ROOT, 'CLAUDE.md')

const fails = []
const fail = (donde, msg) => fails.push(`${donde}: ${msg}`)
const read = (p) => readFileSync(p, 'utf8')

const adrFiles = readdirSync(ADR_DIR).filter(f => /^\d{4}-.*\.md$/.test(f)).sort()
if (adrFiles.length === 0) fail('docs/adr', 'no hay ningún ADR — ¿se movió la carpeta?')

// ── 1. Estructura: las 5 secciones de _template.md + metadatos ────────────────────
const SECCIONES = [
  '## El problema, dicho una sola vez',
  '## Decisión',
  '## Caminos descartados',
  '## Consecuencias',
  '## Cómo se aplica',
]
for (const f of adrFiles) {
  const s = read(join(ADR_DIR, f))
  for (const sec of SECCIONES) if (!s.includes(sec)) fail(f, `le falta la sección "${sec}"`)
  if (!/^- \*\*Estado\*\*:/m.test(s))   fail(f, 'sin metadato **Estado**')
  if (!/^- \*\*Gobierna\*\*:/m.test(s)) fail(f, 'sin metadato **Gobierna** (lo usa el hook)')

  // 2. Caminos descartados no puede estar vacío: un ADR sin alternativa rechazada es una nota
  const bloque = s.split('## Caminos descartados')[1]?.split('\n## ')[0] ?? ''
  const filas = (bloque.match(/^\|\s*\*\*/gm) || []).length
  if (filas === 0) fail(f, 'la tabla "Caminos descartados" está vacía — eso no es un ADR')
}

// ── 3. Todo SHA citado existe y es un commit ─────────────────────────────────────
// Solo dentro de backticks, 7-12 o 40 hex en minúscula, y con al menos un dígito
// (si no, palabras como `defaced` —toda hex— darían falso positivo).
const shaRe = /`([0-9a-f]{7,12}|[0-9a-f]{40})`/g
for (const f of [...adrFiles.map(x => join(ADR_DIR, x)), CLAUDE_MD]) {
  const rel = relative(ROOT, f)
  for (const m of read(f).matchAll(shaRe)) {
    const sha = m[1]
    if (!/\d/.test(sha)) continue
    try {
      const tipo = execFileSync('git', ['cat-file', '-t', sha], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (tipo !== 'commit') fail(rel, `\`${sha}\` existe pero es un ${tipo}, no un commit`)
    } catch {
      fail(rel, `\`${sha}\` no existe en la historia — el caso a68dfd3 otra vez`)
    }
  }
}

// ── 4. Enlaces relativos .md que resuelven ───────────────────────────────────────
const linkRe = /\]\(([^)#:]+\.md)(?:#[^)]*)?\)/g
const conEnlaces = [...adrFiles.map(x => join(ADR_DIR, x)), join(ADR_DIR, 'README.md'), CLAUDE_MD,
                    join(ROOT, '.claude/skills/clawbot-stack/SKILL.md'), join(ROOT, '.claude/skills/adr/SKILL.md')]
for (const f of conEnlaces.filter(existsSync)) {
  for (const m of read(f).matchAll(linkRe)) {
    if (m[1].startsWith('/') || m[1].startsWith('http')) continue
    if (!existsSync(resolve(dirname(f), m[1]))) fail(relative(ROOT, f), `enlace roto → ${m[1]}`)
  }
}

// ── 5. Los archivos que un ADR dice gobernar existen de verdad ───────────────────
for (const f of adrFiles) {
  const linea = read(join(ADR_DIR, f)).match(/^- \*\*Gobierna\*\*: (.+)$/m)?.[1] ?? ''
  for (const m of linea.matchAll(/`([^`]+)`/g)) {
    const ruta = m[1]
    if (ruta.includes('*') || !ruta.includes('/')) continue   // globs y prosa: se ignoran
    if (!existsSync(join(ROOT, ruta))) fail(f, `"Gobierna" apunta a ${ruta}, que no existe`)
  }
}

// ── 6. El índice lista exactamente los ADR que hay ──────────────────────────────
const indice = read(join(ADR_DIR, 'README.md'))
for (const f of adrFiles) {
  if (!indice.includes(f)) fail('docs/adr/README.md', `no lista ${f}`)
}
for (const m of indice.matchAll(/\]\((\d{4}-[^)]+\.md)\)/g)) {
  if (!adrFiles.includes(m[1])) fail('docs/adr/README.md', `lista ${m[1]}, que no existe`)
}
for (const f of adrFiles) {                                  // el índice copia el título tal cual
  const real = read(join(ADR_DIR, f)).match(/^# ADR-\d{4} · (.+)$/m)?.[1]
  if (real && !indice.includes(real)) fail('docs/adr/README.md', `el título de ${f} no coincide con el del archivo ("${real}")`)
}

// ── 7. El mapa del hook coincide con los ADR reales ─────────────────────────────
const hook = read(HOOK)
const numsDeADR = new Set(adrFiles.map(f => f.slice(0, 4)))
for (const m of hook.matchAll(/'(\d{4})':\s*'([^']+)'/g)) {          // TITULOS
  const [, num, titulo] = m
  if (!numsDeADR.has(num)) { fail('protect-stable.sh', `TITULOS nombra ADR-${num}, que no existe`); continue }
  const real = read(join(ADR_DIR, adrFiles.find(f => f.startsWith(num))))
    .match(/^# ADR-\d{4} · (.+)$/m)?.[1] ?? ''
  // EXACTO a propósito: el título vive en el H1 del ADR y todo lo demás lo copia.
  // Una comparación laxa deja pasar la deriva, que es justo lo que se quiere cazar.
  if (titulo !== real) fail('protect-stable.sh', `el título de ADR-${num} no coincide con el archivo ("${titulo}" vs "${real}")`)
}
for (const m of hook.matchAll(/'((?:apps|packages)\/[^']+)':\s*\[([^\]]*)\]/g)) {   // PROTECTED
  const [, ruta, lista] = m
  if (!existsSync(join(ROOT, ruta))) fail('protect-stable.sh', `PROTECTED apunta a ${ruta}, que no existe`)
  for (const n of lista.matchAll(/'(\d{4})'/g)) {
    if (!numsDeADR.has(n[1])) fail('protect-stable.sh', `${ruta} dice estar gobernado por ADR-${n[1]}, que no existe`)
  }
}

// ── 8. CLAUDE.md no cita secciones que no existen ───────────────────────────────
const md = read(CLAUDE_MD)
const seccionesReales = new Set([...md.matchAll(/^## (\d+)\./gm)].map(m => m[1]))
for (const m of md.matchAll(/§(\d+)/g)) {
  if (!seccionesReales.has(m[1])) fail('CLAUDE.md', `cita §${m[1]}, que no existe — la truncación del 27-ago otra vez`)
}

// ── 9. Todo self-check está encadenado a `npm run check` ────────────────────────
// ADR-0008 admite este agujero por escrito: "un script que se olvide de encadenar no
// corre nunca y nadie se entera". La cadena se mantiene a mano en package.json, así que
// olvidarse es cuestión de tiempo. Esto lo vuelve ruidoso.
const pkg = JSON.parse(read(join(ROOT, 'apps/prometheus/package.json')))
const cadena = pkg.scripts.check ?? ''
for (const f of readdirSync(join(ROOT, 'apps/prometheus/scripts')).filter(f => /^test-.*\.js$/.test(f))) {
  if (!cadena.includes(f)) fail('package.json', `scripts/${f} existe pero NO está en "npm run check" — no lo corre nadie`)
}

// ── resultado ───────────────────────────────────────────────────────────────────
if (fails.length) {
  console.error('❌ adr-integrity:')
  for (const f of [...new Set(fails)]) console.error('   · ' + f)
  process.exit(1)
}
console.log(`✅ adr-integrity OK (${adrFiles.length} ADR: estructura, SHAs, enlaces, "Gobierna", índice, mapa del hook y §N de CLAUDE.md)`)
