# ClawBot — Evolución (huella histórica)

> Timeline de cómo evolucionó la arquitectura. Fechas derivadas del git log.
> Para regenerar/extender: `git log --date=short --pretty=format:'%ad | %s'`.
> Última actualización: 2026-06-27 · 49 commits · `2026-04-12` → `2026-06-27`.

El producto pasó por **3 eras**. La inflexión clave fue el pivote **Playwright headless → extensión Chrome (Smart Hybrid)** por el problema del multi-IP ban.

---

## Era 1 — Playwright / Voyager (abr 2026) · *muerta*

Servidor con Chrome headless (Playwright + stealth) scrapeando LinkedIn directo y leyendo el inbox vía Voyager GraphQL. Orquestado por `scheduler.js` + `worker.js`/`batch.js`/`inbox.js`/`search.js`. Next 14. **Toda esta arquitectura hoy está muerta** (ver `CLAUDE.md` §2), pero fue la base sobre la que se construyó el CRM y la IA.

| Fecha | Hito |
|-------|------|
| 2026-04-12 | **First commit.** Orion (CRM) + Prometheus (worker Playwright). Campañas editables, sensor de calor de cuentas LI. |
| 2026-04-13 | Botones de pausa por campaña + tour. |
| 2026-04-23 | Anti-ban hardening + heartbeat del scheduler. Inbox captura todos los inbound + auto-reply más rápido. Integración Cal.com. |
| 2026-04-24/25 | **Sistema de IA por persona** (voz/tono/empresa por campaña). Detección de leads inbound (califica remitentes desconocidos). Schedule configurable por campaña + fines de semana. Monitor de proxy + warning de país. |
| 2026-04-28/29 | **Endurecimiento de seguridad**: quitar service key hardcodeada, HTTP security headers, firewall, limpieza del historial git. |

---

## Era 2 — El pivote Smart Hybrid (may–jun 2026)

La automatización headless se banea: el login opera desde una IP de datacenter ≠ la del usuario. Solución: una **extensión Chrome MV3 ("Orion Sync")** ejecuta las acciones desde la IP/sesión real del usuario; Prometheus solo orquesta vía `extension_commands` + `extension-bridge.js` (WS). Aquí mueren `worker.js`/`inbox.js`/`scheduler.js` y nace `scheduler-extension.js`.

| Fecha | Hito |
|-------|------|
| 2026-05-02 | Fix `followup.js` (aún era el motor legacy de FU). |
| 2026-05-15 | Proxy server actualizado. |
| 2026-05-17 | Campañas editables + fixes de LinkedIn UI. |
| 2026-05-22 | **Primera extensión Orion Sync** (Google gadget / modelo). |
| 2026-05-24/26/27 | Extensión Orion Sync + integración con el monitor + self-health de Gemini. |
| 2026-06-08 | **Refactor mayor de la extensión Orion Sync** — consolidación del enfoque Smart Hybrid. |

---

## Era 3 — Madurez del producto (jun 2026) · *actual*

Con el Smart Hybrid estable, el foco pasa a features de CRM, configurabilidad, performance y robustez.

| Fecha | Hito |
|-------|------|
| 2026-06-11 | Nuevo usuario + about LinkedIn. |
| 2026-06-12 | **Follow-ups dinámicos 1–20 por campaña** (v0.8). Reemplaza los FU hardcodeados; el paso vive en `leads.followup_step`. Ver `CLAUDE.md` §6. |
| 2026-06-15 | Editor de campañas con confirmación + dirty-tracking. **Pausa de automatización por contacto** + anti-loop de auto-reply. |
| 2026-06-16/17 | Flujos de FU por cuenta. |
| 2026-06-18 | **perf**: reducir write-amplification (orphan_conversations + scheduler_log). |
| 2026-06-20 | **perf**: paralelizar queries del Centro de Control (7 round-trips → 2). |
| 2026-06-24 | Fix webhook Cal.com (no ligaba bookings al lead: uuid pelón vs patrón `LEAD_ID=`). |
| 2026-06-26 | **`middleware.ts` → `proxy.ts`** (deprecación Next 16). `.gitignore` blindado para todos los `.env*`. |
| 2026-06-27 | **Cuarentena de leads** (`/dashboard/quarantine`). Auto-tune de timeouts con cap por-phase. Extensión **v0.9.1**: `runPhase` resistente al throttling de tabs en background. |
| 2026-07-02/03 | **Seguridad InMail** (ext v0.9.10–0.9.13): no enviar InMail a 2do grado ni al destinatario equivocado (`composeInmailRecipientGuard`, shadow-DOM aware). Fix whitespace en `typing_complete` (0.9.10). Fase 0 de auditoría institucional. |

