# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Arquitectura y contexto técnico de ClawBot. Ground truth verificado contra el código vivo.
> Si algo aquí contradice el código, gana el código — verifícalo antes de actuar.

---

## ⚠️ Lee esto primero

1. **Las decisiones de arquitectura viven en [`docs/adr/`](docs/adr/README.md)** — por qué el sistema es como es, y qué pasó cuando se intentó lo contrario. **Varias parecen bugs desde fuera.** Antes de "arreglar" algo que parece a medio hacer, o de reintroducir un camino obvio, busca en la tabla `Caminos descartados` del ADR que gobierna ese archivo; el índice dice cuál es. La skill `clawbot-stack` es un resumen de apoyo (jun-2026): **este archivo y `docs/adr/` mandan sobre ella.**
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

README.md es una descripción del producto y la arquitectura "Smart Hybrid" — buena lectura de contexto. **`docs/EVOLUTION.md`** = huella histórica con timing (cómo evolucionó la arquitectura por eras); actualízalo cuando aterrice un hito estructural.

⚠️ **`docs/archive/` NO describe el sistema actual** — son documentos correctos en su fecha y falsos hoy (Playwright, Voyager, `worker.js` vivo). Si encuentras algo ahí que contradiga a este archivo, gana este archivo. Ver [`docs/archive/README.md`](docs/archive/README.md).

---

## 2. Smart Hybrid: qué corre de verdad

La forma "obvia" (servidor con Playwright headless) **se banea**: el login del usuario operando desde una IP de datacenter distinta a la suya. LinkedIn lo marca al instante. Es la decisión fundacional del producto y sus corolarios (el VPS nunca abre LinkedIn; un solo host por cuenta): [ADR-0002](docs/adr/0002-ejecutar-en-la-sesion-del-usuario.md).

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

> El `package.json` de prometheus ya apunta a la ruta viva (`main`/`start` = `scheduler-extension.js`, corregido 28-ago-2026; `search`/`batch` eliminados). Los archivos muertos siguen en disco por historia ([ADR-0002](docs/adr/0002-ejecutar-en-la-sesion-del-usuario.md)).

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

- **No hay framework de tests, y es deliberado** ([ADR-0008](docs/adr/0008-sin-framework-de-tests.md)). Dos capas nativas: `npm test` (`node --test`, funciones puras) y `npm run check -w apps/prometheus` (19 self-checks herméticos, cada uno con los datos reales de la avería que lo motivó). Las corre el CI en cada push y PR (`.github/workflows/checks.yml`), no la memoria de nadie. **Lógica nueva no trivial deja su self-check y se encadena a `check`** — si te lo saltas, `test-adr-integrity.js` falla. Lo que necesite `.env`, DB o red no es un self-check: va a `scripts/diagnostics/`. No instales Jest/Vitest.
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

**Accept-detection = PRESENCIA, no ausencia** (`6e0b586`): `invite_sent → connected` lo decide **solo `check_connections`**; la ausencia en `/sent/` no promueve a nadie. Hay una red de seguridad de 24 h que sí infiere si el scan de esa cuenta lleva ese tiempo sin datos. **Antes de tocarlo, verifica que `check_connections` de esa cuenta devuelva conexiones** — si timeoutea, la detección positiva ya está muerta y estás depurando otra cosa. Por qué, y las dos veces que se revirtió sola: [ADR-0004](docs/adr/0004-accepts-por-presencia.md).

⚠️ **Invites fantasma (caso Josh, 8-ago → CERRADO 17-ago)**: LinkedIn puede **descartar en silencio los envíos automatizados de una cuenta** — el modal se cierra igual que en un envío bueno, así que **el cierre de modal NO prueba envío**. Contención: `linkedin_accounts.invites_paused_until` (pausa SOLO invites; FU/inbox siguen). **El episodio de Josh se cerró el 17-ago**: con la pausa quitada, su primer invite entró a la primera (`statedTotal` 176→177 + el lead en la lista real de `/sent/`) ⇒ era transitorio, no un bloqueo estable.

> ⚠️ **Para verificar si los invites de una cuenta entran, usa `statedTotal` de `check_sent_invites`** (el contador que da LinkedIn), NO `confirmedBy`. `confirmedBy` **no discrimina**: medido el 17-ago, **ninguna** cuenta confirma por `toast` (Café 17, Wal 24, Rosy 14, Josh 1 → todas `modal_closed`), así que la rama toast no dispara para nadie y no distingue sana de bloqueada. Ojo también: el `count` scrapeado sale parcial a veces (lazy-load que necesita foco); `statedTotal` no. Ground truth completo: memoria `weekly-invite-limit-ago2026`.

