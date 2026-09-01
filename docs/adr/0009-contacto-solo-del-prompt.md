# ADR-0009 · Un dato de contacto solo se envía si venía en el prompt

- **Estado**: aceptado (01-sep-2026)
- **Contexto que lo detona**: el FM le inventó un teléfono a un lead real que pidió número.
- **Gobierna**: `apps/prometheus/lib/ai-message.js`, `apps/prometheus/scheduler-extension.js`

## El problema, dicho una sola vez

Cuando el lead pide un dato de contacto (teléfono, cita, material) y la configuración no
lo tiene, el pitch de la campaña empuja a cerrar y el modelo **rellena el hueco
inventando**. No es hipótesis — pasó dos veces, con los guards anti-placeholder y
anti-meta ya vivos:

| Fecha | Qué se rompió | Qué mostró el sistema |
|---|---|---|
| 01-sep-2026 | Jennifer Ferat escribió "Pásame tu número de teléfono" y el FM contestó `Mi número es +52 1 81 5555 1234` — placeholder fabricado | cero teléfonos en TODA la config de la campaña (persona 26.000 chars, contexto 4.321, prompt, playbook): no había nada que dar |
| 26 y 31-ago-2026 | el FM mandó ×2 `calendly.com/cafe57/20min` a Carlos Medina — slug fabricado con el nombre de la empresa, la página da **404** | la cuenta tiene `cal_com_url = null`; el link no existe en ninguna config |

Auditoría de los últimos 1.000 mensajes outbound (01-sep): 1 teléfono falso, 1 URL falsa
enviada dos veces, 1 email legítimo (lo dio el propio lead en el hilo). Misma familia:
promesas incumplibles — "te envío el company profile", "lamento no haberte llamado aún".

## Decisión

**Un mensaje generado solo puede contener teléfonos, emails o URLs que aparezcan
literalmente en su propio prompt (system + user). Lo que no venía en el prompt es
fabricado y no se envía.**

El prompt ya reúne, por construcción, todo dato aprobado: la config de campaña y cuenta
(`cal_com_url`, `ai_company_context`, persona), el Cerebro (`ai_playbook`) y el historial
de la conversación (lo que el lead mismo compartió). No hace falta mantener ninguna otra
lista: **el corpus de verdad ES el prompt**.

### 1. El guard es determinista y vive en el chokepoint

`findUnapprovedContact(text, systemPrompt + userPrompt)` corre dentro de `callProvider`
(`f48c678`), el mismo cuello por el que pasan invite, FU-LLM y FM. Teléfonos se comparan
por identidad de últimos 8 dígitos (los formatos varían), URLs por base sin query (el
`cal_url` viaja con `?notes=LEAD_ID` distinto por lead), emails en lowercase. Detección ⇒
retry ⇒ error `invented_contact` ⇒ el caller cae a template seguro o no envía. La regla
de prompt `NO_INVENT_CONTACT_RULE` existe solo para ahorrar retries — la garantía es el
guard, no la regla.

### 2. El dato faltante lo pone un humano, no otro retry

En FM, `invented_contact` significa "el lead pide algo que la config no tiene": el lead se
pausa con alerta `manual_reply_needed`. Reintentar cada tick sería un loop silencioso —
el modelo va a volver a inventar, porque el hueco sigue ahí. Para que el bot PUEDA
compartir un dato, el camino es configurarlo (entra al prompt), nunca abrir una excepción
en el guard.

## Caminos descartados — no reintroducir

| Camino | Por qué se descartó | Dónde murió |
|---|---|---|
| **Tabla/allowlist aparte de "datos aprobados"** | segunda fuente de verdad que deriva: alguien actualiza `cal_com_url` y no la lista, o al revés. Y no puede saber qué dato dio el LEAD en el hilo — el email de Carlos se pudo repetir precisamente porque el historial ya está en el prompt | descartado en diseño, 01-sep-2026 |
| **Solo regla de prompt (RAG puro: poner los datos y confiar)** | probabilística: el teléfono inventado salió con dos guards de prompt ya activos; bajo "pásame tu número" el modelo complace. Los datos reales van en la config porque REDUCEN, pero quien garantiza es el guard | el caso Jennifer, 01-sep-2026 |
| **Bloquear todo lo que parezca dato de contacto, siempre** | mataría el `cal_com_url` configurado y cualquier dato legítimo del cliente: el bot no podría compartir nada nunca, ni lo que el operador SÍ quiere dar | descartado en diseño |
| **Auditoría post-envío** | detecta después del daño: así se *encontró* el calendly ×2 (regex sobre `conversation_events`), no se evitó. Sirve como verificación periódica, no como control | la propia auditoría del 01-sep-2026 |

## Consecuencias

**A favor**: una sola fuente de verdad sin deriva posible; lo que el lead compartió queda
auto-aprobado; garantía determinista donde las reglas de prompt son probabilísticas; y un
falso negativo es imposible por construcción — si el dato está en el prompt, lo puso el
operador o el lead.

**En contra** (y varias cosas que *parecen bug* desde fuera):
- Una cuenta sin `cal_com_url` ni datos en su config **no puede compartir contacto,
  punto** — "el bot no da nuestro teléfono" no es un bug, es que nadie lo configuró.
- Falso positivo posible: una cifra legítima de ≥8 dígitos que no venga en el prompt (un
  número de factura, un tracking) bloquea el mensaje y pausa el lead con alerta. Se
  acepta: el fallo seguro es callar (ADR-0001).
- Techo del regex: un teléfono dictado en palabras o de <8 dígitos pasa. Se asume — el
  modelo no alucina en ese formato en la práctica.
- El guard valida **procedencia, no verdad**: si un dato erróneo entra a la config, el
  guard lo deja pasar. La calidad del dato es responsabilidad del operador.

## Cómo se aplica

- ¿Quieres que el bot comparta un dato nuevo (teléfono, email, link)? → configúralo para
  que entre al prompt (`linkedin_accounts.cal_com_url`, `ai_company_context`, Cerebro).
  **Nunca** añadas excepciones o allowlists al guard.
- ¿El guard bloquea un output que te parece legítimo? → primero pregunta si el dato está
  en el prompt. Si no está, es el sistema funcionando. Si es un falso positivo de formato,
  ajusta el regex CON su self-check nuevo — no quites el guard del chokepoint.
- ¿Camino nuevo de generación de texto hacia LinkedIn? → pasa por `callLLM`/`callProvider`
  o no existe (mismo contrato que el guard anti-meta).
- `invented_contact` en FM pausa + alerta. No lo conviertas en retry: el hueco de config
  no se arregla reintentando.
- Los casos reales viven como self-check en `scripts/test-reply-guards.js` (encadenado a
  `npm run check`): el `+52 1 81 5555 1234`, el calendly fabricado, y los no-falsos-positivos
  (horas, rangos "20-30 min", años, porcentajes).

Relacionado: [ADR-0001](0001-degradacion-silenciosa.md) (mismo principio madre — callar es
preferible a publicar basura — y mismo chokepoint), `docs/bitacora-operativa.md`
(01-sep-2026), memoria `contacto-inventado-sep2026`.
