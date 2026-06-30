# Bitácora operativa ClawBot — novedades, fixes y mejoras

> Log vivo del monitoreo. Cada entrada: hallazgo → acción/estado. Lo mantiene Orion (Claude) en modo monitor.

## Estado actual (2026-06-29)
- **Extensión**: Josh `0.9.4`, Café 57 `0.9.4`, Wal `0.9.3` (pendiente → 0.9.4).
- **PM2**: 4 procesos online (orion, extension-bridge, prometheus-scheduler, xvfb).
- **Agente de publicación diaria** (Fases A+B+C) en producción.

## ✅ Resuelto

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