**Super DEAD — contacto que nos eliminó** (`leads.disconnected_at`): un lead que estuvo **genuinamente conectado** y vuelve a dar `not_first_degree` significa que nos eliminaron → `markDisconnectedSuperDead`: `dead` irreversible, **nunca re-invitar** (anti-ban). `wasGenuinelyConnected()` decide entre eso y el simple revert a `invite_sent` de un falso positivo. La escalera completa —incluido por qué la empresa equivocada se **pausa** y no se mata— en [ADR-0005](docs/adr/0005-escalera-de-severidad-del-lead.md).

### 5.1 Búsqueda por empresa (v0.10.x, jul/ago-2026)

> 🔒 **FLUJO CONGELADO — ground truth completo en [`docs/company-scoped-flujo.md`](docs/company-scoped-flujo.md).** Costó 15 bugs encadenados dejarlo funcional (3-ago-2026). Un hook de `.claude/hooks/protect-stable.sh` pide confirmación explícita antes de editar sus archivos. Antes de tocar: leer ese doc + `npm run check -w apps/prometheus`.

La lista que el usuario edita sigue siendo **`campaigns.search_company_names`** (Centro de Control → Búsqueda). `campaign_target_companies` NO tiene UI: el scheduler sincroniza filas desde ese array (TTL 30 min) y las usa como **cursor** (`last_searched_at nulls first` ⇒ una vuelta completa a la lista antes de repetir empresa) y como **caché del company URN**.

Flujo por tick (`trySearchForCampaign` → `lib/extension-dispatch.js` → ext):
1. **Resolver** (fuera del gap de búsqueda): empresas `status='pending'` → comando `resolve_companies` en lotes de 12; la ext navega `/search/results/companies/?keywords=<nombre>` y saca `urn:li:organization:<id>` + slug. `ready` (con URN) / `unresolved` (3 intentos fallidos → se busca por `"nombre exacto"`).
2. **Buscar**: 1 empresa + **1 puesto** por búsqueda, con **facet nativo `currentCompany`**. ⚠️ El grupo booleano (`"A" OR "B"`) NO funciona en el buscador free — LinkedIn lo toma como texto literal y devuelve 0 resultados (31-jul: Mondelēz + 3 títulos con OR = "No se han encontrado resultados" con el facet correcto aplicado). El barrido de los 20-30 puestos se hace visita a visita: cada empresa lleva su cursor `title_idx` y se mantiene seleccionada hasta completar `COMPANY_TITLES_PER_PASS` (6) puestos; la siguiente vuelta retoma donde iba.
3. Con empresa: **sin `geoUrn` en la URL** (chocaba con el facet → 0 resultados), sin `minEmployees`. **(0.10.10)** El `searchMode` respeta la cuenta: `sales_navigator` usa el filtro nativo `CURRENT_COMPANY` en la URL de SalesNav (ve TODA la plantilla, no solo tu red — probado en vivo); `free` usa el facet. Empresa **sin URN** resuelto → siempre free con `"nombre exacto"`.
   ⚠️ Lo que la URL no garantiza (geo y empresa) **se verifica al ingerir**, no en la query: `matchesCampaignGeo` + `headlineNamesCompany` en `ingestSearch`. Ver [ADR-0006](docs/adr/0006-verificar-en-el-ingest.md).
4. **Políglota (3-ago)**: los 3 caminos LLM (`LANGUAGE_RULE` en `lib/ai-message.js`) responden en el idioma del último mensaje del contacto, o lo infieren del perfil en el 1er mensaje; el FU-LLM traduce el template. El FU **verbatim** NO traduce (no pasa por LLM), a propósito. `WRONG_FIT_RULE` (solo replies): proveedor-que-nos-vende / empresa equivocada / mensaje confuso → respuesta honesta, nunca plantilla genérica.

⚠️ **Requiere ext ≥0.10.0** (`COMPANY_SCOPED_MIN_VERSION`): una ext vieja ignora `companyUrn` y buscaría por título en TODO LinkedIn. Sin la versión el scheduler avisa y degrada a title-only.

⚠️ **En company-scoped NUNCA se hace title-only** — no existe ningún camino que busque sin empresa. Si todas están recién buscadas, el cursor repite la más vieja. Las dos válvulas anti-sequía que se intentaron y el daño que hicieron: [ADR-0003](docs/adr/0003-nunca-title-only-en-company-scoped.md).