---

## Era 4 — Resiliencia y multi-proveedor (jul 2026) · *actual*

Tres caídas de producción en un día (DB Supabase wedged por inanición de compute Nano/Free, box de Upcloud caído ~23h, y Gemini bloqueado por billing) — **las tres pasaron sin alerta**. La respuesta fue endurecer para que un tropiezo nunca vuelva a cascar en outage, y quitar dependencias de proveedor único. Post-mortem completo en [`docs/postmortem-2026-07-03-db-outage.md`](postmortem-2026-07-03-db-outage.md).

| Fecha | Hito |
|-------|------|
| 2026-07-04 | **LLM multi-proveedor** (`lib/ai-message.js`): `callLLM`/`callLLMJson` con cadena **Groq primario → Gemini fallback → template seguro**. Mata la fragilidad de proveedor único (el billing de Gemini rompió toda la generación). Config por env `LLM_PROVIDERS`/`GROQ_MODEL` (default `llama-3.3-70b-versatile`). |
| 2026-07-04 | **Eficiencia de DB** (post-mortem): caché TTL de config (−cientos de queries/tick), `getEligiblePendingCount` slim, bridge con cliente timeout + poll 3s→10s (−67% carga base). |
| 2026-07-04 | **Calidad IA**: regla anti "título como empresa" en el prompt VIVO (la regex vieja era código muerto); whitelist de títulos insensible a acentos. |
| 2026-07-04 | **Búsqueda yield-aware**: backoff del piso de drought (`campaigns.dry_search_streak`) para no martillar un pool agotado cada 30 min. |
| 2026-07-04 | **Watchdog out-of-band** (`watchdog.js`, reemplaza `heartbeat-check.js`): cada 2 min 24/7, alerta por webhook (nunca vía la DB), dead-man's-switch (Healthchecks.io) para box-down, `pm2 jlist` para crash-loop. Base: `lib/notify-ops.js`. |
| 2026-07-04 | **Resiliencia del run-loop del scheduler**: cancelación real de ticks (AbortSignal de tick en `lib/supabase.js` → mata los "zombie ticks" que martillaban la DB), jitter de boot, backoff exponencial ante fallos, `unhandledRejection` ya no hace crash-loop. |
| 2026-07-04 | **Detección de desconexión → Super DEAD** (`leads.disconnected_at`): cuando un contacto que estuvo conectado nos elimina, el lead pasa a DEAD irreversible en vez de revertir a `invite_sent` (evita re-invitar a quien nos eliminó = riesgo anti-ban/denuncia). Gate fail-closed en todas las rutas de envío. |
| 2026-07-07 | **Warmup cliff + footgun del admin**: `effectiveWarmupCap` (rampa por edad) devuelve `null` al día 30 → una cuenta madura aún en `cold` colapsa a cap 5 (Wal 47d estrangulada 5/día). Fix operativo (promover `warmup_status`→`warming`, cap 5→12) + quitar el reset de `warmup_started_at` en `accounts/page.tsx` (promover desde el admin ya NO reinicia la rampa a día-0 = cap 3). |
| 2026-07-07/08 | **Búsqueda dual Free / Sales Navigator** (`linkedin_accounts.search_mode`, toggle por cuenta): las cuentas Pro prospectan por `/sales/search/people` (pool sin el límite comercial de búsqueda del free) en vez de `/search/results/people/`. **Fase 1** flag + andamiaje scheduler (`6eeadca`). **Fase 2** scraper SalesNav en `content.js` (nombre en `[data-anonymize=person-name]`, v0.9.19). **Invite (v7-A, v0.9.23)**: SalesNav "Conectar" pide EMAIL a 2do-grado frío (gate anti-spam → empuja InMail); en vez de conectar desde SalesNav, la ext **resuelve el `/in/` público** del lead y el bridge persiste `linkedin_url=/in/` → invite + FU van por el **perfil público** (flujo free, sin muro de email). SalesNav = solo BÚSQUEDA. Anti-ban: SalesNav **no** sube el cap de invites — solo alimenta el supply (mata la sequía de cuentas hot). |

