# ADR-0001 · Nada degrada en silencio

- **Estado**: aceptado (22-ago-2026)
- **Gobierna**: `apps/prometheus/lib/ai-message.js`, `apps/orion-extension/content.js`, y todo camino que hable con LinkedIn
- **Contexto que lo detona**: la cuenta de Rosy agotó el límite mensual de búsquedas de LinkedIn. El sistema no lo notó: siguió reportando búsquedas sanas con cero resultados.

## El problema, dicho una sola vez

Este sistema depende de cosas que **no controlamos y cambian sin avisar**: el DOM de LinkedIn, sus cuotas, su markup. Cuando una de esas dependencias se cae, el código casi nunca falla — **degrada**. Y hasta hoy degradaba en silencio, con una cara indistinguible de la de funcionar bien.

Los incidentes de agosto son el mismo incidente:

| Fecha | Qué se rompió | Qué mostró el sistema |
|---|---|---|
| 8-13 ago | LinkedIn rechazaba invites por límite semanal | `sent` — 5 días de invites fantasma, FUs a no-conexiones |
| 12 ago | LinkedIn quitó el URN del markup de empresas | empresas resueltas "bien", búsqueda degradada a texto libre |
| 17 ago | La búsqueda degradada traía gente de otras empresas | leads normales, 55% de otra compañía |
| 17 ago | Un carácter NUL tiraba el `result` en jsonb | accept-detection "muerta" → conexiones inferidas por ausencia |
| 22 ago | Cuenta sin cuota mensual de búsqueda | `status: ok`, `stopReason: no_results_found` |
| 21-23 ago | El fix del URN doble-encodeaba los slugs con acento → 404 | `urnSource: null`, empresa `unresolved`, búsqueda degradada |
| 21-24 ago | Groq devolvía `content` vacío (233/233) y la cadena caía a un modelo gratis al azar | mensajes "generados"; 4 leads recibieron el razonamiento del modelo |
| 17-28 ago | 10 leads pausados a propósito por `off_list_company` | conversaciones sin seguimiento, sin motivo visible → se reportó como P1 del motor de FU |

En todos los casos la avería fue barata y **el silencio fue caro**: días de operación quemada antes de que un humano lo notara mirando una pantalla.

## Decisión

**Ningún camino puede devolver un estado sano cuando en realidad está bloqueado.** De ahí salen siete reglas concretas.

### 1. Cero resultados no es un estado terminal válido

`no_results_found` hoy tapa tres causas que exigen acciones opuestas:

- **nadie cuadra** con ese puesto en esa empresa → avanzar el cursor, todo bien;
- **la cuenta está bloqueada** por cuota → parar la cuenta, avisar, no gastar más;
- **el selector drifteó** → arreglar el scraper.

Tratarlas igual es lo que dejó a Rosy buscando contra una pared. Cuando el DOM traiga la señal de bloqueo, el resultado se llama por su nombre.

**Precedente que ya existe y hay que copiar, no inventar**: `detectInviteLimitModal()` (`content.js`) devuelve `error: 'weekly_invite_limit'` y el bridge pausa invites 24 h a nivel cuenta. Ese fix es de la v0.10.17 y su comentario describe exactamente esta misma avería del lado de invites. **La lección estaba aprendida y no se cruzó al camino de búsqueda.** Ese cruce es la mitad del valor de este ADR.

### 2. Toda degradación tiene nombre, se persiste y se ve

Un fallback es una decisión de producto, no un detalle. Si el sistema decide operar en modo peor, eso se escribe (`urnSource`, `stopReason`, `error`) y **sale en una vista de salud**, no solo en un `console.log` que nadie lee a las 3 a.m.

Regla práctica: **si hay que correr un query a mano para saber si algo lleva días degradado, falta observabilidad.**