⚠️ **(12-ago-2026) LinkedIn DEJÓ DE EXPONER el company URN** en `/search/results/companies/`: el resolver matchea bien (`matched:true` + slug + followers) pero devuelve `urn:null` — cambió el markup, no es código viejo (`contentVersion` lo confirma). Efecto vivo: **toda empresa NUEVA entra degradada** a free + `"nombre exacto"` (sin facet ni CURRENT_COMPANY de SalesNav); las viejas siguen bien con su URN cacheado. Dos parches server-side lo contienen (`ecdad90`): `matched && !urn` ⇒ `unresolved` **al instante** (antes 3 rondas de 24h con la campaña entera saltada), y `companyMode && !target` ⇒ `skipped: 'no_company_target'` — era la última puerta al title-only y por ahí se colaron 25 leads fuera de lista en Aduanas Infinity. **Si una campaña "no busca", eso es el modo seguro**: audita con las queries de `docs/company-scoped-flujo.md` antes de tocar el scheduler. Fix de raíz pendiente en la ext: sacar `urn:li:fsd_company:<id>` navegando a `/company/<slug>/`.

> ⚠️ **En modo degradado (sin URN) el scoping de empresa es DECORATIVO** (`f4c892f`): el nombre viaja como texto libre y LinkedIn lo matchea laxo — medido en Aduanas Infinity, 46 de 104 leads trabajaban en otra empresa. Por eso `headlineNamesCompany` verifica en el ingest, y el headline ausente se difiere (`needs_review:*`) en vez de descartarse. Con URN el filtro ni corre. Detalle y casos reales: [ADR-0006](docs/adr/0006-verificar-en-el-ingest.md).

✅ **El picker** (`tryInvitesForCampaign`) ordena `fromList > lead_score > FIFO`, corta al **top-3** y elige random dentro (humanizar). `leads.lead_score` (0..100, `lib/lead-score.js`) se persiste en `ingestSearch` sin llamadas LLM. **`fromList` NO entra al score y `title_preferred` es una whitelist BLANDA que nunca rechaza** — las dos cosas son deliberadas y parecen a medio hacer: [ADR-0007](docs/adr/0007-el-picker-ordena-no-filtra.md).

Pendiente: agrupar por empresa al invitar (hoy el top-3 puede caer todo en la misma).

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

## 7. Generación de mensajes (cadena LLM: Groq → Moonshot → Gemini)

- **Proveedores** (`lib/ai-message.js`): punto único **`callLLM` / `callLLMJson`** con cadena `LLM_PROVIDERS`, y template literal como red final. Config por env `LLM_PROVIDERS` / `GROQ_MODEL`. El post-proceso (truncado por oración, guards) es agnóstico de proveedor.
  **Estado en prod**: `LLM_PROVIDERS=groq,moonshot,gemini` · `GROQ_MODEL=openai/gpt-oss-120b`. Groq y Moonshot son **de paga**; Gemini es el último recurso.
  - **Gemini NO sirve de primario**: free tier = 20 req/día por modelo, y da `FAILED_PRECONDITION: User location is not supported` desde el datacenter.
  - **Kimi/Moonshot** (`kimi-k3`, host GLOBAL `api.moonshot.ai` — el `.cn` rechaza la key) exige `fixedTemperature: 1` y `tokenMultiplier: 4`, ya codificados en `OPENAI_COMPAT`. Tarda 9-13 s y revienta con `429 … max organization concurrency: 1`.
  - ⚠️ **Cuando la IA no responde, verifica el MODELO antes que el prompt**: `curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"`. Groq ya retiró un modelo sin avisar (`llama-3.3-70b-versatile`) y el 404 dice *"or you do not have access to it"*, lo que hace pensar en la key — **no lo es**. Evita `qwen/qwen3.6-27b`: filtra `<think>` al mensaje.
  - Esta cadena **cayó entera dos veces degradando en silencio** (17-ago, 24-ago; la segunda mandó razonamiento del modelo a 4 leads reales). Por qué está diseñada así, por qué `openrouter/free` está prohibido y por qué callar es preferible a publicar basura: [ADR-0001](docs/adr/0001-degradacion-silenciosa.md) §6 y §7. Self-check `scripts/test-reply-guards.js`.
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

### 7.2 A QUIÉN le responde el auto-reply (17-ago-2026)

El FM asumía "prospecto" para todo inbound: a reclutadores les contestó como candidato **inventando experiencia** del dueño de la cuenta, y a proveedores les seguía el pitch. Ahora `classifyInboundRole` (`lib/ai-message.js`, clasificador aparte de `detectExitIntent` — ese está afinado a fuerza de casos y no se toca) etiqueta el último mensaje: `prospect | vendor | recruiter | other`, **fail-open a `prospect`** (si el LLM falla, comportamiento idéntico al anterior). `inboundRoleBlock` va **al final** del system prompt para ganarle al pitch de la campaña y al empuje a cita de `fm_reply_2/3`. `recruiter`/`vendor` nunca reciben el cal.com de ventas.

