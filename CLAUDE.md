# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Arquitectura y contexto técnico de ClawBot. Ground truth verificado contra el código vivo.
> Si algo aquí contradice el código, gana el código — verifícalo antes de actuar.

---

## ⚠️ Lee esto primero

1. **Hay una skill que es ground truth**: `.claude/skills/clawbot-stack/` (`SKILL.md` + `commands-cheatsheet.md` + `data-model.md`). Se auto-invoca en tareas de código de este repo. Si la skill y este archivo difieren, la skill es más reciente.
2. **Next.js NO es el que conoces** (`apps/orion/AGENTS.md`): es Next **16.2.3**, con breaking changes vs tu training data. **Lee la guía relevante en `apps/orion/node_modules/next/dist/docs/` ANTES de escribir código Next** y respeta los avisos de deprecación.
3. **Código vivo vs muerto** (ver §2): gran parte de `apps/prometheus/*.js` es arquitectura **muerta** que ningún proceso carga. No la uses como referencia de cómo funciona hoy.
4. **Este checkout es la laptop de dev** (`/home/walfro90/clawbot-orion`). El servidor de producción usa `/root/clawbot`. Deploy = `git push` → mecanismo `deploy-orion` a Upcloud prod (no Vercel).

---

## 1. Estructura del monorepo

npm workspaces (`apps/*`, `packages/*`):

```
apps/
├── orion/            ← CRM + panel de control web (Next.js 16, App Router)
├── prometheus/       ← Backend de automatización (Node.js ESM)
└── orion-extension/  ← Extensión Chrome MV3 "Orion Sync" (ejecuta en la sesión real del usuario)
packages/
└── db-types/         ← Tipos TypeScript generados de Supabase
ecosystem.config.cjs  ← PM2 (⚠️ STALE, ver §4)
```

Stack por app:
- **orion**: Next.js 16.2.3 (App Router) · React 19 · TypeScript 5 · Tailwind 4 · `@supabase/ssr` + `@supabase/supabase-js` · `@google/genai` (Gemini 2.5 Flash) · ESLint 9 (`eslint-config-next`).
- **prometheus**: Node.js ESM · Express 5 · WebSocket (`ws`) · Supabase · `@google/genai`. (Playwright/stealth siguen como deps pero son de la arquitectura muerta.)
- **orion-extension**: Chrome Extension Manifest V3, service worker módulo, content scripts en `*.linkedin.com`.
- **packages/db-types**: `database.types.ts` generado por `supabase gen types`.

README.md es una descripción rica y actualizada del producto y la arquitectura "Smart Hybrid" — buena lectura de contexto. **`docs/EVOLUTION.md`** = huella histórica con timing (cómo evolucionó la arquitectura por eras); actualízalo cuando aterrice un hito estructural.

---

## 2. Smart Hybrid: qué corre de verdad

La forma "obvia" (servidor con Playwright headless) **se banea**: el login del usuario operando desde una IP de datacenter distinta a la suya. LinkedIn lo marca al instante.

**Arquitectura vigente = Smart Hybrid**: la extensión Chrome MV3 ejecuta las acciones de LinkedIn desde la **IP/sesión real del usuario**. Prometheus solo orquesta — inserta comandos en la tabla `extension_commands` y un bridge WebSocket los despacha a la extensión.

Flujo de un comando (ej. `send_invite`):
1. `scheduler-extension.js` (tick ~5 min) decide qué hacer por campaña → inserta fila en `extension_commands` (status `pending`).
2. `extension-bridge.js` (WS server) hace poll de comandos `pending` de cuentas conectadas → los despacha por WebSocket.
3. La extensión (`content.js`, FSM) ejecuta la acción en LinkedIn → reporta `command_result`.
4. El bridge actualiza `extension_commands` (status `completed`/`failed`, `result`) e ingiere el resultado en la DB.

### Código VIVO vs MUERTO en `apps/prometheus`

| Vivo (lo que corre) | Muerto (en disco, ningún proceso lo carga) |
|---------------------|---------------------------------------------|
| `scheduler-extension.js` (orquestador real) | `scheduler.js` (viejo orquestador Playwright) |
| `extension-bridge.js` (WS bridge) | `worker.js`, `batch.js`, `search.js` (scraping Playwright) |
| `ai.js` + `lib/ai-message.js` (Gemini) | `inbox.js` (lectura inbox vía Voyager GraphQL) |
| `lib/*` (extension-dispatch, supabase, lead-failure, etc.) | `followup.js` (legacy) |

> El `package.json` de prometheus aún declara `main: worker.js` y scripts `start/batch/search` que apuntan a código muerto. **No los uses.** El proceso real corre `scheduler-extension.js`.

