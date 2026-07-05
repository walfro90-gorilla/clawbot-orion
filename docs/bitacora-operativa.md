# Bitácora operativa ClawBot — novedades, fixes y mejoras

> Log vivo del monitoreo. Cada entrada: hallazgo → acción/estado. Lo mantiene Orion (Claude) en modo monitor.

## Estado actual (2026-07-04)
- **Extensión**: `0.9.15` en las 3 cuentas (Wal/Josh/Café) — check_connections (accept-detection positiva) + disconnect Super DEAD.
- **Backend en `74e7c2a`+** (prod `/root/clawbot`): P1 `OLD_ACCEPT_DAYS` desactivado (`extension-bridge`), reaper de `replied` rancios (`prometheus-scheduler`), alert offline per-cuenta.
- **✅ Barrido de salud 04-jul**: 4 agentes (search/invite/auto-reply/follow-up) × 3 cuentas CERTIFICADO SANO, 0 bloqueantes.
- **Horarios**: Wal 8-22h/7d (Transporte+Tech); Josh/Café 6-21h/7d. El alert `ext_offline_business_hours` ahora respeta el schedule real por cuenta.
- **PM2**: 4 procesos online (orion, extension-bridge, prometheus-scheduler, xvfb).
- **Agente de publicación diaria** (Fases A+B+C) en producción — 3 borradores en `pending_review` esperando revisión.
- **✅ Josh "pausa manual" recurrente = era el CIRCUIT BREAKER** (no un humano — el operador lo confirmó). El spike de `typing_complete_timeout` (bug shadow DOM) tripeaba el account circuit breaker (Capa 2, `extension-dispatch.js`) → auto-pausa 8× (alertas `error_spike` 29-jun→01-jul). El label `extension_paused_by_user` del gate es genérico y engañó. **Fix**: (1) raíz = shadow DOM 0.9.8; (2) defensa = excluir `micro_phase_*_timeout` de account-fault en el breaker. Ver [`followups-flujo.md §7`](followups-flujo.md).

## ✅ Resuelto

### ⏰ Horario de Wal 8-22/7d + alert offline per-cuenta + fix tokens company-lists  [04-jul]
- **Wal activo 8am-10pm diario**: campañas Transporte (`91f116e3`) + Tech (`c39fab66`) → `schedule_start_hour=8`, `schedule_end_hour=22`, 7 días. El gate `checkCampaignActiveGates` (`extension-dispatch.js:743`) usa estos campos → controla cuándo opera el bot.
- **Alert offline per-cuenta** (`scheduler-extension.js` `runConnectivityHealthCheck`): antes `isBusinessHours(6,21,7d)` HARDCODEADO para todas → con Wal en 8-22 daba falsos-offline 6-8am y ceguera 21-22h. Ahora deriva la ventana por cuenta = unión (min start, max end, unión de días) de sus campañas activas; fallback 6-21/7d. Josh/Café sin cambio (6-21/7d), Wal → 8-22/7d.
- **Fix tokens rotos company-lists** (Josh `6e2964ad` + Café `5f3b43b7`, aprobado por Walfre): `Forvia ationMexico`→`Forvia Mexico`, `Draexlmaie`→`Draexlmaier Mexico`, `Martinrea Internal`→`Martinrea International`, `(Tupy)/(TAMSA)/(Sabritas)`→sin paréntesis, splits (`Pentair Mexico Rexnord Mexico`, `Viakable Panduit Mexico`, `Alpek Cydsa`, `Grupo Bimbo Grupo Herdez`, `Arca Continental Grupo Modelo / AB`), remove `International`+`GE` sueltos. Re-dedup: Café 174→177, Josh 196→196.
- **Modal upsell Sales Navigator** (captura de Walfre): confirmado que `dismissUpsellModals()` (ext 0.9.3, `content.js:1383`) SÍ cubre la variante "Entabla nuevas relaciones… SalesNavigator" (regex matchea) y se llama antes de teclear en ambas rutas del composer. Aparece tras N mensajes (throttle de LinkedIn), el bot la cierra (X/ESC) y continúa. No es bloqueo.

