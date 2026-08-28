---
name: clawbot-stack
description: Contexto de arquitectura REAL del monorepo ClawBot (Prometheus + Orion + extensión Chrome). Úsala al trabajar en este repo para saber qué corre de verdad en producción, qué archivos están vivos vs muertos, el stack por app, y las trampas conocidas. Auto-invocar en cualquier tarea de código dentro de /root/clawbot.
---

📦 **Al activarte:** empieza tu respuesta con `📦 clawbot-stack` para avisar al usuario que esta skill está cargada.

# ClawBot — arquitectura real (ground truth)

> ⚠️ **Este resumen se verificó en jun-2026 y ha quedado atrás en varios puntos** (versión de
> extensión, proveedor LLM, tablas del modelo de datos). **`CLAUDE.md` y `docs/adr/` mandan
> sobre esta skill**; úsala como mapa rápido, no como ground truth. Si algo de aquí contradice
> al `CLAUDE.md`, gana el `CLAUDE.md`; si contradice al código, gana el código.
>
> Las decisiones de arquitectura —y qué se rompió al intentar lo contrario— están en
> [`docs/adr/README.md`](../../../docs/adr/README.md).

## Qué corre de verdad (verificado 2026-06-10)
Código vivo = `/root/clawbot` (este repo git). **PM2 corre 4 procesos**, todos desde aquí:
- `orion` → `npm start`, Next.js en `:3000` (`apps/orion`)
- `prometheus-scheduler` → **`scheduler-extension.js`** (NO `scheduler.js`), `apps/prometheus`
- `extension-bridge` → `extension-bridge.js` (bridge WebSocket a la extensión Chrome)
- `xvfb` → display virtual para el Chrome con la extensión

Arquitectura vigente = **Smart Hybrid v0.7.47**: extensión Chrome MV3 (`apps/orion-extension`) + bridge WS + FSM en `content.js` + auto-learning. La acción de LinkedIn corre desde la IP/sesión del usuario vía su Chrome.

**Arquitectura MUERTA (en disco pero ningún proceso PM2 la carga):** `worker.js`, `batch.js`, `inbox.js`, `scheduler.js`, `search.js` (Playwright + Voyager GraphQL). No la uses como referencia de cómo funciona hoy.

## Stack por app
- **orion** (`apps/orion`): Next.js 16.2.3 (App Router), React 19, TypeScript 5, Tailwind 4, `@supabase/ssr` + `@supabase/supabase-js`, `@google/genai` (Gemini). → skills [nextjs-react-pro], [typescript-pro], [postgres-supabase-pro].
- **prometheus** (`apps/prometheus`): Node.js ESM, Express 5, WebSocket bridge, Supabase, `@google/genai`. (Playwright/stealth siguen como deps pero son de la arch muerta.) → skills [nodejs-pro], [postgres-supabase-pro].
- **orion-extension** (`apps/orion-extension`): Chrome Extension Manifest V3, service worker módulo, content scripts en LinkedIn. → skill [chrome-extension-pro].
- **packages/db-types**: tipos generados de Supabase (`supabase gen types typescript` → `database.types.ts`). → skill [postgres-supabase-pro].

## Trampas conocidas
1. **`ecosystem.config.cjs` desincronizado** — solo define `orion` + `prometheus-scheduler` (apuntando al viejo `scheduler.js`); NO incluye `extension-bridge` ni `xvfb`. Recuperación real tras reboot = `pm2 resurrect` (depende de `pm2 save`), no el ecosystem.
2. **CLAUDE.md viejo** (~abril): Voyager/inbox.js/worker.js y "Next 14". Realidad = Smart Hybrid + Next 16.
3. **Código de prod SIN commitear** — la versión que CORRE es working-tree no commiteado (v0.7.43–v0.7.47). No hay restore point limpio; commitear es prioridad.
4. **Extensión Chrome**: fixes no aplican hasta **recargar la extensión** en cada cuenta (Wal + Josh).
5. `apps/prometheus/_ten2.mjs` es un scratch de diagnóstico sin trackear.

## Memoria del proyecto
- Memoria de runtime/trampas: `/root/.claude/projects/-root-clawbot/memory/` (deployment-topology, legacy-memory-location).
- **Memoria histórica rica** (53 archivos, troubleshooting P1–P12, releases): vive bajo `/root/.claude/projects/-root-prometheus-worker/memory/` y **NO** auto-carga desde aquí. Si necesitas historia del proyecto, léela manualmente empezando por su `MEMORY.md`.

## Recursos adicionales (leer bajo demanda)
- Comandos operativos completos (PM2/resurrect, rebuild, types, env, reload extensión) → [commands-cheatsheet.md](commands-cheatsheet.md).
- Modelo de datos: tablas, CHECK constraints reales, flujo de estados, tipos generados → [data-model.md](data-model.md).

## Comandos rápidos
- Rebuild Orion: `cd /root/clawbot/apps/orion && npm run build && pm2 restart orion`
- Logs: `pm2 logs prometheus-scheduler --lines 50`
- Estado DB: usar el **MCP de Supabase**.
