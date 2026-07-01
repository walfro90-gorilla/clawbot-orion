# Cómo funcionan los Follow-ups (ground truth verificado)

> Verificado contra el código vivo el **2026-07-01** (raíz del bug shadow DOM + gates de elegibilidad).
> Si algo aquí contradice el código, **gana el código** — pero esto existe para **no re-suponer** lo ya investigado.
> Archivos clave: `apps/prometheus/scheduler-extension.js` (orquestador) · `apps/orion-extension/content.js` (ejecución) · `apps/prometheus/extension-bridge.js` (dispatch + ingest).

---

## 1. Dos rutas de composer (CRÍTICO — origen del ~82% de FU fallidos)

Cuando el scheduler decide un FU, el `navUrl` depende de si el lead tiene thread previo (`scheduler-extension.js`, ~742):

| Caso | URL | Composer | DOM |
|------|-----|----------|-----|
| Lead **con** thread (respondió, o invite con nota) | `…/messaging/thread/<id>/` | del thread | **DOM ligero** ✅ |
| Lead **sin** thread (invite sin nota, aceptado; primer FU) | perfil → botón "Mensaje" → overlay `…/messaging/compose/?…interop=msgOverlay` | overlay "Nuevo mensaje" | **SHADOW DOM** ⚠️ |

- El `thread_id` sale del JOIN a `conversations` (`conversations.linkedin_thread_id`), **NO de una columna en `leads`** (la tabla `leads` no tiene `linkedin_thread_id`).
- **El composer del overlay vive en un SHADOW ROOT** (`path top>shadow[div]`). Es literalmente `<div contenteditable="true" class="msg-form__contenteditable" role="textbox">`, pero encapsulado → `document.querySelector()` **NO lo alcanza**.

### El bug (pre-0.9.8)
Los selectores de `content.js` usaban `document.querySelector` (no perforan shadow DOM) → en la ruta overlay nunca encontraban el composer → `humanType` tecleaba en la nada → la µ-fase `typing_complete` leía vacío → **timeout de 15s** (`micro_phase_typing_complete_timeout_XXXms`). Los FU por thread (DOM ligero) siempre funcionaron; los por overlay (shadow) siempre fallaban.

### El fix (0.9.8)
Helpers que **perforan shadow DOM** en `content.js` (~4132):
```js
function deepQueryAll(selector, root = document) { /* recorre shadow roots recursivamente */ }
function deepQuery(selector, root = document) { return deepQueryAll(selector, root)[0] || null }
```
Aplicados en: adquisición del editor (`send_followup` ~3180 + `sendFollowupFromProfile` ~3890), `liveEditor` (~3462), `findThreadSendButton(editor)` (~4187, ahora recibe el editor y busca dentro de su shadow root), `readThreadHeader` (~4132).

Regla: **cualquier consulta al composer/thread/botón Enviar en la ruta FU debe usar `deepQuery*`, no `document.querySelector`.**

Validación (01-jul): snippet con la lógica de 0.9.8 sobre el overlay real 1er grado → `✅ ENCUENTRA el composer` con el texto tecleado. En vivo → 0 `typing_complete_timeout`; los 2do-grado abortan rápido (`lead_not_first_degree`) en vez de colgarse.

---

## 2. ¿Cuándo un lead es "due" para su próximo FU?

Query de candidatos: `scheduler-extension.js` ~577-594. El loop itera `stepNum` (1..20) y por cada step consulta:

```
followup_step = stepNum - 1        (progreso del lead; el próximo paso es stepNum)
status IN (safeStatusFrom)         (connected, follow_up_sent, … — NUNCA awaiting_response)
automation_paused = false          (pausa por-contacto v0.8)
prevTimeField <  cutoffIso         (ya pasó el delay del step, con margen de jitter)
prevTimeField >= tooOldIso         (NO más viejo que fu_max_age_days, default 30 días)
linkedin_url IS NOT NULL
quarantined_at IS NULL             (⚠️ excluye leads en cuarentena)
cooldown_until IS NULL OR < now()  (⚠️ excluye leads en cooldown)
ORDER BY consecutive_failures ASC, last_attempt_at ASC NULLS FIRST
LIMIT 3                            (máx 3 candidatos por step por tick)
```