---

## 3. Comandos

```bash
# Orion (desde apps/orion)
npm run dev          # dev server :3000
npm run build        # build de producción
npm run lint         # eslint
npm run start        # next start (prod)

# Desde la raíz (workspaces)
npm run orion        # = npm run dev --workspace=apps/orion
npm run types        # regenera packages/db-types/database.types.ts (supabase gen types, project-id cjbvutiugmehrhdnfeta)

# Tipos de DB tras cambiar el esquema
npm run types
```

- **No hay framework de tests** (el `test` de prometheus es un stub). No inventes uno; verifica con build + lint + inspección de DB.
- **DB**: inspecciona y consulta con el **MCP de Supabase** (`list_tables`, `execute_sql`, `get_advisors`, `get_logs`). Project id: `cjbvutiugmehrhdnfeta`.
- **Extensión**: tras editar `apps/orion-extension/{background,content}.js` o `manifest.json`, hay que **recargar la extensión** en `chrome://extensions` y recargar la pestaña LinkedIn por cada cuenta.

---

## 4. PM2 / despliegue (producción `/root/clawbot`)

Producción corre **4 procesos PM2**, no los 2 del ecosystem:

| Proceso | Script | Rol |
|---------|--------|-----|
| `orion` | `npm start` (Next) | CRM frontend :3000 |
| `prometheus-scheduler` | **`scheduler-extension.js`** | Orquestador (tick ~5 min) |
| `extension-bridge` | `extension-bridge.js` | WS bridge a la extensión |
| `xvfb` | — | Display virtual para Chrome |

```bash
pm2 list
pm2 logs prometheus-scheduler --lines 50
pm2 logs extension-bridge --lines 50
cd apps/orion && npm run build && pm2 restart orion   # tras cambios en Orion
pm2 resurrect        # ✅ recuperación real tras reboot (depende de pm2 save)
```

> ⚠️ **`ecosystem.config.cjs` está STALE**: solo define `orion` + `prometheus-scheduler` apuntando al viejo `scheduler.js`, sin `extension-bridge` ni `xvfb`. **NO uses `pm2 start ecosystem.config.cjs`** — levanta el set equivocado. Usa `pm2 resurrect`.

> ⚠️ **`git push` NO despliega solo — verifica SIEMPRE (lección 06-jul-2026).** `deploy-orion` hace el `git pull` a `/root/clawbot` con **delay** (no instantáneo) y **NO reinicia los procesos PM2**. Se han "confirmado" fixes que en realidad corrían código viejo. Después de pushear, el flujo correcto es:
> ```bash
> ssh clawbot 'cd /root/clawbot && git pull --ff-only origin main && git log --oneline -1'   # confirmar HEAD = tu commit
> ssh clawbot 'grep -c <símbolo-nuevo> /root/clawbot/apps/prometheus/<archivo>'                # confirmar que el código llegó al disco
> ssh clawbot 'pm2 restart prometheus-scheduler extension-bridge'                              # cargar cambios de prometheus
> ssh clawbot 'cd /root/clawbot/apps/orion && npm run build && pm2 restart orion'              # cargar cambios de orion
> ```
> Un cambio en `lib/ai-message.js`/`lib/*` afecta al proceso que lo importa (`prometheus-scheduler`). `extension-bridge.js` → `extension-bridge`. Si tocaste ambos, reinicia ambos.

---

## 5. Base de datos (Supabase)

Verifica el esquema real con el MCP de Supabase antes de cambiarlo.

| Tabla | Rol |
|-------|-----|
| `linkedin_accounts` | cuentas LinkedIn: cookie, proxy, estado, `extension_api_key` |
| `campaigns` | campañas vinculadas a una cuenta |
| `campaign_target_companies` | lista maestra de empresas por campaña: cursor + caché del company URN — v0.10.0 (ver §5.1) |
| `campaign_followups` | secuencia de FU por campaña (1..20 pasos) — v0.8 (ver §6) |
| `leads` | leads: `profile_data` (JSON), `status`, `ai_message`, `headlineCompany`, `followup_step` |
| `message_templates` | templates de mensaje por campaña (reglas para Gemini) |
| `conversations` / `conversation_events` | conversación e historial mensaje a mensaje |
| `extension_commands` | cola de comandos que el bridge despacha a la extensión |
| `scheduler_log` | cada tick/job del scheduler |
| `daily_activity` | contador diario de invitaciones por cuenta |
| `account_alerts` | alertas (cookie expirada, captcha, etc.) |

