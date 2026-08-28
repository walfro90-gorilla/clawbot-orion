# ADR-0004 · Una conexión se confirma por presencia, nunca por ausencia

- **Estado**: aceptado (15-ago-2026)
- **Contexto que lo detona**: 76 seguimientos enviados en dos días a gente que no era contacto de primer grado. El sistema los creía conectados porque habían desaparecido de la lista de invitaciones enviadas.
- **Gobierna**: `apps/prometheus/extension-bridge.js`

## El problema, dicho una sola vez

Hay dos formas de enterarse de que alguien aceptó una invitación:

- **Presencia** — el lead aparece en la lista de conexiones (`check_connections`).
- **Ausencia** — el lead ya no está en `/sent/`, luego "debe haber aceptado".

La segunda es una inferencia, y es ambigua: un lead sale de `/sent/` porque aceptó **o porque la invitación nunca existió**. LinkedIn descarta en silencio envíos automatizados — el modal se cierra igual que en un envío bueno, así que el cierre del modal no prueba nada. Esas invitaciones fantasma salían de `/sent/` sin haber llegado nunca.

Resultado medido: 119 leads marcados como conectados sin estarlo, 76 seguimientos a no-conexiones en dos días, y el churn correspondiente en `detected_not_first_degree`.

## Decisión

**`invite_sent → connected` lo decide solo `check_connections`.** La ausencia en `/sent/` no promueve a nadie.

### La red de seguridad, que es parte de la decisión

Si una cuenta **no ha tenido un `check_connections` con datos en 24 h**, se conserva la inferencia conservadora por ausencia.

Esto no es una concesión: es asimetría de costes deliberada. Un falso `connected` cuesta un mensaje a un desconocido. Un accept real que se pierde cuesta el lead entero — y ya pasó (caso 8-jun). Cuando la detección positiva está ciega, se prefiere el error barato.

## Caminos descartados — no reintroducir

| Camino | Por qué se descartó | Dónde murió |
|---|---|---|
| **Inferir `connected` porque el lead salió de `/sent/`** | Ambiguo: aceptó *o* la invitación era fantasma. 76 FU a no-conexiones en 2 días | `6e0b586` (15-ago) |
| **Ruta agresiva `OLD_ACCEPT_DAYS`** (dar por aceptada una invitación vieja) | Misma inferencia por ausencia, con temporizador | `fda1e82` (4-jul) |
| **Dar por sano un `check_connections` que devolvió pocas conexiones** | Un scan truncado parecía un scan vacío. Sellaba salud con datos parciales | `b4bfe65` (18-ago) |
| **Quitar la red de seguridad de 24 h "porque ya tenemos detección positiva"** | Si el scan de esa cuenta está roto, deja accepts reales sin seguimiento. Es el fallo caro | — (no hacer) |

## Consecuencias

**A favor**: los seguimientos van a conexiones de verdad. Se acaba el churn de `detected_not_first_degree`.

**En contra**: **la decisión depende de que `check_connections` funcione, y esa dependencia es invisible.** Si el scan de una cuenta timeoutea, la detección positiva muere en silencio y todo el sistema retrocede a la inferencia sin decir nada.

Esto no es teórico: **la decisión se revirtió de facto dos veces sin que nadie tocara esta línea de código.** El 18-ago por un TTL demasiado corto que tiraba scans buenos por llegar tarde (`81a9464`); el 21-ago porque un carácter NUL rompía el `result` entero en jsonb, PostgREST respondía *"Empty or invalid json"*, la fila quedaba en timeout y la detección se daba por muerta aunque hubiera ingerido 396 conexiones (`fc81042`, `e5dfce8`). Es la decisión más frágil del repo por vía indirecta.

## Cómo se aplica

1. Al tocar accept-detection, **verifica primero que `check_connections` de esa cuenta devuelva conexiones**. Si timeoutea o sale truncado, la detección positiva ya está muerta y estás depurando el síntoma equivocado.
2. Compara el **log del bridge contra la fila en la base**. Los dos fallos de reversión se veían bien en el log y mal en la fila.
3. ¿Un pico de anomalías? Pide evidencia por lead antes de "corregir" en masa.
4. Nunca promuevas a `connected` desde una señal que sea la ausencia de algo.

Relacionado: [ADR-0001](0001-degradacion-silenciosa.md) (§1, el silencio como avería), [ADR-0005](0005-escalera-de-severidad-del-lead.md)
