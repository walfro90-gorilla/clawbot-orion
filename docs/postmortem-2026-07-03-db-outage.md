# Post-mortem — Outage de DB Supabase (2026-07-03)

> Análisis verificado contra el código vivo por un barrido multi-agente (4 dimensiones).
> Estado: **producción recuperada**. Este doc = causa raíz + plan de endurecimiento priorizado.
> Regla: los cambios de código **se revisan antes de aplicar**. Aquí están *descritos*, no aplicados.

---

## 1. Resumen ejecutivo

El **camino de query** de la DB Supabase (PostgREST → pooler Supavisor → Postgres) quedó **wedged ~30–40 min**: toda query autenticada devolvía **Cloudflare 522 tras ~20s**. El plano de control siguió sano (`ACTIVE_HEALTHY`).

- **Causa raíz:** inanición de compute en el tier **Nano/Free** (Shared CPU, 0.5 GB RAM, IO baseline **43 Mbps** con burst de solo **30 min/día**) bajo una **tasa de peticiones sostenida ~16 req/s**, 24/7. El workload de **filas es diminuto** (686 leads, DB 40 MB) — el problema es **ritmo de round-trips**, no volumen de datos. El crédito de IO-burst se drenó toda la semana (gráfica 10%→60%) hasta agotarse → throughput cae a baseline → queries lentas → wedge.
- **Amplificadores** (impidieron la auto-recuperación): (a) el **scheduler apiló ticks zombie** que nunca se cancelan; (b) el **bridge siguió polleando cada 3s** sin backoff durante toda la caída; (c) **10 restarts** del scheduler, cada uno con un tick pesado inmediato al bootear.
- **Por qué nadie se enteró antes:** **todo el sistema de alerta está acoplado a la misma DB que se cayó**. Blind spot total. La degradación de una semana y el crash-loop corrieron invisibles.
- **Resolución:** paramos scheduler + bridge (quitar carga) → el usuario **reinició la DB** desde el dashboard → servicios de vuelta limpios. Verificado: primer tick completo y sano, 14/60 conexiones, 0 queries atascadas.

**La corrección que sola habría evitado el outage:** subir a **Pro + compute Small** (~$25–30/mo). Todo lo demás (código/config) es endurecimiento para que un slowdown transitorio **nunca** vuelva a cascar en apagón.

---

## 2. Timeline

| Momento | Evento |
|---|---|
| Toda la semana | IO-burst budget sube 10%→60%. Badge del proyecto: **"EXCEEDING USAGE LIMITS"**. Sin una sola alerta. |
| 03-jul (madrugada MX) | Burst agotado → throughput a baseline 43 Mbps → ticks del scheduler pasan de segundos a 10–15 min. |
| — | Ticks exceden el soft-timeout de 120s → quedan **huérfanos** (Promise.race no cancela) y se apilan. Bridge sigue en 3s. Pooler (máx 60 conns) satura → **522**. |
| — | Scheduler acumula **10 restarts**; cada boot dispara un tick pesado inmediato → re-martilleo. |
| Detección | Manual (SSH): `pm2 logs` mostró `Tick error: tick timeout 120000ms` ×10 + bridge con **522** de `cjbvutiugmehrhdnfeta.supabase.co`. |
| Mitigación | `pm2 stop prometheus-scheduler` + `pm2 stop extension-bridge` → quitar toda la carga. |
| Recuperación | Usuario reinicia DB (dashboard Supabase) → `execute_sql` responde al instante → bridge + scheduler de vuelta ↺0, tick limpio. |

---

## 3. Causa raíz — con la corrección de diagnóstico

