# Agentes de ClawBot

> Catálogo de todos los agentes: qué hacen, su función/firma, props, gates y dónde ver su actividad.
> Ground truth verificado contra el código vivo (jul-2026). Si algo aquí contradice el código, gana el código.

---

## Cómo se orquestan

Todo vive en **`apps/prometheus/scheduler-extension.js`** (proceso PM2 `prometheus-scheduler`), que corre un **tick cada ~5 min** (`tick()` → `runTickSafely()`). En cada tick, para **cada campaña activa** de cada cuenta conectada, se ejecutan los **agentes operativos** en orden. Los que necesitan redactar texto llaman a los **agentes de IA** en `apps/prometheus/lib/ai-message.js` (LLM: **Groq primario `llama-3.3-70b` + Gemini fallback**).

Los agentes operativos NO tocan LinkedIn directo: **insertan un comando en `extension_commands`**; el `extension-bridge` (WS) lo despacha a la extensión Chrome, que ejecuta la acción en la sesión real del usuario y reporta el resultado. Ver arquitectura Smart Hybrid en `CLAUDE.md` §2.

**Observabilidad**: la tabla `extension_commands` (columnas `action`, `status`, `result`, `created_at`, `account_id`, `related_lead_id`) es la fuente rica de "qué hizo cada agente y cuándo". `scheduler_log` es sparse (solo `tick`). La **Oficina IA** (`/dashboard/office` en Orion) visualiza esto en vivo.

---

## Agentes operativos (`scheduler-extension.js`)

| Agente | Función | Comando que despacha | Qué hace |
|--------|---------|----------------------|----------|
| 🔍 Buscador | `trySearchForCampaign(campaign, account)` | `search` | Busca decisores nuevos por keyword/empresa |
| 🧹 Reaper | `sweepJunkScraped(campaign)` | — (op DB) | Barre `scraped` no-whitelist >2d → `disqualified` |
| 🤝 Invitador | `tryInvitesForCampaign(campaign, account)` | `send_invite` | Selecciona lead válido y envía invitación |
| 💬 Seguimientos | `tryFollowupsForCampaign(campaign, account)` | `send_followup` | Manda la secuencia FU (verbatim o IA) |
| 🧠 Auto-respuesta (FM) | `tryAutoReplyForCampaign(campaign, account)` | `send_followup` | Responde con IA a leads que contestaron |
| 📝 Prospección de posts (buscar) | `tryPostSearchForCampaign(postCampaign, account)` | `search_posts` | Busca posts relevantes para comentar |
| 📝 Prospección de posts (comentar) | `tryPostCommentsForCampaign(postCampaign, account)` | `comment_on_post` | Comenta value-first + encadena conexión |

### 🔍 Buscador — `trySearchForCampaign`
- **Reabastece por CONTEO de ejecutivos elegibles** (no por tiempo): `eligibleCount = getEligiblePendingCount(campaign)` (cuenta leads `scraped`/`pending` que pasan el whitelist).
- Gates: `search_paused` · `eligibleCount >= min_pending_threshold` → skip (`enough_eligible_leads`) · drought crítico (≤~critical) → busca YA respetando piso anti-spam · `dry_search_streak` (backoff yield-aware: si las búsquedas vienen secas, el piso crece 30→360min).
- Rota `search_keywords` con `last_search_keyword_idx`. En drought crítico con `search_company_names`, cae a búsqueda **title-only** (válvula de volumen).

### 🧹 Reaper — `sweepJunkScraped` (06-jul-2026)
- El search company-scoped rinde ~1 ejecutivo por decenas de empleados; el junk que falla el whitelist se quedaba en `scraped` para siempre y **tapaba la ventana de selección de invites**.
- Barre `scraped` con headline y `scraped_at > 2 días` que NO pasan `passesTitleFilters` → `status='disqualified'`, `dead_reason='not_whitelist_junk'`. Headline vacío PASA (no se toca). Idempotente.

### 🤝 Invitador — `tryInvitesForCampaign`
- Gates: `batch_paused` · gap dinámico entre invites (reparte el `daily_invite_target` en la ventana horaria, piso anti-ban 25min + jitter) · cap diario efectivo `min(daily_invite_target, daily_connection_limit, warmupDefault)` (**máx 25** por `WARMUP_LEGACY.hot`).
- Selección: query de candidatos `status='scraped'` (limit 100), filtra `passesTitleFilters` **en memoria**, pick aleatorio entre top-5 (humanización).