### 🧽 Higiene P3: dedup company-lists + consolidar [Post] + hold de Jose + diag offline Wal  [04-jul]
- **Dedup `search_company_names`** (case-insensitive, preserva orden, quita vacíos — SOLO duplicados exactos, no adivina correcciones de nombres): Josh (`6e2964ad`) 203→**196**, Café (`5f3b43b7`) 176→**174**. Pendiente (requiere confirmación de Walfre, es data de targeting): tokens rotos/concatenados `Forvia ationMexico`, `Draexlmaie`, `Martinrea Internal`, `International`, `GE`, `(Tupy)`, `(TAMSA)`, `(Sabritas)`, `Pentair Mexico Rexnord Mexico`, `Viakable Panduit Mexico`, `Alpek Cydsa`, `Grupo Bimbo Grupo Herdez`, `Arca Continental Grupo Modelo / AB`.
- **Consolidación campañas `[Post] SaaS Agentic AI` de Wal**: eran 7 duplicadas (creadas en ráfaga de 44s el 25-jun, bug de multi-submit), 0 `post_opportunities`, solo `0d4a8745` con 6 leads. Deactivadas las 6 vacías (`is_active=false`), conservada `0d4a8745`. Mata el ×7 de procesamiento por tick.
- **Jose Cruz** (`f9c38050`): `automation_paused=true` + `automation_paused_at` marcado → atención humana con fecha. Reaper lo excluye (no muere), auto-reply lo omite. Walfre responde manual.
- **Diag offline Wal** (`ext_offline_business_hours` 28/7d): patrón por hora (UTC 12-16 = 06-10h Juárez, y UTC 0-2 = 18-20h) = **máquina del operador apagada al inicio/fin de su día**, NO un fallo server-side de xvfb. Todas `resolved`, `auto_paused=false` (bajo daño, solo recorta throughput). Fix = operativo (Chrome abierto más horas / navegador always-on / afinar ventana business-hours), no código.

### 🧹 Reaper de leads 'replied' rancios + reactivación de campaña Tech (drenaje)  [04-jul]
- **Hueco cerrado (código)**: un lead `status='replied'` que respondió pero lleva >N días sin nuevo inbound quedaba en LIMBO — auto-reply lo ignora (safety gate `fm_max_age=7d`) y ningún sweep lo tocaba (`auto_dead_after_days` corre DENTRO del flujo FU y `'replied'` está en `FU_DISPATCH_EXCLUDED_STATUSES`). Se acumulaban indefinidamente (60+ solo en la campaña Tech de Wal). **Fix**: `sweepRepliedTimeout()` en `scheduler-extension.js` (espejo de `sweepAwaitingResponseTimeout`) — mata `replied` con `replied_at` > `REPLIED_STALE_KILL_DAYS` (default 21d, env-configurable) → `dead` con `dead_reason='replied_no_action_21d'`. Excluye `automation_paused=true` (respeta holds manuales). Seguro: `replied_at` se refresca en cada inbound (bridge) → un lead en conversación activa nunca envejece. Radio 1er run: **60 leads** (los más viejos 36d).
- **Reactivación campaña 'Tech & Innovation Leaders - Wal' (`c39fab66`)**: estaba `is_active=false` con 74 connected + 81 replied varados. Set `is_active=true` + **`search_paused=true`** (drenar el backlog tibio SIN reabrir prospección nueva — no diluir el cap frío de Wal con leads nuevos). Drenaje: 74 connected → FU1 (throttle 30/día compartido); 3 replied fresh → auto-reply; 60 replied ≥21d → reaper; 20 en limbo 7-21d → reaper al cruzar 21d.
- **Jose Cruz (`f9c38050`)**: prospecto genuino ("okey avísame"), replied 4.2d (dentro de ventana auto-reply). **Retenido** (`automation_paused=true`) para respuesta MANUAL de Walfre — no dispara auto-reply. Liberar/responder cuando Walfre lo atienda.

