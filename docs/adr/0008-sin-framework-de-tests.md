# ADR-0008 · Sin framework de tests: seatbelt nativo y un self-check por incidente

- **Estado**: aceptado (6-jul-2026)
- **Contexto que lo detona**: el plan de resiliencia (FODA, acción C1) pedía una red mínima contra una clase de regresión concreta — matching de whitelist, gating de persona, guard de placeholders, comparación semver — sin montar infraestructura de testing.
- **Gobierna**: `apps/prometheus/package.json`, `apps/prometheus/scripts/test-*.js`, `apps/prometheus/test/*.test.mjs`, `.github/workflows/checks.yml`

## El problema, dicho una sola vez

Casi nada de este sistema es testeable de la forma habitual: el 80% del comportamiento vive en el DOM de LinkedIn, que cambia sin avisar y no se puede montar en un test. Un framework de testing daría cobertura de lo que **no** se rompe, y cero de lo que sí.

Lo que sí se rompe, y se rompió, son funciones puras con reglas sutiles: `every` contra `some` al comparar nombres de empresa, un guard que corre antes de truncar en vez de después, un comparador de versiones que trata `0.10.9` como mayor que `0.10.31`.

## Decisión

**Dos capas, ninguna con framework.**

### 1. Seatbelt — `npm test`

`node --test` sobre `test/*.test.mjs`. Funciones **puras** críticas. Sin Jest, sin Vitest, sin mocks, sin configuración. El runner viene con Node.

### 2. Un self-check por incidente — `npm run check`

Cada avería que llega a producción deja un `scripts/test-NOMBRE.js` con **los datos reales que la causaron**, y se encadena a `npm run check`. Hoy son 18 eslabones.

Que lleven los casos reales es la parte que importa. `scripts/test-reply-guards.js` contiene los cuatro textos que de verdad recibieron cuatro leads el 24-ago. `scripts/test-company-match.js` lleva el par "ISUZU Motors" / "General Motors". No son casos inventados para ejercitar una rama: son la avería, congelada.

**Esto es una obligación de proceso, no una herramienta**: lógica nueva no trivial se acompaña de su self-check. Es la única red que hay.

### 3. Los self-checks son herméticos; lo que necesita credenciales es un diagnóstico

`scripts/test-*.js` no toca red, ni base de datos, ni `.env` — por eso puede correr en CI
sin secretos. Lo que sí los necesita vive en `scripts/diagnostics/`, se ejecuta a mano y
**nunca** se encadena. Mezclarlos rompe la cadena entera por un fallo de entorno.

### 4. La cadena la ejecuta el CI, no la memoria de nadie

`.github/workflows/checks.yml` corre `npm run check` y `npm test` en cada push a `main` y
en cada PR. Se eligió Actions y no un hook `pre-push` porque un hook se salta con
`--no-verify` y no cubre a los agentes que trabajan desde otras máquinas.

### 5. El sistema de verificación se verifica a sí mismo

`scripts/test-adr-integrity.js` comprueba lo que un humano releyendo no ve: que los SHA
citados en los ADR existan, que los enlaces resuelvan, que los archivos de `Gobierna` sigan
ahí, que el mapa del hook coincida con el índice, que `CLAUDE.md` no cite secciones
inexistentes, y que **todo `scripts/test-*.js` esté encadenado**. Nació de tres averías
reales en las primeras 24 h del sistema de ADRs.

## Caminos descartados — no reintroducir

| Camino | Por qué se descartó | Dónde murió |
|---|---|---|
| **Jest / Vitest** | Configuración, mocks y dependencias para cubrir funciones puras que `node --test` cubre con cero setup. Y no alcanzan lo que de verdad se rompe, que es el DOM ajeno | `3123f58` (6-jul) |
| **Tests de integración contra LinkedIn** | No hay entorno de pruebas. Correrlos con cuentas reales gasta cuota y arriesga baneo | 6-jul |
| **Cobertura como métrica** | Empuja a testear lo fácil. Aquí lo caro son ~15 reglas sutiles, no el porcentaje de líneas | 6-jul |
| **Reescribir los self-checks bajo un framework "para ordenarlos"** | Trabajo puro sin lector, y se pierden los datos reales incrustados en cada uno | — (no hacer) |
| **Hook `pre-push` en vez de CI** | Se salta con `--no-verify` y no cubre a los agentes que trabajan desde otras máquinas o en la nube | 28-ago-2026 |
| **Encadenar los diagnósticos a `npm run check`** | Necesitan credenciales y servicios vivos: un fallo de entorno tumbaría la cadena entera | 28-ago-2026 |

## Consecuencias

**A favor**: cero dependencias de testing. `npm run check` corre en segundos y cada eslabón documenta una avería real — se lee como un historial de incidentes ejecutable.

**En contra**: la cadena de `npm run check` **se mantiene a mano** en `package.json` y crece por acumulación sin que nadie la pode. El día que estorbe, la respuesta es un glob, no un framework.

El resto de esta objeción está cerrado (28-ago-2026). Decía *"un script que se olvide de
encadenar no corre nunca y nadie se entera"*, y era cierto: al automatizarlo aparecieron
**seis** scripts fuera de la cadena. No estaban olvidados — eran de otra especie, y ahora
viven en `scripts/diagnostics/`. Y la objeción de fondo era peor: **nada ejecutaba la
cadena**. Ni CI ni hooks; dependía de que alguien se acordara.

## Cómo se aplica

1. ¿Escribiste una función pura con una regla sutil (comparación, normalización, guard, orden)? Deja su self-check.
2. ¿Un bug llegó a producción? El fix incluye el caso real en un `scripts/test-*.js`, con los datos que lo causaron. No una versión simplificada.
3. **Encadénalo en `npm run check`.** Un script que no está en la cadena no existe — y desde el 28-ago-2026 el self-check de integridad falla si te lo saltas.
4. ¿Necesita `.env`, DB o red? Entonces no es un self-check: va a `scripts/diagnostics/`.
5. Antes de dar por bueno un cambio en `apps/prometheus`: `npm run check -w apps/prometheus`.

Relacionado: [ADR-0001](0001-degradacion-silenciosa.md) (§5, verificar contra los datos que dominan producción)
