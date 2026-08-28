# Decisiones de arquitectura (ADR)

Por qué el sistema es como es. **Cada archivo de aquí registra una decisión que ya se
pagó en producción** — casi todas nacieron de un incidente con daño medido.

Un ADR no describe cómo funciona algo (para eso está `CLAUDE.md` y los docs de flujo).
Registra **qué se eligió, qué se descartó y qué pasó cuando se intentó lo contrario.**

> **Cómo leerlos**: la sección que más vale es siempre `Caminos descartados — no
> reintroducir`. Si vas a "arreglar" algo que parece a medio hacer, búscalo ahí primero.
> Varias de estas decisiones **parecen bugs desde fuera**, y esa es justo la razón de que
> estén escritas.

## Índice

| ADR | Decisión | Estado | Gobierna |
|---|---|---|---|
| [0001](0001-degradacion-silenciosa.md) | Nada degrada en silencio | aceptado 22-ago-2026 | `lib/ai-message.js`, `content.js`, todo camino a LinkedIn |
| [0002](0002-ejecutar-en-la-sesion-del-usuario.md) | Las acciones de LinkedIn se ejecutan en la sesión y la IP del usuario | aceptado jun-2026 | `orion-extension/*`, `scheduler-extension.js`, `extension-bridge.js` |
| [0003](0003-nunca-title-only-en-company-scoped.md) | En modo empresa nunca se busca por título suelto | aceptado 10-ago-2026 | `scheduler-extension.js`, `lib/extension-dispatch.js` |
| [0004](0004-accepts-por-presencia.md) | Una conexión se confirma por presencia, nunca por ausencia | aceptado 15-ago-2026 | `extension-bridge.js` |
| [0005](0005-escalera-de-severidad-del-lead.md) | Matar un lead para siempre solo si el contacto nos eliminó | aceptado 4-jul-2026 | `extension-bridge.js` |
| [0006](0006-verificar-en-el-ingest.md) | La empresa y la geografía se verifican al ingerir, no en la URL de búsqueda | aceptado 11-ago-2026 | `extension-bridge.js`, `lib/company-match.js` |
| [0007](0007-el-picker-ordena-no-filtra.md) | El picker de invitaciones ordena; filtrar es otra cosa | aceptado 26-ago-2026 | `lib/lead-score.js`, `scheduler-extension.js` |
| [0008](0008-sin-framework-de-tests.md) | Sin framework de tests: seatbelt nativo y un self-check por incidente | aceptado 6-jul-2026 | `package.json`, `scripts/test-*.js`, `test/*.test.mjs` |

## Cuándo se escribe uno

Cuando un cambio **introduce una dependencia externa**, **cambia la topología de
despliegue**, o **toma una decisión cara de revertir**.

No califica: un bug arreglado, un parámetro afinado, una lección operativa, un incidente.
Eso va a `docs/bitacora-operativa.md` o `docs/EVOLUTION.md`.

La prueba rápida: **si no puedes nombrar la alternativa que se rechazó, no es un ADR.**

Para escribir uno: la skill `adr` (`.claude/skills/adr/`) aplica `_template.md`, asigna el
número siguiente y actualiza este índice.

## Reglas de mantenimiento

- **Un ADR nunca se borra ni se reescribe.** Si deja de valer, se marca
  `supersedido por ADR-NNNN` y el nuevo explica qué cambió. Este proyecto revierte
  decisiones — el 0004 se revirtió *de facto* dos veces — y el historial es el producto.
- **Todo SHA se verifica** con `git log -1 <sha>` antes de escribirlo. El 0001 llegó a
  citar `a68dfd3` para la muerte del title-only; ese commit es *"feat(cerebro): modo
  propuesta"*. Los reales eran `89be071` y `ecdad90`.
- **`Gobierna` no es decorativo**: `.claude/hooks/protect-stable.sh` lo usa para nombrar
  el ADR correcto cuando alguien va a editar uno de esos archivos.

## Candidatos sin escribir

Decisiones reales que aún viven solo como prosa en `CLAUDE.md`. Se escriben cuando alguien
las toque, no antes — el back-fill masivo es donde estos sistemas mueren:

- **El FU verbatim no pasa por el LLM**, y el guard anti-meta no se le aplica a propósito
  (un template corto legítimo quedaría bloqueado en silencio).
- **SalesNav es solo búsqueda**; el invite va por el perfil público `/in/`, y el muro de
  email no se rellena — se aborta.
- **El flujo company-scoped está congelado** detrás de un hook de confirmación.
- **El pase de retiro de invitaciones está deshabilitado** con gate de versión `9.9.9`
  tras 16 runs fallidos: LinkedIn exige `isTrusted` en todas las superficies.