### 🩺 Certificación de salud de los 4 agentes IA (search/invite/auto-reply/follow-up) × 3 cuentas  [barrido read-only, 04-jul]
- **Veredicto: CERTIFICADO SANO, 0 hallazgos bloqueantes.** Barrido multi-agente (4 analistas paralelos) contra código vivo + DB tras los fixes. Los 4 agentes aprobados.
- **Confirmado en producción con datos**: FU1-prioritario (Josh 7 FU1 hoy + 20 accepts encolados en su delay); `check_connections` positivo (Josh 434→20 accepts, Wal 407→5); Fix#2 Wal-MX (keyword 0 USA→10 MX); Groq primario (0 `ai_fallback_used`/30d); Super DEAD seguro (13 falsos-positivos `not_first_degree` revertidos limpios, `disconnected_at=null` en todos → 0 super-dead erróneos).
- **Cola de reparación** (no bloqueante): (P1-código) desactivar la ruta agresiva `OLD_ACCEPT_DAYS=10` de `ingestCheckSentInvites` — con `/sent/` paginación rota (ve 10 de N) fabrica falsos-accept (churn Josh 49/Wal 16/Café 16), ya redundante frente a `check_connections`; (P1-humano) Jose Cruz prospecto real varado ~101h; (P2) 74 connected + 82 replied varados en campaña 'Tech & Innovation Leaders' (`is_active=false`) sin FU ni caducidad; (P2-código) falta reaper de `replied` rancios (`sweepAwaitingResponseTimeout` solo toca `awaiting_response`); (P3) dedup `search_company_names`, consolidar `[Post]` duplicadas ×8, estabilizar xvfb de Wal (29 offline/7d).

### 🎯 Josh "aceptaron y no reciben mensaje" = 2 fallas: FU1 starved + accept-detection ciega  [validado en vivo 04-jul]
- **Reporte de Josh**: contactos que aceptaron hace días no reciben FU1.
- **Falla 1 — FU1 starved**: el motor de FU procesaba pasos de MAYOR a menor (`scheduler-extension.js:566` `.reverse()`) + 1 FU/campaña/tick → los recién-conectados (paso 0→FU1) quedaban al final y no salían por días (el cap diario NO era el límite: Josh iba 14/30). **Fix**: FU1 va PRIMERO (`step1` al frente; el resto de mayor a menor con shuffle anti-pattern). Validado: **Jorge Junco + Lukas Loosli** recibieron FU1 minutos tras el deploy (tras 40h atascados).
- **Falla 2 — accept-detection por AUSENCIA tiene zonas ciegas**: `check_sent_invites` infiere "aceptó" por ausencia del `/sent/` pending (ventana/boundary/timing) → perdía accepts (ej. **Yoshimura**, `invite_sent` 71h pese a haber aceptado). **Fix**: comando nuevo `check_connections` — detección POSITIVA por **presencia** en la lista de conexiones (`/mynetwork/invite-connect/connections/`). `ingestCheckConnections` (bridge) marca `connected` por match de URL/nombre (override del flag `detected_not_first_degree`); scheduler lo corre cada ~4h (backstop, `CONNECTIONS_CHECK_GAP_MIN`). Extensión **0.9.15**.
  - **Bug del scrape (0.9.14→0.9.15)**: la lista scrollea DENTRO de un contenedor (`main` con overflow), NO la window → `window.scroll` no disparaba el lazy-load y quedaba en **10 de 658**. Fix: detectar el contenedor scrollable + `scrollBy` + ACUMULAR URLs (lista virtualizada, ~10 items en DOM) + preferir el anchor CON nombre (2 anchors /in/ por card: avatar sin texto + nombre).
- **Validado en vivo (04-jul), ejecutando `check_connections` directo por cuenta**: Wal 407 conexiones → 3-4 accepts; **Josh 434 conexiones → 15 accepts recuperados** (Yoshimura, Alex Amell, Gabriela Dopico, Sebastián Eterovic, +11) que la detección por ausencia había perdido → ahora `connected` → FU1 (delay 1h). Café 36 → 0 (invites genuinamente pendientes).
- **Trampa de deploy de la extensión**: `deploy-orion` NO publica la extensión — usar **`deploy-extension`** (regenera el tarball **PLANO** en `/opt/orion-public`; un tarball con prefijo `orion-extension/` rompe `install.sh`/`.ps1` que extraen sin `--strip-components`). El ISP de algunos bloquea la descarga HTTP de `.ps1`/`.sh` (403) → descargar el `.tar.gz` directo.

