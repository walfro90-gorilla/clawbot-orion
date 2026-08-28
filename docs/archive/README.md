# Archivo histórico

Documentos **correctos en su fecha y falsos hoy**. Describen arquitectura que ya no
existe (Playwright headless, Voyager/`inbox.js`, `worker.js` como proceso vivo) o planes
que terminaron hace meses.

**No los uses como referencia de cómo funciona el sistema.** Están aquí porque explican
de dónde vienen decisiones que hoy siguen vigentes, no porque describan el presente.

Cada archivo abre con una cabecera que dice qué fecha describe y qué lo reemplazó.

| Archivo | Describe | Hoy lo cubre |
|---|---|---|
| [`blueprint.md`](blueprint.md) | Arquitectura Playwright + Voyager (abr-2026) | `CLAUDE.md` §2, [ADR-0002](../adr/0002-ejecutar-en-la-sesion-del-usuario.md) |
| [`ANTI_DETECTION_BLUEPRINT.md`](ANTI_DETECTION_BLUEPRINT.md) | Capa de stealth del servidor: `lib/humanize.js`, `lib/browser.js`, proxies (may-2026) | [ADR-0002](../adr/0002-ejecutar-en-la-sesion-del-usuario.md) — esa capa dejó de ejecutarse |
| [`PLAN_UPDATE.md`](PLAN_UPDATE.md) | Plan de migración a Smart Hybrid (may-2026). Fases 1 y 2 ejecutadas, la 3 nunca | [ADR-0002](../adr/0002-ejecutar-en-la-sesion-del-usuario.md) — sus alternativas rechazadas están ahí |
| [`fix-typing-throttle.md`](fix-typing-throttle.md) | Propuesta contra el throttling de pestañas en segundo plano (jun-2026), nunca aplicada | Superada dos veces: ext 0.9.1 y 0.10.11, que apagó el focus-hack por innecesario |
| [`RESUMEN_REFACTOR_AGENTES.md`](RESUMEN_REFACTOR_AGENTES.md) | Reporte de un sprint de hard-testing, ext v0.7.28→0.7.42 (jun-2026) | `docs/EVOLUTION.md`, `docs/followups-flujo.md` |
| [`data-model.md`](data-model.md) | Modelo de datos de la skill `clawbot-stack` (jun-2026), sin las tres tablas centrales de hoy | `CLAUDE.md` §5 |

## Regla

**No se editan.** Un documento archivado es un registro con fecha; si su contenido vuelve
a hacer falta, se escribe de nuevo donde corresponda (`CLAUDE.md`, `docs/adr/`, un doc de
flujo) en vez de resucitar este.
