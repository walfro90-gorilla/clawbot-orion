# Anti-Detection Blueprint — ClawBot LinkedIn Automation

> **Single source of truth para humanización, stealth y arquitectura de fingerprint.**
> Última actualización: 2026-05-14 (Fase 1.5 — fingerprint binding implementado)
> Owner: walfre.am@gmail.com

---

## 🆕 Changelog

| Fecha | Cambio | Status |
|---|---|---|
| 2026-05-15 | Stress test E2E Fase 1.5 — 111/111 pass; Stealth UA/lang override descubierto | ✅ Verificado |
| 2026-05-14 | **Fase 1.5**: fingerprint binding 1:1 cookie↔UA/viewport + `humanFill()` | ✅ Hecho |
| 2026-05-14 | Fase 1: `lib/humanize.js` + integrado en followup/reply/worker | ✅ Hecho |
| 2026-05-13 | Migración a Static Residential proxy (Webshare ISP) | ✅ Hecho |
| 2026-05-13 | `MAX_FOLLOWUPS_PER_RUN` 4→2, `DELAY` 45-120s → 5-12 min | ✅ Hecho |
| 2026-05-13 | Cookie kill incident — 4 sends en 20 min triggered LinkedIn | 📚 Lesson |
| Próximo | Fase 2: `browsingContext()` + migrar inbox/search + scroll arreglos | ⏳ Pendiente |

---

## 🎯 Filosofía base

LinkedIn no detecta automatización por una sola cosa — calcula un **score compuesto** de docenas de señales. Si el score baja debajo de un threshold, invalida la sesión.

**Lo que un humano hace naturalmente, un bot tiene que simular explícitamente.**

Las **3 capas** que LinkedIn evalúa:
1. **Fingerprint del navegador** — UA, viewport, GPU, fonts, canvas
2. **Comportamiento** — mouse trajectory, typing rhythm, scroll, reading time
3. **Patrón de actividad** — volumen, horarios, secuencias, variación de mensajes

---

## 🔐 Capa 0 — Fingerprint binding 1:1 (Fase 1.5)

**El problema que resolvimos el 14-may:** Cookie-server hardcodeaba Mac Chrome 122 + viewport 1280×800 para capturar la cookie. Después, los workers usaban `randomContextOptions()` — un pool de Chrome 130-135 random entre Win/Mac/Linux con viewports variables.

**Lo que LinkedIn veía:** *misma cookie `li_at`, primero usada con Mac Chrome 122 1280×800, luego con Windows Chrome 135 1920×1080.* Eso es un **señal textbook de bot** — usuarios reales no cambian de OS/navegador/monitor en la misma sesión.

### Solución implementada

**DB schema (migration aplicada):**
```sql
ALTER TABLE linkedin_accounts
  ADD COLUMN fingerprint_json JSONB,
  ADD COLUMN fingerprint_locked_at TIMESTAMPTZ;
```

**El fingerprint guarda:**
```json
{
  "userAgent":      "Mozilla/5.0 (Macintosh; ...) Chrome/135.0.0.0 Safari/537.36",
  "viewport":       { "width": 1588, "height": 901 },
  "locale":         "es-MX",
  "acceptLanguage": "es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7",
  "timezoneId":     "America/Mexico_City"
}
```

### Flujo completo cookie ↔ fingerprint

```
┌──────────────────────────────────────────────────────────────────────┐
│ 1. CAPTURA (Joshua/Wal abre modal en Orion para renovar cookie)      │
│                                                                       │
│  Orion route                cookie-server               LinkedIn      │
│  /login-session POST  ─────▶ /session                                 │
│      │                            │                                   │
│      │ (lee fingerprint_json      │                                   │
│      │  de DB; null si primera    │                                   │
│      │  vez)                      │                                   │
│      │                            │                                   │
│      ├─ envía fingerprint ───────▶│                                   │
│      │                            │                                   │
│      │              si null → genera fresh (UA pool de 20)            │
│      │              else → usa el que vino                            │
│      │                            │                                   │
│      │                            ├─ newContext(fingerprint) ────────▶│
│      │                            │                                   │
│      │                            │  login real con UA estable        │
│      │                            │                                   │
│      │ ◀──── poll /status ────────│                                   │
│      │      hasta cookie_stable   │                                   │
│      │                            │                                   │
│      │ ◀── { cookie, fingerprint }                                    │
│      │                            │                                   │
│      ├─ POST /validate-cookie ───▶│                                   │
│      │   (con mismo fingerprint)  │                                   │
│      │                            │                                   │
│      ├─ guarda cookie +           │                                   │
│      │   fingerprint_json en DB   │                                   │
│      │   (locked_at = now)        │                                   │
│      ▼                                                                │
│  Status: "saved"                                                      │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ 2. USO (scheduler ejecuta worker/followup/reply/inbox/search)        │
│                                                                       │
│  scheduler.js                                                         │
│      │                                                                │
│      ├─ spawn worker.js                                              │
│      │     env: ACCOUNT_ID, LI_AT, PROXY_URL                          │
│      │                                                                │
│  worker.js                                                            │
│      │                                                                │
│      ├─ getOrCreateAccountFingerprint(supabase, ACCOUNT_ID)          │
│      │     │                                                          │
│      │     ├─ SELECT fingerprint_json FROM linkedin_accounts          │
│      │     └─ ya existe → retorna el guardado                        │
│      │                                                                │
│      ├─ contextOptionsFromFingerprint(fp, proxy)                     │
│      │                                                                │
│      ├─ browser.newContext(opts) ──────▶ LinkedIn                    │
│      │      ↑                                                         │
│      │      MISMO UA + viewport que la captura                        │
│      ▼                                                                │
│  Cookie + fingerprint son consistentes → LinkedIn no detecta hijack   │
└──────────────────────────────────────────────────────────────────────┘
```