### CHECK constraints (insertar fuera del set = error, no fallo silencioso)
- **`conversations.status`** ∈ `initiated | connected | active | meeting_booked | dead | closed_won | closed_lost`
- **`conversation_events.event_type`** ∈ `invite_sent | invite_accepted | invite_rejected | message_sent | message_failed | reply_received | follow_up_sent | meeting_proposed | meeting_confirmed | note_added`

Antes de escribir en `conversation_events`, elige el `event_type` correcto (no todo es `invite_sent`).

### Estado del lead
```
pending → invite_sent → connected → follow_up_sent (followup_step 1..N) → replied
                    ↘ failed / disqualified                ↘ dead (auto_dead_after_days)
```
`follow_up_sent` es genérico para toda la cadena; el paso vive en `leads.followup_step`.

**Super DEAD — contacto que nos eliminó** (`leads.disconnected_at`, jul-2026): si un lead que estuvo **genuinamente conectado** (FU enviado / nos respondió / etapa post-conexión) vuelve a dar `not_first_degree`/`not_messageable`, significa que **el contacto nos ELIMINÓ de su red** → `markDisconnectedSuperDead` (`extension-bridge.js`): `status=dead` + `dead_reason=disconnected_by_contact` + `disconnected_at` + `automation_paused=true`. **NUNCA re-invitar/re-mensajear** (anti-ban). Distinto del revert a `invite_sent` que se aplica solo a un **falso-positivo** de accept-detection (lead sin evidencia de conexión real). `wasGenuinelyConnected()` decide. Cobertura reactiva = ruta compose (el guard InMail dispara antes de enviar); la ruta thread (FU multi-paso) requiere el check de grado en la extensión (pendiente).

### 5.1 Búsqueda por empresa (v0.10.0, jul-2026)

La lista que el usuario edita sigue siendo **`campaigns.search_company_names`** (Centro de Control → Búsqueda). `campaign_target_companies` NO tiene UI: el scheduler sincroniza filas desde ese array (TTL 30 min) y las usa como **cursor** (`last_searched_at nulls first` ⇒ una vuelta completa a la lista antes de repetir empresa) y como **caché del company URN**.

Flujo por tick (`trySearchForCampaign` → `lib/extension-dispatch.js` → ext):
1. **Resolver** (fuera del gap de búsqueda): empresas `status='pending'` → comando `resolve_companies` en lotes de 12; la ext navega `/search/results/companies/?keywords=<nombre>` y saca `urn:li:organization:<id>` + slug. `ready` (con URN) / `unresolved` (3 intentos fallidos → se busca por `"nombre exacto"`).
2. **Buscar**: 1 empresa por búsqueda con **facet nativo `currentCompany`** + grupo booleano de títulos (`"Director de Compras" OR …`, cap 200 chars) ⇒ varios puestos objetivo por visita.
3. Con empresa: **sin `geoUrn`**, sin `minEmployees`, y `searchMode` forzado a `free` (la URL de SalesNav es keywords-only y se comía el scoping).

⚠️ **Requiere ext ≥0.10.0** (`COMPANY_SCOPED_MIN_VERSION`): una ext vieja ignora `companyUrn` y buscaría por título en TODO LinkedIn. Sin la versión el scheduler avisa y degrada a title-only.

⚠️ **La válvula anti-sequía ya NO borra la lista de empresas.** Lo hacía en drought crítico, y como el modo empresa rinde pocos ejecutivos el drought era permanente → empresa borrada siempre → bucle que anulaba la feature (15 de 17 búsquedas medidas salieron title-only). Hoy el escape es acotado: solo tras `dry_search_streak ≥ 5` se hace UNA búsqueda title-only de reabastecimiento.

Pendiente (Fase 2): invitar por **peso de responsabilidad** dentro de la empresa (hoy `tryInvitesForCampaign` toma random del top-5 del pool filtrado por whitelist, sin ranking de seniority ni agrupar por empresa).

### Tipos en código
```ts
import type { Database } from '@clawbot/db-types'
type Lead = Database['public']['Tables']['leads']['Row']
```
Tras cambiar el esquema: `npm run types`.

---

## 6. Follow-ups dinámicos (v0.8)

> 📘 **Ground truth completo del flujo FU en [`docs/followups-flujo.md`](docs/followups-flujo.md)**: las 2 rutas de composer (thread DOM-ligero vs overlay **shadow DOM**), el fix `deepQuery` (0.9.8), la query de elegibilidad + TODOS los gates que bloquean un FU (`quarantined_at`, `cooldown_until`, lockout, dedup…), la taxonomía de errores, y cómo recuperar un lead atascado. **Léelo antes de tocar FU o "suponer" por qué un lead no recibe seguimiento.**

