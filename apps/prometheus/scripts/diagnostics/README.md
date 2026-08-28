# Diagnósticos manuales

**No son self-checks.** No corren en `npm run check` ni en CI, y no deben: necesitan
credenciales, base de datos o servicios vivos, y algunos hablan con LinkedIn.

La distinción es la que fija [ADR-0008](../../../../docs/adr/0008-sin-framework-de-tests.md):

| | `scripts/test-*.js` | `scripts/diagnostics/*.js` |
|---|---|---|
| Herméticos (sin red, sin DB, sin env) | sí | no |
| Encadenados a `npm run check` | **obligatorio** | nunca |
| Corren en CI | sí | no |
| Para qué sirven | congelar una avería real como regresión | investigar en vivo, una vez |

Se separaron el 28-ago-2026: el self-check de integridad los detectó como "existen y no
los corre nadie", que era cierto pero por la razón equivocada — no estaban olvidados, son
de otra especie. `test-fu1-hybrid.js` además importa de `ai.js`, que es código muerto.

Se ejecutan a mano desde `apps/prometheus`, con el `.env` cargado.