- **`recruiter` NO se contesta solo** (decisión del operador): `leads.automation_paused=true` + alerta `manual_reply_needed`. Se enciende con `account_config[cuenta].recruiter_reply.auto_reply=true` (+ `cv_url`/`portfolio_url`/`github_url`/`note`, que es lo que compartiría; el prompt prohíbe inventar experiencia y sin `note` el modelo no sabe nada real de ti).
- **Guard anti-meta** (`isMetaOutput`) en `callProvider` — chokepoint de invite/FU-LLM/FM: prefijo meta o <30 chars ⇒ retry ⇒ error ⇒ el caller cae al template verbatim. Nació porque `"User Safety: safe."` (veredicto del clasificador de Groq/llama) se envió CRUDO a un lead: pasaba placeholder-guard, cap y puntuación. **NO** está en el guard pre-envío del FU verbatim a propósito: un template corto legítimo del usuario quedaría bloqueado en silencio. Self-check: `scripts/test-reply-guards.js`.
- **Guard anti-contacto-inventado** (`findUnapprovedContact`, mismo chokepoint): un teléfono/email/URL que no venga en el propio prompt no se envía; en FM pausa + alerta. Para que el bot PUEDA compartir un dato: configúralo (`cal_com_url`, `ai_company_context`) — nunca excepciones al guard. Por qué y qué se descartó: [ADR-0009](docs/adr/0009-contacto-solo-del-prompt.md).
- **Rompe-loops del auto-reply** (`AUTO_REPLY_LOOP_CAP=8`): cuenta solo outbound **posteriores al último inbound** — contarlo sobre el hilo entero pausaba el PRIMER reply humano de todo lead que llegara al FU7 (9 leads mudos, 01-sep-2026). Cualquier reply que llegue a un lead `automation_paused` (pausa manual del CRM incluida) levanta alerta `manual_reply_needed` desde el ingest del bridge.

---

## 8. Orion — rutas y auth

App Router en `apps/orion/app`. Dashboard bajo `/dashboard/*` (leads, conversations, campaigns, accounts, monitor, activity, quarantine, users). API routes en `app/api/*` — destaca `app/api/extension/*` (status/next-actions/force-tick/etc., el contrato con la extensión) y `app/api/crm/*`.

Auth: Supabase Auth + RLS. Roles `god_admin > admin > user`. Proxy de Next protege `/dashboard/*` (nota: `middleware.ts` fue migrado a `proxy.ts` por deprecación de Next 16).

---

## 9. Variables de entorno (no en el repo)