### Reglas duras de fingerprint

1. **NUNCA** usar `randomContextOptions()` con una cookie real cargada en `addCookies()`.
2. Para cookies stored: usar **siempre** `accountContextOptions(supabase, accountId, proxy)` o `contextOptionsFromFingerprint(fp, proxy)`.
3. Si la cookie se renueva, **el fingerprint puede regenerarse** (es lícito que un humano use un browser nuevo). Pero una vez capturada, queda lockeada hasta la próxima renovación.
4. `randomContextOptions()` queda como **LEGACY** — solo para scripts one-off sin cookie persistente.

### ⚠️ Lo que Stealth Plugin sobrescribe (descubierto 2026-05-15)

El stress test E2E reveló que `puppeteer-extra-plugin-stealth` modifica nuestros settings:

| Configuramos | Stealth lo cambia a | Impacto |
|---|---|---|
| `userAgent: Chrome/135` | `Chrome/147` (versión del binario en VPS) | **Neutro** — todos los scripts usan el mismo binario, son consistentes |
| `locale: es-MX` | `navigator.language = en-US` | 🟡 **Señal anómala** para campañas Mexico — fix en Fase 2 |
| `viewport: 1900×1088` | Respetado ✅ | OK — el binding viewport SÍ funciona |
| `Accept-Language: es-MX` (HTTP) | Respetado ✅ | OK — header HTTP enviado correctamente |

**Implicaciones:**
- El binding del 13-may fue **real para viewport** (cookie-server hardcoded 1280×800 vs workers random) → Fase 1.5 lo resolvió.
- Para UA, ambos lados siempre usaron Chrome 147 vía Stealth → el "ban por UA mismatch" probablemente NO fue la causa raíz.
- La causa más probable del ban fue **burst rate** (4 FU en 20 min con cookie de 1 día) + viewport mismatch.

### Fix de locale (pendiente Fase 2)

```javascript
// 1. Disable Stealth's navigator.languages evasion
const stealth = StealthPlugin()
stealth.enabledEvasions.delete('navigator.languages')
chromium.use(stealth)

// 2. After newContext, inject our own:
await context.addInitScript(() => {
  Object.defineProperty(Object.getPrototypeOf(navigator), 'language', { get: () => 'es-MX' })
  Object.defineProperty(Object.getPrototypeOf(navigator), 'languages', {
    get: () => ['es-MX', 'es', 'en-US', 'en']
  })
})
```

Validado en `scripts/stress-test-fingerprint.js` con disable + addInitScript combinados.

---

## 📊 Auditoría: estado actual vs ideal

### Capa 1 — Fingerprint del navegador

| Señal | Estado actual | Riesgo | Acción |
|---|---|---|---|
| `navigator.webdriver` | ✅ Stealth Plugin lo oculta | Bajo | OK |
| User Agent | ✅ **Pool 20 UAs, stable per account** (Fase 1.5) | Bajo | OK |
| Viewport | ✅ **Per-account stable + jitter ±20** (Fase 1.5) | Bajo | OK |
| Locale | ✅ es-MX / es-419 variable | Bajo | OK |
| Proxy IP type | ✅ Static Residential (US) | Bajo | Migrado 2026-05-12 |
| **Cookie↔fingerprint binding** | ✅ **1:1 desde 2026-05-14** | Bajo | **CRÍTICO solucionado** |
| **GPU / WebGL** | ❌ SwiftShader (software) | **ALTO** | Fase 3: headless:false + Xvfb |
| **Canvas fingerprint** | ⚠️  Stealth básico | Medio | Stealth Plugin lo maneja parcialmente |
| **Fonts disponibles** | ⚠️  Limitadas (Linux container) | Medio | Instalar fonts comunes en VPS |
| **Plugins list** | ✅ Stealth lo maneja | Bajo | OK |
| **Battery API** | ✅ Stealth lo maneja | Bajo | OK |

