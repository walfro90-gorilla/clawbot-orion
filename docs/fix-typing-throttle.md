# Fix propuesto: timeout de tecleo → cuarentena (background-tab throttling)

> Estado: **PROPUESTA para revisar** (no aplicada). El fix server-side ya está aplicado
> (ver §"Ya hecho"). Esto cubre la causa raíz, que toca la extensión / la máquina del
> operador. Requiere recargar la extensión y vigilar ~1 día.

## Síntoma

Leads en cuarentena con `last_failure_reason = micro_phase_typing_complete_timeout_~30000ms`.
A los 5 fallos → cuarentena. Era el bucket más grande (5/13 al 2026-06-27).

## Causa raíz (confirmada en código)

1. Cada acción de envío corre micro-fases con `MicroPhaseRunner.runPhase()`
   ([content.js:998](../apps/orion-extension/content.js)). El runner **poll­ea con
   `await sleep(intervalMs)`** en un `while (Date.now() < deadline)` (línea ~1024).
2. `sleep()` usa `setTimeout`. Chrome **throttlea `setTimeout` a ~1/min** en pestañas
   en segundo plano / ocluidas ("intensive throttling" tras 5 min).
3. El **tecleo** ya tiene anti-throttle: si `document.hidden`, hace bulk-insert
   ([content.js:4292](../apps/orion-extension/content.js)). Pero la **fase de
   verificación** `typing_complete` ([content.js:3374](../apps/orion-extension/content.js))
   NO — su loop de poll se throttlea: hace 1 check en t=0 (falla porque el editor aún no
   refleja el texto), luego el `sleep(250)` se estira a ~60s, y el deadline (antes 30s)
   ya venció → `micro_phase_typing_complete_timeout`.
4. El **auto-tune L3** ([phase-analyzer.js:349](../apps/prometheus/phase-analyzer.js))
   veía p95 alto y subía el timeout `4000→15000→30000` (cap global `max_timeout_ms`),
   alargando cada fallo a 30s sin resolver nada.
5. `background.js` v0.7.42 **ya intenta** enfocar la pestaña antes de actuar
   (`chrome.tabs.update({active:true})` + `chrome.windows.update({focused:true})`,
   [background.js:584](../apps/orion-extension/background.js)). Si aun así se throttlea,
   es porque en la **máquina del operador** la ventana de Chrome está minimizada, en otro
   escritorio virtual, o el display está desconectado (sesión RDP/headless) → Chrome la
   considera ocluida igual.

> Nota de arquitectura: el Chrome con la extensión **NO corre en el server** (no hay
> proceso chrome ahí). Corre en la máquina del operador (Smart Hybrid). Por eso el fix
> no son flags del server.

## Ya hecho (server-side, aplicado)

- **Reset** `runtime_config.phase_timeouts.typing_complete` 30000 → **15000**.
- **Tope por-phase al auto-tune** (`PHASE_TIMEOUT_CAP_MS` en
  [phase-analyzer.js](../apps/prometheus/phase-analyzer.js)) para que no vuelva a inflar
  `typing_complete` hasta 30s. typing_complete queda acotado a 15000.

Esto **detiene el círculo vicioso** (no más inflado a 30s, fallos más cortos), pero NO
elimina el throttling de raíz. Para eso, una de las dos opciones de abajo.

## Opción A (recomendada, 0 código, 0 riesgo de baneo): flags de Chrome

En la máquina que corre el Chrome de la extensión, lanzar Chrome con:

```
google-chrome \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding
```

Esto evita que Chrome ralentice sus propios timers aunque la pestaña esté en segundo
plano → `runPhase` poll­ea normal → con 15s sobra. No cambia nada del comportamiento
hacia LinkedIn (no afecta riesgo de baneo). **Limitación:** depende de cómo se lance ese
Chrome; si lo abres a mano, hay que usar estos flags siempre (o un .desktop / script).

## Opción B (durable, toca content.js): `runPhase` resistente al throttle

Compensar el throttling extendiendo el deadline por el tiempo "perdido" en sleeps
throttled, para que una pestaña en background reciba suficientes polls reales:

```js
// content.js — MicroPhaseRunner.runPhase()  (~línea 998)
async runPhase(name, evidenceFn, options = {}) {
  const { timeoutMs = 8000, intervalMs = 200, label } = options
  const phaseStart = Date.now()
  await this._record(name, { state: 'started', label })

  let deadline = Date.now() + timeoutMs
  let lastError = null, polls = 0, throttleCredit = 0
  while (Date.now() < deadline) {
    polls++
    try {
      const ev = await evidenceFn()
      if (ev) { /* …record ok + return ev… */ }
    } catch (err) { lastError = err.message }

    const t0 = Date.now()
    await sleep(intervalMs)
    const slept = Date.now() - t0
    // Si Chrome throttleó el setTimeout (slept >> intervalMs), devuelve el exceso al
    // deadline (hasta un tope) para no rendirse con 1 solo poll real.
    if (slept > intervalMs * 4 && throttleCredit < timeoutMs * 3) {
      const extra = slept - intervalMs
      deadline += extra
      throttleCredit += extra
    }
  }
  // …record timeout + throw…
}
```

**Trade-off:** un envío throttled-pero-OK puede tardar más (hasta ~4× el timeout) antes
de confirmar, pero **deja de caer en cuarentena**. Un fallo genuino también tarda más en
declararse. Con typing_complete=15000 y cap ×3 → peor caso ~60s.

> Idea complementaria: mantener el renderer "despierto" durante la acción (Web Audio
> silencioso / `navigator.locks` / heartbeat con `requestAnimationFrame`) para que Chrome
> no entre en intensive throttling. Más hacky; evaluar solo si A+B no bastan.

## Recomendación

1. **Opción A ya** (si controlas el lanzamiento del Chrome del operador) — elimina la
   causa de raíz sin tocar código.
2. **Opción B** como red durable (revisada y probada), por si el Chrome a veces queda
   ocluido igual.

## Plan de prueba (tras aplicar)

1. Recargar la extensión (`chrome://extensions` → recargar Orion Sync). Subir versión
   en `manifest.json` si aplica.
2. Forzar un `send_followup` con la **pestaña de LinkedIn en segundo plano** (otra app
   encima / ventana minimizada).
3. En logs del bridge / `conversation_events`: el FU debe salir sin
   `typing_complete_timeout`. Revisar `phase_insights` (no nuevos `lead_quarantined` por
   typing).
4. Vigilar 1 día la tasa de `send_followup` y nuevos ingresos a `/dashboard/quarantine`.

## Rollback

- Opción A: lanzar Chrome sin los flags.
- Opción B: revertir el commit de `runPhase`.
- Server-side: el auto-tune tiene rollback en `phase_insights.rollback_value`; el reset
  manual queda en `runtime_config.previous_value`.