### 3.1 Lo estructural (raíz)
Nano/Free no puede sostener automatización **continua**. Dos loops generan carga base **independiente de si hay trabajo**:
- **Bridge:** `pollAndDispatch` cada **3s** → ≥4 SELECTs/ciclo → **~115k queries/día** ([extension-bridge.js:33](../apps/prometheus/extension-bridge.js#L33)).
- **Scheduler tick:** fan-out de **~46 due-queries de FU/tick** (1 SELECT leads+conversations por cada step habilitado) + **cientos de lecturas de config sin caché** por ciclo ([scheduler-extension.js:529](../apps/prometheus/scheduler-extension.js#L529), [:53](../apps/prometheus/scheduler-extension.js#L53)).

Evidencia: **2498 llamadas** PostgREST `set_config` en 2.5 min post-restart ≈ **16 req/s** de piso. Cada query es sub-ms; el gasto es el **número de round-trips** sobre CPU compartida + IO-burst limitado.

> El ratio **WAL 220 MB vs DB 40 MB** es un *red herring*: se explica por `min_wal_size=128MB` (piso) + `wal_level=logical` (Realtime duplica WAL), **no** por write-churn patológico. Disco 0.42/8 GB. El recurso escaso es **IO throughput / CPU**, no disco.

### 3.2 La corrección honesta al mecanismo del amplificador
El diagnóstico inicial en caliente fue: *"query zombie rechaza → `unhandledRejection` → `process.exit(1)` → crash-loop"*. **El barrido de código lo refutó:**
- No hay `.throwOnError()` ni `.retry()` en todo el repo → postgrest-js resuelve cada 522/abort a **`{data:null, error}`**, **no lanza** ([postgrest-js/dist/index.cjs:234-275]).
- Aunque `tick()` rechazara tarde, `Promise.race` le mantiene un **reject-handler adjunto** → **no** sería `unhandledRejection`.
- **Ambos watchdogs quedan neutralizados** por los resets de `lastTickAt`/`tickInFlight` en el path de error → el auto-heal no dispara.

**Lo que realmente pasó:** el scheduler **se pudrió en silencio apilando ticks zombie** (no crash-loopeó por sus propios handlers). El mecanismo real de amplificación:

- `runTickSafely` hace `await withTimeout(tick(), 120s)` con un `Promise.race` que **no cancela nada** ([:2056](../apps/prometheus/scheduler-extension.js#L2056), [:137](../apps/prometheus/scheduler-extension.js#L137)).
- El `finally { tickInFlight = false }` corre cuando la **race** termina (120s), **no cuando `tick()` termina** (10–15 min bajo wedge) ([:2069](../apps/prometheus/scheduler-extension.js#L2069)).
- → el guard de reentrancia miente: al siguiente intervalo de 300s arranca **otro tick concurrente** mientras el anterior sigue disparando queries de 20s → **se apilan** y multiplican la carga contra el pooler wedged.

Los **10 restarts** reales (vistos en `pm2`) probablemente vinieron de **OOM / presión de memoria / una promesa flotante NO-DB** (p.ej. el `fetch` a getConnectedAccountIds contra el bridge saturado, que **sí** puede rechazar, a diferencia de postgrest) — **no** del path que narré. El `process.exit(1)` sin debounce de los handlers ([:2088-2095](../apps/prometheus/scheduler-extension.js#L2088)) sigue siendo un **footgun latente P1** (cualquier promesa flotante futura lo dispara), aunque no fue el gatillo de este día.

---

## 4. Los 4 amplificadores (por dimensión)

1. **Scheduler:** ticks zombie sin cancelación + cadencia fija sin backoff + tick inmediato en boot + watchdogs neutralizados. *Una DB lenta NO ralentiza al scheduler — debería.*
2. **Carga/Capacidad:** tier Nano sub-dimensionado + poll 3s (115k q/día) + fan-out FU por-step + config sin caché + `getEligiblePendingCount` trae `profile_data` JSON solo para contar.
3. **Observabilidad:** **todo canal de alerta depende de la DB caída**; el watchdog `heartbeat-check.js` se auto-derrota (lee scheduler_log / escribe account_alerts en la misma DB wedged); cero telemetría de infra; crash-loop invisible; alertas del código vivo **nunca** notifican por Slack.
4. **Bridge:** poll 3s con `setInterval` sin guardia de reentrada → **pile-up ~26 invocaciones concurrentes**; cliente Supabase **sin timeout** (sockets colgados ~20s, fuga de conexiones); **traga los errores** de query (ignora `error`) → ciego a "DB caída" y con riesgo de dispatch a cuenta pausada; sin circuit-breaker.

---

## 5. Plan de endurecimiento priorizado

> `kind`: infra (dinero/dashboard) · config (env, sin código) · code (revisar antes) · ops (PM2/cron).

### P0 — hacer ya (evitan la recurrencia)

| # | Fix | kind | Esfuerzo |
|---|-----|------|----------|
| 1 | **Pro + compute Small (2 vCPU, 2 GB)** — la corrección que sola habría evitado el outage | infra | S (resize ~2 min) |
| 2 | **Canal de alerta OUT-OF-BAND** (Slack/Telegram/ntfy) que **no toca Supabase**, con dedup en archivo local | code | S |
| 3 | **Contador de ticks lentos/timeout** (racha ≥3) → alerta out-of-band + `account_alerts` best-effort | code | S |
| 4 | **Bridge: circuit-breaker + backoff + loop auto-reprogramado** (setTimeout, no setInterval) + **timeout por query** (AbortController ~9s) | code | M |
| 5 | **Detección de crash-loop** (N boots en M min, contados en archivo local) + **jitter/backoff antes del 1er tick** | code | S |

### P1 — endurecimiento estructural

| # | Fix | kind | Esfuerzo |
|---|-----|------|----------|
| 6 | Bridge poll **3s→12s** + ping 20s→30–45s (−75% queries/día) | config | S |
| 7 | **Cancelación real del tick** vía AbortController propagado a las queries (mata los zombies de raíz) | code | M |
| 8 | **Backoff exponencial** ante ticks fallidos consecutivos (DB lenta → scheduler más lento) | code | M |
| 9 | **Caché TTL 60s** para `readRuntimeNumber`/`getAccountConfigRaw` (config casi estática) | code | S |
| 10 | Colapsar **fan-out FU por-step** en 1 query/campaña + sacar `readRuntimeNumber` del loop | code | M |
| 11 | Bridge: **chequear `error`** en las lecturas del poll + abortar ciclo (cierra el riesgo de dispatch a cuenta pausada) | code | S |
| 12 | **Watchdog externo DB-independiente** (`pm2 jlist` restart-count + `/health` del bridge → Slack) | ops | M |
| 13 | **Preflight de salud de DB** (`select 1` con timeout corto) en boot y antes de tick degradado | code | S |
| 14 | Panel **"Salud de Infra/DB"** en el monitor de Orion + arreglar `schedulerDead` (hoy solo MX 9–19 L-V) | code | M |
| 15 | **Heartbeat POSITIVO** por tick (upsert 1 fila `runtime_config`) para serie de liveness/latencia | code | S |

### P2 — pulido

`getEligiblePendingCount` sin traer JSON · guardar el guard de reentrancia con la finalización real del tick · arreglar watchdogs internos · PM2 `exp_backoff_restart_delay` + `max_restarts` en la config viva (+ `pm2 save`) · cron que consulte cuota/advisors Supabase y alerte "EXCEEDING USAGE LIMITS" **antes** del wedge · `.retry(false)` en SELECTs del hot-loop · handler SIGTERM/SIGINT limpio en el bridge · cablear código vivo por `createAlert`/`notifySlack`.

---

## 6. La decisión que importa: compute

| Opción | Costo | Veredicto |
|---|---|---|
| **Pro + Small** (2 núcleos dedicados, 2 GB) | ~$25–30/mo | ✅ **Recomendado.** Absorbe la carga actual trivialmente; margen de RAM para scheduler+bridge+Gemini+Next+Realtime. Quita auto-pause y topes de Free. Da PITR 7d. |
| **Pro + Micro** (2 núcleos, 1 GB) | ~$10–25/mo | Piso aceptable; menos margen de RAM. |
| **Quedarse en Free/Nano + solo fixes de código** | $0 | Reduce el riesgo (−75% queries con P0/P1) pero **no elimina** la fragilidad estructural de CPU compartida + burst 30 min/día. |

> En **Free NO se puede cambiar compute** (requiere Pro) y Free **auto-pausa** + tiene topes duros. Para un producto de ingresos con automatización continua, Nano/Free es inadecuado por diseño.

---

## 7. Principio rector

**"Una DB lenta debe hacer al sistema ir más lento, no más rápido."** Hoy es al revés: bajo starvation, scheduler y bridge **mantienen o suben** su carga (ticks apilados + poll fijo + boot-tick inmediato), martillando la DB e impidiendo que respire. Los fixes P0/P1 invierten eso: cancelación real, backoff, circuit-breaker, y **alerta que no depende de la cosa que se cae**.