### 💬 Seguimientos — `tryFollowupsForCampaign`
- FU dinámicos v0.8: `campaign_followups (step, message, delay_value, delay_unit, jitter_hours, enabled)`, 1..20 pasos. Próximo paso = `followup_step + 1`.
- **Ruta del mensaje** (interruptor = `gemini_system_prompt`): vacío → `substituteTemplate` (verbatim, solo sustituye `{nombre}`/`{empresa}`); >20 chars → `personalizeFollowupMessage` (IA reescribe por lead).
- Gates: `follow_up_paused` · delay del paso · `quarantined_at` · `cooldown_until` · lockout · dedup por contenido · `auto_dead_after_days`. Ground truth: `docs/followups-flujo.md`.

### 🧠 Auto-respuesta (FM) — `tryAutoReplyForCampaign`
- Cuando un lead responde (`status='replied'`), genera respuesta con IA (`generateLinkedInReply`) y la despacha como `send_followup`.
- `fmStep` 1..3 (rapport → pitch → cierre + cal.com). Gates: `auto_reply_mode` · delay · cap diario de mensajes · guard fail-closed de `detected_not_first_degree`.

### 📝 Prospección de posts — `tryPostSearchForCampaign` / `tryPostCommentsForCampaign`
- Busca posts (`search_posts`) → los califica con `qualifyPost` → comenta los relevantes con `generatePostComment` (`comment_on_post`). Encadena conexión al autor.

---

## Agentes de IA (`lib/ai-message.js` — LLM)

| Agente | Función | Props | Devuelve |
|--------|---------|-------|----------|
| 🧠 Auto-respuesta | `generateLinkedInReply(campaign, lead, ctx, opts)` | `ctx: {conversationHistory, fmStep 1-3, calUrl, lastFuTemplate}` | `{message}` \| `{error}` |
| ✍️ FU personalize | `personalizeFollowupMessage(campaign, lead, template, fuStep, calUrl, opts)` | `template` = `campaign_followups.message` | `{message}` \| `{error}` |
| 📨 Invite/FU full-gen | `generateLinkedInMessage(campaign, lead, type, opts)` | `type: 'invite'\|'follow_up_1..3'` | `{message}` \| `{error}` |
| 🔎 Calificador de posts | `qualifyPost(postText, serviceDescription, opts)` | texto del post + descripción del servicio | `{relevant, score 0-10, reason}` |
| 💬 Comentador de posts | `generatePostComment(post, postCampaign, opts)` | `post: {author_name, author_headline, post_text}` · `postCampaign: {gemini_system_prompt, comment_rules, service_description}` | `{message}` \| `{error}` |

### Qué campos de la campaña alimentan el prompt (⚠️ ver CLAUDE.md §7.1)
El system prompt de **toda** generación se arma en `buildSystemPrompt`/`campaignPersonaBlock` con:
- `campaigns.gemini_system_prompt` — instrucción base (vacío → default genérico).
- `campaigns.ai_sender_persona` + `ai_company_context` + `ai_tone` — **identidad/voz** (fix 716e928; dispara solo si hay persona o contexto, con caps 2000/3000).
- `campaigns.fmN_example_reply` — ejemplo de tono para FM.
- `campaign_followups.message` — template del FU.
- ❌ **NO** se leen: `ai_example_messages`, `target_audience`, ni la tabla `message_templates` (código muerto).

Todos: post-proceso agnóstico de proveedor (truncado por oración, guard anti-placeholder `hasLeftoverPlaceholder`, cierre garantizado). Cadena `LLM_PROVIDERS` (`groq,gemini`).

---

## Estados posibles de un comando (`extension_commands.status`)
`pending` (en cola) → `completed` (ok) \| `error` (falló; `result.error` tiene el código). El bridge ingiere el resultado y actualiza el lead.

## Verificación / hard testing
No hay framework de tests. Para probar un agente de IA sin esperar el tick, se invoca su función directo en prod (read-only, sin dispatch): `node` script que importa `lib/supabase.js` (carga `.env`) + `lib/ai-message.js` y llama la función con datos reales. Ver `CLAUDE.md` §4 para el flujo de deploy/verificación.