**Corolario (28-ago-2026): persistir no es mostrar, y esto vale también para las pausas
deliberadas.** `leads.last_failure_reason` guardaba `off_list_company` desde el 17-ago y
ninguna vista lo enseñaba — el CRM pinta un badge de "pausada" sin decir por qué, y la
pantalla que sí traduce motivos filtra por `quarantined_at`, que en estos leads es NULL. El cliente encontró conversaciones sin seguimiento, no halló
explicación en pantalla y abrió un P1 contra el motor de follow-ups — que estaba sano: la
consulta de leads vencidos daba cero. **Un estado correcto pero invisible cuesta lo mismo
que una avería**, y además gasta la confianza en el sistema. Ver
[ADR-0005](0005-escalera-de-severidad-del-lead.md) §4.

### 3. Un gate de versión por capacidad, no uno global

`COMPANY_SCOPED_MIN_VERSION = '0.10.0'` decide si una cuenta busca por empresa. Pero recuperar el URN llegó en **0.10.31**. Una cuenta en 0.10.10 **pasa el gate como lista** y degrada a texto libre para siempre, sin decir nada.

Cada capacidad que dependa de una versión lleva su propia constante — el patrón ya existe (`CONTACT_INFO_MIN_VERSION`, `WITHDRAW_INVITES_MIN_VERSION`), solo falta aplicarlo aquí.

### 4. Un fix con paso manual no está terminado

Recuperar el URN (0.10.31) exige re-encolar las empresas que quedaron `unresolved`:

```sql
update campaign_target_companies set status='pending', resolve_attempts=0
where status='unresolved';
```

Mientras nadie lo corra, **el fix está desplegado y no sirve**. Un arreglo que depende de que alguien recuerde un `UPDATE` no está cerrado: o se automatiza, o el paso va en el mismo PR con un chequeo que grite si falta.

### 5. Un fix se verifica contra los datos que dominan producción, no contra el primer caso que funciona

El fix del URN (0.10.31) se dio por bueno con una verificación en vivo real — sobre `Continental`. Slug ASCII. Funcionó.

Lo que nadie probó: un slug con acento. Y ahí `encodeURIComponent` sobre un slug **ya** percent-encoded convertía cada `%` en `%25`, apuntaba a una página inexistente y devolvía `urn: null`. Medido dos días después: **ASCII 505/513 resueltas (98.4%), acentuadas 0/7.**

En una cartera mexicana media lista lleva "México", "Querétaro", "Fábricas". O sea: el fix se verificó exactamente contra el subconjunto que no importaba, y falló en el que sostiene el negocio.

La prueba que lo cierra estaba en la base todo el tiempo — dos filas con el **mismo** slug de thyssenkrupp, una con URN (resuelta el 3-ago, pre-corte) y otra sin él (intentada el 22-ago vía el salto nuevo). Misma página, mismo slug, resultado distinto: la URL no llegaba.

**Regla**: al verificar en vivo, elegir el caso por su peso en producción (acentos, nombres largos, multinacionales), no por el que esté a mano. Y si el fix tiene una señal de diagnóstico —aquí `urnSource`— mirar su **distribución**, no un solo éxito.

### 6. Una cadena de fallback degrada la CALIDAD, no solo la disponibilidad

`LLM_PROVIDERS=groq,moonshot,gemini,openrouter` se diseñó para que un proveedor caído no rompiera la generación. Cumplió su objetivo y creó otro problema: **nadie se enteró de que el primario llevaba tres días muerto**, porque siempre contestaba alguien.

Lo medido el 24-ago: Groq falló **233 de 233** llamadas (`empty_response` — `gpt-oss-120b` razona y `max_tokens: 500` se le acababa antes de escribir). Moonshot tapó 135. Las otras **50 las contestó `openrouter/free`**, que no es un modelo sino un alias que rutea a un modelo gratis **distinto en cada llamada**; varios vuelcan su cadena de pensamiento en `content`. Cuatro leads reales recibieron ese análisis en vez de un mensaje.

Dos lecciones separadas:

