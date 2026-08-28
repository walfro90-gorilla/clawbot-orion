# ADR-0005 · Matar un lead para siempre solo si el contacto nos eliminó

- **Estado**: aceptado (4-jul-2026), ampliado (17-ago-2026)
- **Contexto que lo detona**: un lead que ya había recibido seguimientos volvió a dar `not_first_degree`. No era un falso positivo de accept-detection: el contacto nos había eliminado de su red.
- **Gobierna**: `apps/prometheus/extension-bridge.js`

## El problema, dicho una sola vez

Tres situaciones distintas producen **el mismo síntoma** — un lead que debería ser contacto y no responde como tal — y exigen tres respuestas opuestas:

| Situación | Qué pasó de verdad | Respuesta correcta |
|---|---|---|
| Falso positivo de accept-detection | Nunca estuvo conectado; lo promovimos mal | Revertir a `invite_sent` y reintentar |
| El contacto nos eliminó | Sí estuvo conectado y decidió sacarnos | `dead` irreversible, no volver a tocarlo nunca |
| Trabaja en otra empresa que la pedida | El lead es válido, el targeting falló | Pausar, no matar |

Tratarlas igual tiene dos formas de salir mal: reinvitar a quien nos eliminó (riesgo de denuncia y baneo), o dar por perdido a un prospecto sano porque el filtro de empresa se equivocó.

## Decisión

**La severidad se elige por lo que el lead FUE, no por lo que devuelve hoy.**

`wasGenuinelyConnected()` (`extension-bridge.js:1448`) es el árbitro: mira si hubo seguimiento enviado, respuesta recibida o etapa post-conexión.

### 1. Estuvo conectado de verdad y ahora no lo está → Super DEAD

`markDisconnectedSuperDead()`: `status=dead`, `dead_reason='disconnected_by_contact'`, `disconnected_at`, y `automation_paused=true`. Ese último es **fail-closed a propósito**: bloquea cualquier ruta futura que filtre por `automation_paused` aunque olvide mirar `status`.

Nunca se le vuelve a invitar ni escribir. Es anti-ban, no limpieza de datos.

### 2. Nunca hubo evidencia de conexión → revertir a `invite_sent`

Es el camino barato y reversible. Solo aplica a falsos positivos.

### 3. Empresa equivocada, ya contactado → `automation_paused`, no `dead`

Se usó pausa **a propósito**: es reversible y no da el lead por perdido. Un Director de Compras de otra automotriz puede seguir siendo prospecto válido para una agencia aduanal — el error fue de targeting, no del lead.

### 4. Una pausa automática lleva su motivo, y el motivo se ve

Añadido el 28-ago-2026, después de que esta misma decisión generara un P1 falso.

Pausar es correcto, pero **una pausa silenciosa es indistinguible de una avería**. Diez
leads de Aduanas Infinity se pausaron el 17-ago por `off_list_company`; dos ya habían
recibido FU1 y FU2. Once días después el cliente los vio sin seguimiento, no encontró en
ninguna pantalla por qué, y reportó *"el segundo seguimiento nunca sale"* como bug del
motor. El motor estaba sano: la consulta de leads vencidos daba **cero**.

Dos exigencias, y las dos son parte de la decisión:

- **`last_failure_reason` es obligatorio al pausar.** Sin motivo, la pausa no se puede
  auditar ni revertir con criterio. Hoy hay al menos una ruta que lo incumple: Antonio
  Huerta, pausado el 26-ago con el campo en `NULL`.
- **El motivo tiene que llegar a la UI, y hoy no llega.** Corregido el 28-ago-2026 tras
  revisar el código: *la pausa sí se ve* — `crm/lead-drawer.tsx` pinta el badge
  "⏸️ AUTOMATIZACIÓN PAUSADA" y ofrece "▶️ Reanudar". Lo que no aparece por ningún lado es
  **el motivo**, y ahí se juntan tres huecos:
  1. el drawer muestra el badge pero no renderiza `last_failure_reason`;
  2. la única pantalla que sí traduce motivos, `/dashboard/quarantine`, filtra por
     `.not('quarantined_at','is',null)` — estos leads tienen `quarantined_at` en NULL, así
     que nunca salen ahí;
  3. `off_list_company` ni siquiera está en el diccionario de `lib/quarantine-reasons.ts`.

  Y el badge solo se ve **abriendo ese lead concreto**: ninguna vista de lista lo muestra,
  que es justo por donde se busca trabajo pendiente. Persistir sin mostrar no cumple
  [ADR-0001](0001-degradacion-silenciosa.md) §2.

## Caminos descartados — no reintroducir

| Camino | Por qué se descartó | Dónde murió |
|---|---|---|
| **Un solo camino: revertir siempre a `invite_sent`** | Reinvita a quien nos eliminó. Riesgo de denuncia y baneo | `bb91b7f` (4-jul) |
| **Marcar `dead` al lead de empresa equivocada** | Lo da por perdido siendo un prospecto sano. El fallo fue del filtro, no suyo | `f4c892f` (17-ago) |
| **Unificar los dos caminos "porque hacen casi lo mismo"** | Hacen lo contrario. Se parecen en el síntoma y difieren en la causa | — (no hacer) |
| **Confiar solo en `status=dead` sin `automation_paused`** | Cualquier consulta futura que filtre por pausa y no por estado vuelve a tocarlo | `bb91b7f` |
| **Pausar sin escribir el motivo** | La pausa se vuelve indistinguible de una avería del motor. Costó un P1 falso el 28-ago-2026 | 28-ago-2026 |

## Consecuencias

**A favor**: nunca se vuelve a escribir a alguien que nos sacó de su red. Los errores de targeting son recuperables sin intervención manual.

**En contra**: desde fuera parece severidad arbitraria — dos leads con el mismo síntoma acaban uno muerto y otro pausado, y no hay nada en la fila que lo explique salvo el `dead_reason`. **Y eso ya se cobró una factura**: el 28-ago-2026 un lote de pausas correctas se reportó como un P1 del motor de follow-ups (ver `docs/bitacora-operativa.md`). Mientras el motivo no se muestre, cada pausa masiva es un falso positivo esperando. Y la cobertura es **incompleta a sabiendas**: solo la ruta compose dispara el guard (el de InMail actúa antes de enviar); la ruta thread, la de los seguimientos multi-paso, necesita el check de grado en la extensión y está pendiente.

## Cómo se aplica

1. ¿Vas a cambiar el estado de un lead por un fallo de mensajería? Pregunta primero `wasGenuinelyConnected()`. La respuesta decide la severidad.
2. `dead` irreversible es **solo** para `disconnected_by_contact`. Cualquier otro motivo que se te ocurra: pausa.
3. Si añades una ruta nueva que descarta leads, deja escrito por qué eligió matar en vez de pausar.
4. ¿Tu código pausa un lead? Escribe `last_failure_reason` en la misma operación. Una pausa sin motivo es un bug que se descubre semanas después, desde el lado del cliente.
5. Antes de investigar "el motor no manda seguimientos", corre la consulta de leads vencidos de `docs/bitacora-operativa.md` (entrada del 28-ago). Separa los vencidos de verdad de los pausados a propósito, y suele no quedar nada que arreglar.

Relacionado: [ADR-0004](0004-accepts-por-presencia.md) (de dónde salen los falsos positivos), [ADR-0006](0006-verificar-en-el-ingest.md) (de dónde salen los de empresa equivocada)