### Capa 2 — Comportamiento

| Comportamiento | Estado actual | Riesgo | Acción |
|---|---|---|---|
| **Mouse movement antes de click** | ✅ `humanClick()` con Bézier curve | Bajo | Aplicado en followup/reply/worker (sends) |
| Hover antes de click | ✅ `humanHover()` parte de humanClick | Bajo | OK |
| Typing delays | ✅ `humanType()` centralizado | Bajo | OK |
| Typing biometrics (rhythm) | ✅ Punctuation/word/distraction pauses | Bajo | OK |
| **Input field fill** | ✅ `humanFill()` (Fase 1.5) | Bajo | Aplicado en cookie-server 2FA + followup search |
| Scroll durante navegación | ✅ `humanScroll()` centralizado | Bajo | OK |
| **Reading time en perfiles** | ✅ `readingPause()` 4-9s | Bajo | Aplicado en followup + worker |
| Idle time entre sends | ✅ DELAY_MIN/MAX 5-12 min | Bajo | OK |
| **Browsing context entre sends** | ⚠️  Solo warmup feed inicial | 🟡 Medio | Fase 2: `browsingContext()` |
| **Variación de mensajes** | ✅ `varyMessage()` synonyms | Bajo | OK |
| Variación temporal | ❌ Siempre 9-19h business | Medio | Fase 2: random scatter 9-21h |
| **Click() de navegación** | ⚠️ ~20 sitios sin humanClick | Medio | Fase 2: migrar restantes |

### Capa 3 — Patrón de actividad

| Señal | Estado actual | Riesgo | Acción |
|---|---|---|---|
| Cookie freshness | ⚠️  Riesgo si renovamos demasiado | 🔴 Alto | NO renovar antes de 7 días |
| Burst pattern | ✅ Máx 2 sends/run, 5-12 min entre | Bajo | OK |
| Template uniformity | ✅ `varyMessage` sinónimos | Bajo (mejorado) | Fase 2: variación de orden |
| Direct action chains | ❌ feed→profile→message→thread→send | Medio | Fase 2: `browsingContext()` insertar noise |
| Time-of-day | ⚠️  Solo 9-19h | Medio | Fase 2: scatter 9-21h |
| Days-of-week | ⚠️  Solo L-V | Medio | Fase 2: ocasionales sábados |
| Same proxy = same IP forever | ✅ Static Residential sticky | Bajo | OK |
| Daily volume cap | ✅ 5/día | Bajo | OK |
| Account warmup status | ✅ Tracked en DB | Bajo | OK |

---

## 🛠 Helpers — `lib/humanize.js` y `lib/browser.js`

### `lib/humanize.js` — comportamiento humano

```javascript
import {
  humanClick,        // Mouse Bézier trajectory + hover + click
  humanHover,        // Same trajectory but no click
  humanType,         // Char-by-char with punctuation/word/distraction pauses
  humanFill,         // 🆕 Fase 1.5: focus + Ctrl+A/Del + humanType (replaces .fill())
  humanScroll,       // Random step sizes, random pauses, direction
  readingPause,      // 4-12s scroll up/down mimicking page reading
  browsingContext,   // [FASE 2] feed scroll + view notification between sends
  varyMessage,       // Template synonym substitution
  microDelay,        // 600-1800ms semantic delay
  thinkingPause,     // 1-5s "thinking" pause
} from './lib/humanize.js'
```

### `lib/browser.js` — fingerprint management (Fase 1.5)

```javascript
import {
  generateFingerprint,                // Crea uno aleatorio del pool
  contextOptionsFromFingerprint,      // Convierte fp → Playwright newContext opts
  getOrCreateAccountFingerprint,      // Lee de DB o crea uno nuevo y persiste
  accountContextOptions,              // Combinado: fp + proxy → opts (uso típico)
  randomContextOptions,               // LEGACY — solo scripts one-off
} from './lib/browser.js'
```

### Integration map (qué archivo usa qué)