- **`prevTimeField`** = `connected_at` si `followup_step = 0`; si no, `last_followup_at`.
- **Delay por step**: de `campaign_followups (step, delay_value, delay_unit, enabled)` — 1..20 pasos. Ej. actual de Josh: step1 = 1h, step2 = 15h, step3 = 2d, … step20 = 40d.
- **Jitter por lead** (~610): offset determinístico por hash del `lead.id` dentro de `±follow_up_jitter_hours` → cada lead tiene su propio corte exacto.
- **`auto_dead_after_days`** (~599): si `prevTime` es más viejo que X días → el lead se marca `dead` (`auto_dead_no_reply`).
- El FU dispatcha **1 lead por campaña por tick** (`return` tras el primer dispatch exitoso, ~861). Si el loop no dispatcha nada → `no_followups_due`.

---

## 3. Gates POR-LEAD tras la selección (pueden saltar un lead ya elegido)

En orden, dentro del loop (`scheduler-extension.js`):
1. **Placeholder guard** (~715): si el mensaje trae `{nombre}`/`[algo]` sin resolver → skip (no envía basura).
2. **Content-dedup 4h** (~754): si el MISMO texto se envió a este lead en 4h → asume enviado, **avanza status** (`content_dedup`).
3. **Lockout no-respuesta 24h** (~772-828): cuenta comandos `send_followup` fallidos en 24h **SOLO** con estos códigos:
   - `extension_did_not_respond`, `content_died_mid_work`, `thread_not_found_in_inbox`, o `exec_hard_timeout_send_followup_%`.
   - ⚠️ **NO incluye `micro_phase_typing_complete_timeout`** ni `content_unreachable` (infra, no culpa del lead).
   - Si hay ≥1 → skip 24h + `lockout_skip_count++`; tras `dead_after_lockouts` (default 3) → `dead` (`lockout_dead_no_thread`).
4. **Step-dedup 48h** (~836): si hay un `send_followup` mismo `(lead, step)` con status `pending|dispatched|completed` en 48h → skip. **Los `error`/`timeout` NO cuentan** para este dedup.

---

## 4. Campos que BLOQUEAN un FU aunque el lead parezca "vencido"

> Tabla anti-suposición. Un lead días-vencido puede NO recibir FU por **cualquiera** de estos:

| Campo / condición | Efecto | Lo pone… |
|---|---|---|
| `linkedin_accounts.extension_paused = true` | la cuenta entera se salta (gate `extension_paused_by_user`) | popup / dashboard (manual) |
| `leads.quarantined_at` != null | excluido de la query de candidatos | sweep de fallos (a los 5) |
| `leads.cooldown_until` > now() | excluido de la query de candidatos | handler de fallo por-lead |
| `leads.automation_paused = true` | excluido de la query (pausa por-contacto) | admin (manual) |
| `prevTime` > `fu_max_age_days` (30d) | excluido por viejo | edad natural |
| lockout 24h (códigos §3.3) | skip + escala a dead | fallos infra/thread |
| step-dedup 48h | skip | cmd previo pending/dispatched/completed |
| `min_batch_gap_min` (campaña) | `batch_gap_not_met` | gap anti-ban entre batches |

### Recuperar un lead atascado por fallos (CORRECTO)
Resetear `consecutive_failures` **NO alcanza**. Hay que limpiar los 4:
```sql
update leads set consecutive_failures = 0, cooldown_until = null,
                 quarantined_at = null, lockout_skip_count = 0
where id = '<lead_id>';
```
> ⚠️ Lección 01-jul: supuse (mal) que el bloqueo era el "lockout", luego "cuarentena" — el real era **`cooldown_until` en el futuro**. Por eso están los 4 juntos.

---

## 5. Ciclo de vida del comando (`extension_commands`)

`pending` → `dispatched` → `completed` | `error` | `timeout`

- El bridge hace poll de `pending` de cuentas conectadas y despacha por WebSocket; la extensión reporta `command_result`.
- ⚠️ Un comando con `status='completed'` **puede** tener `error != null` (devolvió `result` con código de error). Para tasa de fallo real, filtrar por `status IN (error,timeout) OR (status=completed AND error IS NOT NULL)`.
- Las cuentas pausadas se saltan en el dispatch (`🛑 Cuentas paused (skip dispatch)`).

---

## 6. Taxonomía de resultados de `send_followup`