### 🔒 SEGURIDAD: InMail a 2do-grado + destinatario en ruta compose — extensión 0.9.12  [validado]
- **Reporte de Josh**: el bot mandaba **InMails a contactos fuera de la lista**. **Causa**: el deep-pierce 0.9.10 hizo alcanzable el composer shadow — incluido el de **InMail de un 2do-grado** — y las guardas anti-InMail eran **shadow-ciegas** (`document.*`). Compose además no verificaba destinatario (`headerName` vacío). **Amplificador**: accept-detection marca `connected` a 2do-grados (invitación retirada/expirada ≠ aceptada).
- **Proceso**: pausé los FU de Josh (`follow_up_paused`) → fix → test → despausé (como pidió el usuario).
- **Fix (0.9.12)**: guardas fail-closed en compose — InMail **deep** (light+shadow) + verificación de destinatario en `document.body` (el chip "Para:" vive en DOM ligero, NO en el shadow del composer; el 0.9.11 buscaba en el shadow → false-block de TODO, corregido en 0.9.12).
- **Validado**: Jorge (1er grado) `sent_confirmed`; José Jorge (2do grado) abortó sin enviar.
- **Pendiente**: Wal + Café reinstalar 0.9.12 (mismo riesgo hasta entonces). Ver [`followups-flujo.md §1`](followups-flujo.md).

### 🎯 CAUSA RAÍZ REAL del ~82% de FU fallidos: WHITESPACE — extensión 0.9.10  [validado 3/3 en vivo]
- **El shadow DOM fue red herring.** Evidencia del bot real (`_typingDiag`, build diagnóstico 0.9.9): en la página real del FU el composer está en **DOM ligero** (`inShadow:false`), el texto **SÍ aterriza** (`editorLen 392/405`), pero `typing_complete` fallaba igual.
- **Causa real**: el mensaje trae `\n\n` → en `expectedHead` normaliza a UN espacio (`"tal! se"`), pero al teclear con `execCommand('insertText')` el `\n` se vuelve `<br>` y **desaparece** de `editor.textContent` (`"tal!se"`) → `actual.startsWith(expectedHead)` **siempre false** → `typing_complete` 15s timeout. Afecta **thread Y overlay** (es por el mensaje, no el composer) → por eso fallaban ambos.
- **Fix (0.9.10)**: comparar head/tail/ratio **SIN espacios** (`noWs`) en `typing_complete` + verificación 6.5.
- **Validado en vivo (02-jul)**: 3/3 FU forzados → **`sent_confirmed`** (Denis+Mariano overlay, Martin thread), **0 typing_complete_timeout**, leads avanzaron a `follow_up_sent`. Ver [`followups-flujo.md §1`](followups-flujo.md).
- El fix shadow DOM (0.9.8, `deepQuery`) queda como **defensa** (algunas páginas de LinkedIn sí usan composer en shadow root), pero no era la causa.

### 🎯 (red herring) SHADOW DOM — extensión 0.9.8  [defensa, no era la causa raíz]
- **Retrospectiva (mar 30-jun)**: `send_followup` 61 errores vs 13 ok (~82% falla), todos Josh, `typing_complete_timeout` ~15s. `daily_activity.errors=0` lo ocultaba.
- **Diagnóstico en vivo** (consola en el overlay "Nuevo mensaje"): el composer `.msg-form__contenteditable` existe pero **dentro de un SHADOW ROOT** (`path top>shadow[div]`) → `document.querySelector` NO lo alcanza. LinkedIn movió el composer del overlay (leads sin thread previo) a shadow DOM. FU por **thread existente** (DOM ligero) → funcionan; por **overlay nuevo** (shadow) → siempre fallaban.
- **Fix (0.9.8)**: helpers `deepQueryAll`/`deepQuery` que perforan shadow DOM, aplicados en: adquisición del editor (`send_followup` + `sendFollowupFromProfile`), `liveEditor`, `findThreadSendButton` (ahora recibe el editor y busca en su shadow root), `readThreadHeader`.
- **Validado (mié 01-jul)**: (1) snippet con la lógica de 0.9.8 sobre el overlay real 1er grado → `✅ ENCUENTRA el composer` con el texto tecleado; (2) test en vivo → CERO `typing_complete_timeout`; los 2do-grado ahora abortan rápido (`lead_not_first_degree`) en vez de colgarse 15s. **Muchos "typing_timeout" de ayer eran en realidad 2do grado.**