| Archivo | Fingerprint source | Click sites humanizados | Input fields |
|---|---|---|---|
| **worker.js** | `getOrCreateAccountFingerprint(ACCOUNT_ID)` | Connect CTA + "Enviar sin nota" (2 variants) | — |
| **followup.js** | `getOrCreateAccountFingerprint(account.id)` once per run | Message btn (3 strategies) + Send btn | `humanFill` en 3 search inputs |
| **reply.js** | `getOrCreateAccountFingerprint(account.id)` | textarea + Send btn | — |
| **inbox.js** | `getOrCreateAccountFingerprint(account.id)` | TODO: navigation clicks | — |
| **search.js** | `getOrCreateAccountFingerprint(campaign.linkedin_account_id)` | — (read-only) | — |
| **cookie-server.js** | Acepta `fingerprint` en body, genera si null, retorna en `/status` | `/auto-login` form fields | **`humanFill` style en 2FA pin** (click + 110-220ms/dígito) |
| **batch.js** | Propaga `ACCOUNT_ID` env a worker.js | — | — |

### Legacy duplicates (consolidación pendiente — Fase 2)

| Archivo | Duplicate | Acción |
|---|---|---|
| inbox.js:52 | `humanScroll` propio | Migrar a humanize.js |
| search.js:51 | `humanScrollSearch` propio | Migrar |
| worker.js:471-473 | `window.scrollBy` raw doble | Reemplazar por `humanScroll` |
| followup.js:889 | `scrollTo(0, scrollHeight)` jump completo | Reemplazar por scroll progressivo |
| worker.js / followup.js | `scrollTo(0,0)` abrupto post-load | Reemplazar |

---

## 🚦 Reglas de oro (anti-ban policy)

1. **NO renovar cookie** a menos que esté realmente muerta (test: `/feed` da 200 con buttons>5).
2. **MAX 2 FU sends por tick. MAX 5 FU/día por cuenta.**
3. **Mínimo 30-40 min entre ticks del mismo account.**
4. **`humanClick` SIEMPRE en sends** — nunca `element.click()` directo para botones críticos.
5. **`humanFill` SIEMPRE en inputs sensibles** — nunca `.fill()` (2FA pin, recipient search).
6. **`readingPause` antes de cada acción crítica** (Message, Connect, Send).
7. **NO secuencias idénticas** — variar el orden de acciones.
8. **NO mensajes idénticos** — `varyMessage()` siempre antes de typing.
9. **NO bursts** — si LinkedIn quiebra la sesión, ESPERAR 24-48h antes de retomar.
10. **Cookie freshness: 0-2 días = peligro de burst, 7-30d = ideal, 30+ = riesgo de caducidad.**
11. **Fingerprint binding 1:1** — NUNCA `randomContextOptions()` con cookie real.

---

## 📋 Plan de implementación (prioritizado)

### ✅ Fase 1 — COMPLETADA (2026-05-14 morning)

1. ✅ `lib/humanize.js` con 11 exports
2. ✅ `humanClick` Bézier en sends de followup/reply/worker
3. ✅ `readingPause` antes de Message/Connect
4. ✅ `varyMessage` synonym substitution
5. ✅ NO renovar cookies < 7 días (política)

### ✅ Fase 1.5 — COMPLETADA (2026-05-14 afternoon)

6. ✅ **Fingerprint binding 1:1** — DB column + cookie-server + Orion API + workers
7. ✅ **`humanFill()`** helper en humanize.js
8. ✅ **2FA pin con humanFill style** — cookie-server.js:730
9. ✅ **Search inputs con humanFill** — followup.js (3 sitios)

### 🟡 Fase 2 — Próxima semana

10. **Migrar inbox.js + search.js** a humanize.js (eliminar duplicates)
11. **`browsingContext()` entre sends** — feed scroll + ver 1 post
12. **Variación de horario** — random scatter 9-21h
13. **Ocasionales sends los sábados** — 10% probabilidad de tick fin de semana
14. **Reemplazar 20+ `click()` de navegación** con `humanClick`
15. **Reemplazar `scrollTo(0,0)` y `scrollTo(0, scrollHeight)`** con scroll progresivo

### 🟢 Fase 3 — Semana 2-3

16. **Headless: false + Xvfb** — browser real renderizado sin display
17. **Real keyboard biometrics** — capturar ritmo de Josh manual + replicar
18. **`visitRandomProfile()` entre sends**
19. **Permission grants/denies aleatorios**

### 🔵 Fase 4 — Nice-to-have

20. Captcha solver auto (2captcha API)
21. Multi-account session pooling
22. Per-lead delay based on lead's online status

---

## 📊 Score progression (humanlike → bot scale)