| status / error | Significado | ¿Correcto? |
|---|---|---|
| `sent_confirmed` | enviado + mensaje visto en el thread | ✅ |
| `sent_unconfirmed` | editor se vació pero no se confirmó en DOM → el bridge lo trata como enviado | ✅ (ojo: puede ser falso-positivo si un método sintético vacía sin enviar — backlog) |
| `already_responded` | el último msg del thread ya es nuestro (pre-send guard) → no duplica | ✅ |
| `awaiting_response` | LinkedIn aplicó ban-window (composer/send disabled) → no gasta retry | ✅ |
| `lead_not_first_degree` | 2do grado / sin composer → aborta sin mensajear | ✅ |
| `recipient_mismatch` | el typeahead no coincide con el nombre del lead → aborta (seguridad 0.9.5) | ✅ (no mensajea al equivocado) |
| `thread_editor_not_found` | no encontró composer (ni en shadow DOM) | ⚠️ investigar |
| `thread_header_mismatch` | el header del thread no es el lead esperado | ⚠️ |
| `send_method_exhausted` | ningún método de envío (humanClick/ctrl_enter/plain_enter/form_submit) vació el editor | ⚠️ |
| `micro_phase_typing_complete_timeout_*` | **el bug shadow DOM (pre-0.9.8)** — no debería reaparecer | ❌ si aparece, el fix falló para algún caso |

---

## 7. Pausa de cuenta — TRES causas (¡`extension_paused_by_user` NO prueba que sea humano!)

`extension_paused = true` puede venir de:
1. **Manual** — toggle del popup / dashboard (`app/api/extension/pause-toggle/route.ts`). Setea `extension_paused_reason`.
2. **Auto-pausa temporal** — `extension_paused_until` con timestamp (expira sola).
3. **⚠️ CIRCUIT BREAKER de cuenta (Capa 2)** — `lib/extension-dispatch.js` (~333-381) auto-pausa cuando **≥60% de comandos en 30min son "account-fault", de ≥3 leads distintos** (`windowMin=30, minCommands=5, errorThresholdPct=60, MIN_DISTINCT_LEADS_FOR_PAUSE=3`). **Setea `extension_paused=true` SIN `extension_paused_until` ni `extension_paused_reason`** → parece manual pero NO lo es. Crea alerta `account_alerts.alert_type='error_spike'`.

> ⚠️ **El gate log `extension_paused_by_user` es una etiqueta GENÉRICA del scheduler cuando `extension_paused=true` — NO es evidencia de un humano.** Josh fue auto-pausado **8×** por el circuit breaker (spike de `typing_complete_timeout` del bug shadow DOM) y se leyó como "pausa manual" durante días. **Para la causa REAL:** revisar `account_alerts` (`error_spike`) + `extension_paused_reason`, no el label del gate.

**Qué cuenta como "account-fault" para el breaker** (`extension-dispatch.js:333`): NO cuenta `LEAD_FAULT_ERRORS` (2do grado…), `PAGE_RENDER_ERRORS` (UI race), infra transitoria, **ni timeouts de µ-fase** (`micro_phase_*_timeout` — excluidos en el fix del 01-jul). SÍ cuenta: captcha, authwall, rate_limited, timeouts puros sin contexto.

El popup (0.9.7) muestra el toggle **arriba**: verde=activo, **rojo parpadeante=pausado**.

---

## 8. Gotchas confirmados (no suponer)

- **`daily_activity.errors = 0` NO significa "0 fallos de FU"** — los fallos a nivel comando **no** se cuentan ahí. Para la tasa real: agrupar `extension_commands` por `action, status` (así se descubrió el 82% de FU fallidos oculto).
- La tabla **`leads` NO tiene**: `linkedin_thread_id` (está en `conversations`), `updated_at`, `disqualified`, `in_quarantine`. Cuarentena = **`quarantined_at`** (timestamp).
- **`account_alerts` NO tiene `account_id`** (usa otra columna FK) — verificar el nombre antes de filtrar.
- La campaña de Josh (`linkedin_account_id=2ea4a7f2-…`) tiene **20 pasos de FU** todos `enabled`.
- El scheduler dispatcha **1 FU por campaña por tick** y ordena por `consecutive_failures ASC` → los leads limpios van primero.
- El scheduler corre `runTickSafely()` **inmediato al arrancar** (`~2082`) → `pm2 restart prometheus-scheduler` fuerza un tick ya.