### 🐛 REGRESIÓN (mía, 0.9.4): el mensaje se borraba "al querer enviar" — extensión 0.9.6  [Josh/Martin]
- **Causa**: el `liveEditor()` que agregué en 0.9.4 usaba `querySelector` con selector de coma → devolvía el PRIMER `[contenteditable]` en orden del DOM, que podía ser el buscador u otro (no el composer) → la verificación 6.5 leía vacío → "tooShort" → **borraba el composer (con el mensaje completo) justo antes de enviar** y abortaba. Por eso Martin "se escribía bien pero al enviar se borraba".
- **Fix (0.9.6)**: `liveEditor` prefiere el ref original si sigue conectado; solo re-query el composer ESPECÍFICO (`.msg-form__contenteditable`) si se desconectó. Nunca genéricos.
- **Backlog relacionado**: `sent_unconfirmed` (editor vaciado pero mensaje NO en el thread) se trata como enviado → si un método sintético vacía sin enviar, el lead avanza falso. Endurecer a futuro (requerir `message_in_dom`).

### 🔒 SEGURIDAD: InMail/mensaje al contacto equivocado — extensión 0.9.5  [Josh]
- **Bug**: en `/messaging/compose`, cuando LinkedIn no auto-popula el recipient, el bot escribía el nombre del lead en el typeahead y **clickeaba la PRIMERA sugerencia A CIEGAS** → componía/InMail al **contacto equivocado** (nombre similar o sugerencia ajena), incl. gente fuera de la lista.
- **Fix (0.9.5)**: verificar que la sugerencia **coincida** con el nombre del lead (normalizado, first+last) antes de clickear; si **ninguna matchea → ABORT `recipient_mismatch`** (no mensajea a nadie). Esos leads (probables 2do grado / nombre no-conexión) dejan de recibir FU a propósito → caen a cuarentena para revisión.

### FU "escribe pero no envía" (Josh) — extensión 0.9.4  [EL grande]
- **Root cause**: la verificación `typing_complete` daba **false-negative** (timeout 15s) pese a que el mensaje estaba completo y visible → el bot erraba ANTES de clickear Enviar → dejaba el mensaje huérfano → saltaba al siguiente. Dos causas: (1) ref `editor` **stale** tras re-render de React del composer; (2) `endsWith(tail)` **estricto**.
- **Fix (0.9.4)**: en las 2 capas de verificación → re-query del **editor vivo** cada poll + aceptar por **head + ratio de longitud** (0.9–1.2), no solo tail estricto.
- **Resultado**: ✅ FUs enviando. Santiago, Marcelo, Abel, Esteban avanzaron FU3→FU4.

### Throttle de tecleo — extensión 0.9.3
- `bulkInsertFull()` (selectAll+insertText re-enfocando) con triggers: tab oculta / presupuesto 9s / sleep individual >2s. Reemplaza el bulk-insert v0.7.46 que no re-enfocaba.

### Modal upsell Sales Navigator — extensión 0.9.3
- `dismissUpsellModals()` cierra el modal Premium/SalesNav que tapaba el composer en `/messaging/compose`. Afecta cuentas SIN Sales Navigator (no a Josh, que sí tiene).

## ⚠️ En observación
- **Sergio Pighin** (Josh): 1 re-fallo `typing_complete_timeout` tras el reset — vigilar si reincide en 0.9.4 o fue residual.

## 📋 Backlog (mejoras a implementar)
1. **Wal → 0.9.4** — quedó en 0.9.3; el fix de verificación aplica a todas las cuentas.
2. **Bug https del L6 (capture ciego)** — `content.js` pega a `https://209.50.63.149` (el server es **http**) → `CONNECTION_REFUSED` → `capture-failure` sin capturas desde el 23-jun. Fix: que content.js alcance el server por http o vía background.js.
3. **Auto-repair con Vision (cerrar el loop L6)** — auto-aplicar recomendaciones de alta confianza (revertir 2do-grado, dismiss de modales nuevos, `learned_selectors`) con gate de confianza + audit + rollback. Tabla `dismiss_rules` para que cada bloqueador nuevo de LinkedIn se **aprenda solo** sin hard-codear.
4. **Flags anti-throttle de Chrome** en las máquinas de los operadores (`--disable-background-timer-throttling` + 2 más) — defensa de raíz contra el throttle.
5. **publish_post (Fase C)** — test end-to-end pendiente (auto-publicar el texto del post diario vía extensión).
6. **2do-grado automatizado** — revertir a invite_sent / marcar dead los leads que LinkedIn restringe (el L6 ya lo diagnostica con conf 0.85; falta actuar).