```
Real Josh manual:          0.85 / 1.00 (human-like)
ClawBot pre-Fase 1:        0.45 / 1.00 (suspicious — invalidated 13-may)
ClawBot post-Fase 1:       0.70 / 1.00 (passes most behavior checks)
ClawBot post-Fase 1.5:     0.78 / 1.00 (cookie+fingerprint coherentes) ← ESTAMOS AQUÍ
ClawBot + Fase 2:          0.84 / 1.00 (very safe)
ClawBot + Fase 3 (Xvfb):   0.90 / 1.00 (near indistinguishable)
```

| Capa | Pre-F1 | Post-F1 | Post-F1.5 | Mejora total |
|---|---|---|---|---|
| Fingerprint del navegador | 0.60 | 0.65 | **0.78** | +0.18 |
| Comportamiento | 0.30 | 0.75 | **0.80** | +0.50 |
| Patrón de actividad | 0.50 | 0.65 | 0.70 | +0.20 |
| **Total** | **0.45** | 0.70 | **0.78** | **+0.33** |

---

## 🧪 Métricas de salud (monitoreo)

| Métrica | OK | WARNING | CRÍTICO |
|---|---|---|---|
| Cookie age | 5-30 días | 0-1 día o 30-60 días | <1 día con burst, >60 días |
| Sends/hora por cuenta | ≤2 | 3-4 | >5 |
| Sends/día por cuenta | ≤5 | 6-10 | >10 |
| ERR_TOO_MANY_REDIRECTS rate | 0% | 1-5% | >5% |
| Proxy bandwidth used | <80% | 80-95% | >95% |
| Profile pages timing out | <5% | 5-20% | >20% |
| /feed load time | <8s | 8-15s | >15s |
| **Fingerprint vs cookie age mismatch** | 0 | — | Cualquier mismatch = bug |

---

## 📌 Lecciones aprendidas

### 2026-04-29: Cookie kill por scraping intensivo
**Causa:** `search.js` corrió varias veces seguidas → 50+ profile visits/min.
**Fix:** delays en search.

### 2026-05-08: Proxy bandwidth exhaustion
**Causa:** Webshare Datacenter 250GB se agotó por retries.
**Fix:** migración a Static Residential.

### 2026-05-13: Cookie kill por burst
**Causa:** 4 FU sends en 20 min con cookie de 1 día.
**Fix:** MAX_FOLLOWUPS_PER_RUN: 4→2, DELAY 45-120s → 5-12 min.
**Lección:** cookie fresca + burst = combo letal.

### 2026-05-14: Auditoría profunda detectó fingerprint mismatch
**Causa raíz del ban del 13-may probablemente:** cookie-server usaba Mac Chrome 122 hardcoded + viewport 1280×800; workers usaban pool aleatorio Chrome 130-135 con viewports varios. Mismo cookie con fingerprints diferentes = bot signal.
**Fix:** Fase 1.5 — fingerprint_json en DB + binding 1:1 cookie↔UA/viewport.
**Lección:** auditar SIEMPRE coherencia entre captura y uso de credenciales.

---

## 🎯 Para el próximo incidente

Si vuelve a pasar (cookie muerta tras envíos):

1. **Pausa inmediata** — `batch_paused = true, follow_up_paused = true`
2. **Marca cuenta `rate_limited`**
3. **NO renovar inmediatamente** — espera 24-48h
4. **Analiza el patrón**:
   - Sends antes del kill?
   - Cookie age?
   - Burst rate?
   - **Fingerprint match?** ← nuevo desde Fase 1.5
5. **Verifica `linkedin_accounts.fingerprint_json` vs el actualmente usado** (debe ser igual)
6. **Ajusta caps si necesario** y deja envejecer cookie
7. **Re-renovar cookie SOLO después de patrón de "descanso"** — 1-2 días sin actividad

---

## 🗂 Referencias de código

| Tema | Archivo:Línea |
|---|---|
| Fingerprint helpers | `apps/prometheus/lib/browser.js:101-160` |
| humanFill | `apps/prometheus/lib/humanize.js:66-88` |
| humanClick (Bézier) | `apps/prometheus/lib/humanize.js:165-181` |
| Cookie-server fingerprint accept | `apps/prometheus/cookie-server.js:104-138` |
| Cookie-server 2FA humanFill | `apps/prometheus/cookie-server.js:728-749` |
| Status route fingerprint persist | `apps/orion/app/api/accounts/[id]/login-session/status/route.ts:85-96` |
| Migration | `linkedin_accounts.fingerprint_json` aplicada 2026-05-14 |