- **El fallback necesita su propia alarma.** Caer al respaldo es un evento, no un detalle: si el primario falla el 100% de las veces, eso tiene que gritar. Un `console.warn` por llamada no es una alarma — hubo 233 y nadie los vio.
- **El último eslabón define el piso de calidad.** Un respaldo que puede mandar basura a un cliente es peor que no tener respaldo: el FU cae a template verbatim y el auto-reply se salta, y ambas son salidas dignas. **Callar es una opción válida; publicar basura no.**

### 7. El orden de los guards puede fabricar basura con cara de mensaje

El texto que llegó a los leads pasó **todos** los guards: sin placeholders, dentro del cap, terminado en punto. No porque el modelo lo redactara así, sino porque **la truncación corría antes del guard anti-meta**.

El modelo devolvía razonamiento y luego (a veces) la respuesta. Truncar a `maxChars` se quedaba con la **cabeza** —el análisis— y tiraba la respuesta real. Lo que salía de ahí era sintácticamente impecable.

**Regla**: los guards de contenido se corren sobre el texto **crudo del proveedor**, antes de cualquier normalización. Normalizar primero destruye justo las señales por las que se reconoce la basura.

## Caminos descartados — no reintroducir

La razón por la que este archivo existe. Cada uno se probó, dañó a un cliente real y se eliminó:

| Camino | Por qué se descartó | Dónde murió |
|---|---|---|
| **Búsqueda title-only en `companyMode`** | Tira el filtro de empresa: trae competencia directa y, en SalesNav, otros países. Josh recibió un founder de India; Aduanas juntó 19 leads de agencias rivales | `89be071` (10-ago), `ecdad90` (15-ago) |
| **Válvula anti-sequía `COMPANY_DRY_STREAK_ESCAPE`** | Era la puerta trasera al title-only | `89be071` (10-ago) |
| **Grupo booleano `("A" OR "B")` en buscador free** | LinkedIn lo lee como texto literal → cero resultados | 31-jul |
| **Copiar URNs del catálogo entre empresas de nombre parecido** | `alfa` apuntaba al slug `alfa-laval`: son empresas distintas. Atar la empresa equivocada es el peor resultado posible | 21-ago |
| **Escribir `currentCompany` sin facet** | Inventa el dato. Regla `NO_INVENT_COMPANY_RULE` | 27-jul |
| **`openrouter/free` en la cadena LLM** | No es un modelo: rutea a un modelo gratis distinto por llamada. Varios vuelcan su razonamiento en `content` y 4 leads lo recibieron | 24-ago |
| **Filtro de geo naive en el ingest** | Tiró 40 leads mexicanos válidos. El que quedó descarta solo país extranjero explícito | 11-ago |

**La búsqueda degradada por `"nombre exacto"` NO está en esta lista, a propósito.** Sigue siendo on-list y es la única alternativa a no buscar. Es contención, no cura — con ~92% de descarte — pero es deliberada. Confundirla con el title-only descartado es el error de lectura más fácil de cometer aquí.

## Consecuencias

**A favor**: una avería de LinkedIn se nota en horas, no en días de operación quemada. El cliente deja de ser el sistema de monitoreo.

**En contra**: más estados que manejar y una vista de salud que mantener. Y algunos bloqueos solo se distinguen por texto del DOM — que es justo lo que cambia sin avisar, así que la detección misma necesita auditoría. Se acepta: un falso "estoy bloqueado" cuesta una pausa; un falso "todo bien" cuesta una semana.

## Cómo se aplica

Al tocar cualquier camino que hable con LinkedIn, tres preguntas:

1. Si esto falla, ¿el resultado se distingue del éxito? Si no, ponerle nombre al fallo.
2. ¿Depende de una versión de extensión? Gate propio.
3. ¿Requiere un paso manual? Automatizarlo o hacerlo gritar.

Relacionado: `docs/company-scoped-flujo.md` (ground truth del flujo y sus trampas), `docs/ops-runbook.md`.