| 2026-07-27 | **Búsqueda por empresa real** (ext v0.10.0, `campaign_target_companies`): la lista maestra de empresas apenas se usaba — medido en CAFE 57, 15 de 17 búsquedas salían title-only, 21/182 empresas tocadas, 10% de leads de la lista. Cuatro causas: la válvula anti-sequía **borraba** `search_company_names` en drought (y el modo empresa rinde poco ⇒ drought permanente ⇒ bucle que anulaba la feature); la empresa iba concatenada al keyword (match difuso, sin validar); la geografía rotada peleaba contra la empresa (0 resultados); y un solo índice `%N` para título y empresa (cobertura diagonal, ~76 días por vuelta). Ahora: tabla-cursor por empresa + caché de company URN (acción `resolve_companies`, por lotes), **facet nativo `currentCompany`** en la URL, sin `geoUrn` cuando hay empresa, grupo booleano de títulos (varios puestos por visita) y cursor `last_searched_at nulls first` (vuelta completa antes de repetir). Con empresa se fuerza el buscador free (la URL SalesNav es keywords-only y se comía el scoping). Ver `CLAUDE.md` §5/§7. |

| 2026-08-01→03 | **Hardening company-scoped (ext 0.10.1→0.10.10)** — saga de hard testing en vivo hasta dejar la lista maestra FUNCIONAL: resolver de páginas por scoring (aislar tarjeta → puntuar solo el NOMBRE, jamás la descripción → nombre como FILTRO + tamaño decide → reintento con nombre núcleo → sin fallback genérico), `followers`+`page_title` para auditar, autocuración de empresas sin rendimiento, **recarga remota** (`reload_extension` — se acabó el ↻ manual), invites priorizando leads de la lista, pool viejo fuera del conteo de abastecimiento, **SalesNav con filtro nativo CURRENT_COMPANY** (probado en vivo). **Políglota**: los 3 caminos LLM responden en el idioma del contacto (o lo infieren del perfil en el 1er mensaje) + regla anti-respuesta-genérica cuando el contacto no es fit. Flujo CONGELADO: `docs/company-scoped-flujo.md` + hook de confirmación en `.claude/hooks/`. |

---

## Estado de versiones (referencia rápida)

- **Extensión Orion Sync**: `v0.10.10` (manifest) — company-scoped endurecido (resolver por nombre+tamaño con `followers`/`page_title`, recarga remota `reload_extension`, `contentVersion` en resultados, SalesNav CURRENT_COMPANY). ⚠️ verificar versión real con `linkedin_accounts.ext_version` — el disco de cada máquina puede ir atrás.
- **Motor de follow-ups**: v0.8 (dinámico, `campaign_followups`).
- **Orion**: Next 16.2.3 · React 19.
- **Arquitectura**: Smart Hybrid (extensión + bridge WS). Playwright/Voyager = muerta.

> Cómo mantener este archivo: cuando aterrice un hito de arquitectura, añade una fila con la fecha del commit. No documentes cada commit — solo inflexiones (cambio de arquitectura, motor nuevo, migración de framework, feature estructural).