Los FU **no están hardcodeados**. Cada campaña define **1..20 pasos** en `campaign_followups (campaign_id, step, message, delay_value, delay_unit, jitter_hours, enabled)`. El nº de filas habilitadas = nº de seguimientos.

- **Progreso del lead**: `leads.followup_step` (default 0). Todos los leads en cadena de FU comparten `status='follow_up_sent'`; el paso lo lleva el contador. Hay un solo timestamp: `last_followup_at`.
- **Motor** (`scheduler-extension.js` + `lib/extension-dispatch.js`): próximo paso = `followup_step + 1`. `prevTime = followup_step===0 ? connected_at : last_followup_at`. Si no hay fila para el paso siguiente → secuencia agotada (lo barre `auto_dead_after_days`).
- **Admin panel**: editor dinámico `components/followup-sequence-editor.tsx` (cap 20) en el Centro de Control (`accounts/[id]/config`) y en `campaigns/[id]/edit`. Guarda reemplazando filas vía server action.
- **Legacy NO usado**: columnas `campaigns.follow_up_step2..5_*` / `leads.last_followup2..5_at` existen para rollback pero el motor ya no las lee.

---

## 7. Generación de mensajes (LLM: Groq primario + Gemini fallback)

- **Proveedores** (`lib/ai-message.js`, jul-2026): punto único **`callLLM` / `callLLMJson`** con cadena `LLM_PROVIDERS` (default `groq,gemini`) → **Groq primario** (`llama-3.3-70b-versatile`, API OpenAI-compatible) + **Gemini 2.5 Flash de fallback** + template literal como red final. Config por env `LLM_PROVIDERS` / `GROQ_MODEL`. Mata la fragilidad de proveedor único (un billing caído no rompe la generación). El post-proceso (truncado por oración, guard anti-placeholder) es agnóstico de proveedor.
- **Templates por campaña**: `campaign_followups.message` (FU) + `gemini_system_prompt` / `fmN_example_reply` (campaña). ⚠️ La tabla `message_templates` la lee solo código **MUERTO** (`worker.js`) — NO afecta la ruta viva.
- **🧠 Cerebro de metodología (`ai_playbook`) — VIVO desde jul-2026 (Fase 1, commit a869e8f)**: antes cableado solo a código muerto (`ai.js`), ahora `fetchBrainBlock` (`lib/ai-message.js`) lo inyecta **guarded** en los 3 caminos (invite/FU/FM). `kind` (`principle` siempre / `example`+`objection` recuperados por turno+tags) + `campaign_id` (jerarquía global NULL / por campaña). Sin entradas → prompt idéntico. UI admin `/dashboard/cerebro`. **Fase 2 (aprender de `outcome_count`) pendiente** — no hay updater vivo. Ground truth: memoria `cerebro-metodologia-jul2026`.
- **Regla crítica "empresa"**: la regla "**NUNCA uses el título/rol como empresa ni inventes una**" está codificada como texto en el prompt vivo (`NO_INVENT_COMPANY_RULE`). **(jul-2026) Ahora SÍ se puebla `profile_data.currentCompany`**: el pass `tryEnrichCompanies` (scheduler, 1×/tick, global) extrae la empresa del `headline` con el LLM (`extractCompaniesFromHeadlines` en `lib/ai-message.js`, mismo gate anti-alucinación, por lote) — NO con la regex muerta `headlineCompany`. Centinela `''` = "revisado, sin empresa" → `{empresa}` cae a `'tu empresa'` en `substituteTemplate`. ~51% de leads obtienen empresa real; el resto, fallback seguro. Script QA: `scripts/backfill-company-from-headline.js --dry-run`.

### 7.1 Qué LEE la ruta viva vs qué GUARDA Orion web (⚠️ trampa — audit jul-2026)

> **El error a NO repetir**: se configuraba persona/contexto en Orion web y el FM seguía saliendo genérico, porque los campos que el usuario editaba NO eran los que la ruta viva lee. Antes de "arreglar por qué la IA ignora la config", consulta este mapa. Ground truth completo: memoria `msg-generation-flow-jul2026`.

**Interruptor maestro = `campaigns.gemini_system_prompt`.** `hasAiFallback = trim().length > 20` (`scheduler-extension.js`) decide el FU:
- **vacío → FU verbatim**: `campaign_followups.message` se manda tal cual (solo sustituye `{nombre}`/`{empresa}` vía `substituteTemplate`).
- **>20 → FU-LLM**: `personalizeFollowupMessage` lo reescribe por lead. ⚠️ **Llenar `gemini_system_prompt` VOLTEA el FU de literal a IA.**
- **FM/auto-reply**: SIEMPRE LLM (`generateLinkedInReply` → `buildSystemPrompt`).