- **prometheus**: `apps/prometheus/.env` → `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, **`GROQ_API_KEY`** (LLM primario), **`MOONSHOT_API_KEY`** (Kimi, respaldo de pago). Ops del watchdog (opcionales): `OPS_WEBHOOK_URL` (alertas Slack/Telegram/ntfy), `OPS_HEARTBEAT_URL` (dead-man's-switch Healthchecks.io). Digest diario (11-ago): `RESEND_API_KEY` + `DIGEST_FROM` (remitente `Nombre <email@dominio-verificado-en-Resend>`; sin key el digest es no-op con alerta). Tuning: `LLM_PROVIDERS`, `GROQ_MODEL`, `EXTENSION_POLL_INTERVAL_MS`, `CONFIG_CACHE_TTL_MS`.
- **orion**: `apps/orion/.env.local` → vars de Supabase + auth.

---

## 10. Trampas conocidas

1. **(corregido 28-ago-2026)** El `package.json` de prometheus ya apunta a `scheduler-extension.js` (`main`/`start`; `search`/`batch` eliminados). Los `.js` muertos siguen en disco por historia (ADR-0002) — no los uses como referencia.
2. **`ecosystem.config.cjs` stale** (ver §4) — usa `pm2 resurrect`.
3. **Fixes de la extensión** no aplican hasta recargarla en `chrome://extensions` por cada cuenta. ⚠️ **Y `git pull` NO actualiza la extensión**: Chrome carga una **copia** (`~/.orion/extension`), no la carpeta del repo. El operador actualiza con `curl -fsSL http://209.50.63.149/download/install.sh | bash` (Windows: `irm .../install.ps1 | iex`) y DESPUÉS recarga en `chrome://extensions`. En prod, el hook `post-merge` de `/root/clawbot` republica el bundle en cada pull (`apps/orion-extension/publish.sh`). Lección 29-jul-2026: 3 cuentas se quedaron en v0.9.26 un día entero — el endpoint servía un tarball de 12 días atrás y "recargar" solo recargaba código viejo. Verificación real = `linkedin_accounts.ext_version`.
4. **`currentCompany`**: la regex `headlineCompany` (`worker.js`) sigue **MUERTA**, pero **(jul-2026) el pass vivo `tryEnrichCompanies` YA puebla `currentCompany`** extrayendo la empresa del headline con el LLM (gate anti-alucinación; `''` = sin empresa → fallback `'tu empresa'`). La regla "no inventes empresa / no uses el título como empresa" (`NO_INVENT_COMPANY_RULE`) sigue vigente en la extracción y en la redacción. Ver §7.
5. Memoria histórica rica del proyecto vive en `~/.claude/projects/.../memory/` y **no** auto-carga; léela manualmente vía su `MEMORY.md` si necesitas historia.
6. **"Orion está caído" casi nunca es Orion** (outages 17 y 19-ago-2026, ver `docs/bitacora-operativa.md`): la app web sigue respondiendo en localhost mientras Supabase arrastra a todo lo demás. Orden de diagnóstico: (a) `pm2 list` + `curl localhost:3000` (suele dar `307` en ms), (b) query real a `/rest/v1/` desde prod **con timing**, (c) `execute_sql` del MCP para separar capas — el MCP va por **Postgres directo** y la app por **PostgREST**; si el MCP responde y el REST timeoutea, lo roto es PostgREST; **si cuelgan los DOS, es la instancia entera** (19-ago), (d) **abrir el panel Infrastructure** del dashboard y leer COMPUTE/CPU/MEMORY/DISK IO + % de disco — manda sobre cualquier inferencia sacada de los logs, (e) `query_logs` con `source='postgres_logs'`: comparar **buffers escritos contra segundos** en los `checkpoint complete` sanos vs enfermos es el termómetro más directo (19-ago: de 10 buffers/1,0 s a 3 buffers/64,9 s). ⚠️ **`get_project` MIENTE**: devolvió `ACTIVE_HEALTHY` las 6h que la base estuvo inservible — no lo uses para descartar una caída. ⚠️ **No pierdas tiempo parando pollers**: el circuit breaker ya recorta la carga solo (2.264 → ~250 req/h el 19-ago) y aun así la instancia no levantó; si Postgres revive pero PostgREST no, lo que hace falta es el **restart del proyecto desde el dashboard** (solo el operador). **NUNCA `pause_project`/`restore_project`** (lo único que expone el MCP): el restore trae el último backup ⇒ pérdida de datos potencial; el restart normal solo está en el dashboard y casi nunca hace falta. **(01-sep-2026) El proyecto ya es PRO tier** (backups diarios, compute fijo — adiós pausas administrativas tipo caída #6 y throttling de la Nano); la pausa/restore por MCP sigue prohibida. Si el proyecto aparece `INACTIVE` con `Project paused`: solo el operador despausa desde el dashboard, y al despertar los `PGRST002`/`PGRST205` ("schema cache") son el arranque, no esquema perdido — se van solos en ~2 min. Desde `b3e922e` el bridge **se repliega solo** (circuit breaker en `lib/db-circuit.js`: 3 fallos ⇒ pausa poll+cleanup 60s) y un timeout de DB ya **no** se cuenta como auth fallida, así que no hay que parar procesos a mano ni esperar lockouts; si aun así hay que intervenir, `pm2 stop prometheus-scheduler extension-bridge` es lo que permite que la instancia levante. ⚠️ Si ves logs viejos con `auth failed` / `db: <empty>` / `invalid_api_key`: era un **timeout disfrazado**, las keys estaban bien. Alertas: topic ntfy **`clawbot-alertas-orion`** (el watchdog detecta en ~2 min; sirve de poco si nadie está suscrito).
7. **El node de prod es v20 y su ICU formatea medianoche como `"24"`** con `Intl.DateTimeFormat` + `hour12:false` (ciclo h24; en node ≥22 da `"0"`). Cualquier gate nuevo `hora >= H` se abre a las 00:00 — así salió el digest SEMANAS a medianoche (31-ago-2026). `mxTime` ya lleva `% 24`, pero si escribes OTRO parse de hora, aplica lo mismo, y **verifica hipótesis de Intl en el node de PROD** (`ssh clawbot node -e ...`), no en la laptop (node 24 no lo reproduce). Fix de raíz pendiente: subir prod a node ≥22.
