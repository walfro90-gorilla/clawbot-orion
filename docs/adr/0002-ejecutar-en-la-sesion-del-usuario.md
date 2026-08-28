# ADR-0002 · Las acciones de LinkedIn se ejecutan en la sesión y la IP del usuario

- **Estado**: aceptado (jun-2026, "Smart Hybrid")
- **Contexto que lo detona**: la era Playwright terminó en baneos. El login operaba desde una IP de datacenter distinta a la del dueño de la cuenta y LinkedIn lo marcaba al instante.
- **Gobierna**: `apps/orion-extension/*`, `apps/prometheus/scheduler-extension.js`, `apps/prometheus/extension-bridge.js`

## El problema, dicho una sola vez

La forma obvia de automatizar LinkedIn es un servidor con Chrome headless: Playwright, un plugin de stealth, un proxy residencial. Se construyó. Se baneó.

La causa no es el stealth ni el fingerprint — es **geográfica y estructural**. La sesión de un usuario que vive en Guadalajara y siempre entra desde su casa aparece de golpe operando desde un datacenter en otro país. Ninguna cantidad de `puppeteer-extra-plugin-stealth` arregla que la IP no sea la suya.

## Decisión

**Prometheus nunca toca LinkedIn. Solo orquesta.**

La extensión Chrome MV3 ejecuta cada acción dentro del navegador real del usuario, con su sesión y su IP. El servidor inserta filas en `extension_commands` y un bridge WebSocket las despacha. El resultado vuelve por el mismo canal.

De ahí salen dos corolarios que **también** son la decisión, no detalles:

### 1. El VPS orquesta; jamás abre LinkedIn

Meter una cuenta en un Chrome del VPS reproduce exactamente el patrón que baneó la era anterior. Cuando una cuenta necesita estar disponible más horas, la respuesta es **una máquina dedicada en la misma red del usuario**, no moverla al servidor.

### 2. Un solo host por cuenta

Dos navegadores con la extensión y la misma cuenta = comandos duplicados y carreras. La cuenta vive en un host y solo uno.

## Caminos descartados — no reintroducir

| Camino | Por qué se descartó | Dónde murió |
|---|---|---|
| **Chrome headless + Playwright + stealth en el servidor** | Baneo. IP de datacenter ≠ IP del usuario; el stealth no cambia eso | era 1, ~jun-2026 |
| **Proxy residencial para disfrazar la IP del servidor** | Trata el síntoma. La sesión sigue viajando desde una red que no es la del usuario, y añade una dependencia de pago que falla sola | era 1 |
| **Mover una cuenta al Chrome del VPS cuando necesita más horas activa** | Es literalmente el patrón baneado, con otro nombre | ago-2026 (caso Wal) |
| **La misma cuenta en dos hosts a la vez** | Comandos duplicados, `duplicate_connection_race` | ago-2026 |
| **Sesión partida (servidor con cookie A, extensión con cookie B)** | LinkedIn detecta "misma cuenta, dos dispositivos simultáneos" y mata la sesión. Las herramientas que lo intentaron reportaron 3-5× más baneos | `PLAN_UPDATE.md`, may-2026 |
| **Navegadores anti-detect (Multilogin, GoLogin, Dolphin Anty)** | Diseñados para gestionar 100+ identidades. Para 2-3 cuentas es coste y complejidad sin retorno | may-2026 |
| **Cambiar de proveedor de scraping (Apify, Bright Data)** | Es el mismo patrón headless en la nube con otro nombre. El problema era arquitectónico, no de proveedor | may-2026 |
| **Seguir parcheando el comportamiento sin tocar la arquitectura** | 5 baneos en 2 semanas demostraron que el patrón ya estaba detectado. Más parches de humanización eran tirar piedras al mar | may-2026 |

**Una nota honesta sobre la extensión pura.** En may-2026 se evaluó y se rechazó ir a
**solo extensión, sin servidor**: perdía el 24/7 set-and-forget, porque obligaba al usuario
a tener Chrome abierto siempre. La arquitectura que quedó conserva el servidor para
orquestar, pero **no evitó ese coste**: la extensión sigue necesitando Chrome vivo. O sea,
la objeción era correcta y hoy se paga igual — está en las consecuencias de abajo. Lo que
el servidor sí salvó fue la planificación, los reintentos y la telemetría.

## Consecuencias

**A favor**: es el foso del producto. Las acciones son indistinguibles de las del usuario porque *son* las del usuario. Ningún competidor que corra headless puede igualar eso sin rehacer su arquitectura.

**En contra**: el sistema depende de una máquina ajena encendida, con Chrome abierto y la pestaña viva. Si el operador cierra el portátil, esa cuenta no trabaja — y no hay nada que el servidor pueda hacer. Se paga también en despliegue: actualizar la extensión exige que cada operador corra el instalador; `git push` no la actualiza.

## Cómo se aplica

⚠️ **La evidencia física del repo contradice este ADR.** Antes de "arreglar" nada de lo que sigue, léelo dos veces:

- `apps/prometheus/package.json` declara `"main": "worker.js"` y `"start": "node worker.js"`.
- `playwright`, `playwright-extra` y `puppeteer-extra-plugin-stealth` siguen como dependencias.
- `worker.js`, `batch.js`, `search.js`, `scheduler.js`, `inbox.js`, `followup.js` y `ai.js` siguen en disco.

**Todo eso es arquitectura muerta.** El proceso real es `scheduler-extension.js`. Se conserva por historia, no por uso. Quien lo tome por la arquitectura viva y lo "restaure" reintroduce el baneo que costó una era entera.

1. ¿La acción habla con LinkedIn? Entonces va en la extensión, no en el servidor.
2. ¿Estás a punto de levantar un navegador en el VPS? No.
3. ¿La cuenta necesita más disponibilidad? Máquina dedicada en su red, no en el datacenter.

Relacionado: `docs/EVOLUTION.md` (eras 1 y 2), [ADR-0001](0001-degradacion-silenciosa.md)