| Campo (Orion web lo escribe) | ¿La ruta VIVA lo lee? |
|---|---|
| `campaign_followups.message` | ✅ FU (verbatim, o seed del LLM si hay gemini) |
| `campaigns.gemini_system_prompt` | ✅ system prompt (invite/FM/FU-LLM). Editable en Centro de Control → tab IA **desde 716e928** (antes solo al crear) |
| `campaigns.fmN_example_reply` | ✅ ejemplo de tono en FM |
| `campaigns.ai_sender_persona` / `ai_company_context` / `ai_tone` | ✅ **desde commit 716e928** (`campaignPersonaBlock` en `ai-message.js`) — antes se cargaban en el SELECT pero NUNCA llegaban al prompt |
| `campaigns.ai_example_messages` | ❌ ni se selecciona |
| `campaigns.target_audience` | ❌ se selecciona, nunca se interpola |
| **`message_templates.*`** (message_rules, opening_hint, example_good…) | ❌ **código MUERTO** (`worker.js`/`ai.js`). NO reconectar — migrar su contenido a `gemini_system_prompt`/`ai_*` |

`campaignPersonaBlock` inyecta persona/contexto/tono **solo si hay persona o contexto** (tono solo no dispara → campañas tono-only quedan idénticas), con caps 2000/3000 chars anti-bloat. El FU verbatim NO se toca (no llama LLM).

---

## 8. Orion — rutas y auth

App Router en `apps/orion/app`. Dashboard bajo `/dashboard/*` (leads, conversations, campaigns, accounts, monitor, activity, quarantine, users). API routes en `app/api/*` — destaca `app/api/extension/*` (status/next-actions/force-tick/etc., el contrato con la extensión) y `app/api/crm/*`.

Auth: Supabase Auth + RLS. Roles `god_admin > admin > user`. Proxy de Next protege `/dashboard/*` (nota: `middleware.ts` fue migrado a `proxy.ts` por deprecación de Next 16).

---

## 9. Variables de entorno (no en el repo)

- **prometheus**: `apps/prometheus/.env` → `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, **`GROQ_API_KEY`** (LLM primario). Ops del watchdog (opcionales): `OPS_WEBHOOK_URL` (alertas Slack/Telegram/ntfy), `OPS_HEARTBEAT_URL` (dead-man's-switch Healthchecks.io). Tuning: `LLM_PROVIDERS`, `GROQ_MODEL`, `EXTENSION_POLL_INTERVAL_MS`, `CONFIG_CACHE_TTL_MS`.
- **orion**: `apps/orion/.env.local` → vars de Supabase + auth.

---

## 10. Trampas conocidas

1. **`package.json` de prometheus engaña**: `main`/scripts apuntan a código muerto (`worker.js`/`batch.js`/`search.js`). El proceso real es `scheduler-extension.js`.
2. **`ecosystem.config.cjs` stale** (ver §4) — usa `pm2 resurrect`.
3. **Fixes de la extensión** no aplican hasta recargarla en `chrome://extensions` por cada cuenta. ⚠️ **Y `git pull` NO actualiza la extensión**: Chrome carga una **copia** (`~/.orion/extension`), no la carpeta del repo. El operador actualiza con `curl -fsSL http://209.50.63.149/download/install.sh | bash` (Windows: `irm .../install.ps1 | iex`) y DESPUÉS recarga en `chrome://extensions`. En prod, el hook `post-merge` de `/root/clawbot` republica el bundle en cada pull (`apps/orion-extension/publish.sh`). Lección 29-jul-2026: 3 cuentas se quedaron en v0.9.26 un día entero — el endpoint servía un tarball de 12 días atrás y "recargar" solo recargaba código viejo. Verificación real = `linkedin_accounts.ext_version`.
4. **`currentCompany`**: la regex `headlineCompany` (`worker.js`) sigue **MUERTA**, pero **(jul-2026) el pass vivo `tryEnrichCompanies` YA puebla `currentCompany`** extrayendo la empresa del headline con el LLM (gate anti-alucinación; `''` = sin empresa → fallback `'tu empresa'`). La regla "no inventes empresa / no uses el título como empresa" (`NO_INVENT_COMPANY_RULE`) sigue vigente en la extracción y en la redacción. Ver §7.
5. Memoria histórica rica del proyecto vive en `~/.claude/projects/.../memory/` y **no** auto-carga; léela manualmente vía su `MEMORY.md` si necesitas historia.
