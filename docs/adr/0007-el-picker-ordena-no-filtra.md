# ADR-0007 · El picker de invitaciones ordena; filtrar es otra cosa

- **Estado**: aceptado (26-ago-2026)
- **Contexto que lo detona**: Aduanas Infinity tenía cargos completos escritos en `title_whitelist`. Como esa whitelist compara por substring, solo pasaban **20 de 225 leads (9%)** y nada lo delataba: la campaña "iba lenta" y ya.
- **Gobierna**: `apps/prometheus/lib/lead-score.js`, `apps/prometheus/scheduler-extension.js`

## El problema, dicho una sola vez

El techo anti-ban es fijo: entren 10 leads o 500, se invita a ~25 al día. Lo único que mueve la aguja es **gastar esas 25 en los mejores**. Eso es un problema de orden, no de volumen.

Pero los criterios de calidad se habían ido implementando como **filtros**, y un filtro mal configurado no degrada: corta. La whitelist dura de Infinity es el caso de libro — un error de configuración del usuario le costó el 91% de su pool, en silencio, durante semanas.

## Decisión

**Un criterio de calidad sube o baja en la fila. Un criterio de targeting decide quién entra. No se mezclan.**

### 1. `lead_score` mide calidad del perfil, y `fromList` no entra

El picker ordena `fromList > lead_score > FIFO`, corta al top-3 y elige aleatoriamente dentro (humanizar). `fromList` es la llave **primaria**; el score solo desempata dentro de ella.

Sumar `fromList` como puntos rompía la garantía del flujo congelado: un CEO fuera de la lista le ganaba a un coordinador de la lista. **El score mide calidad del perfil; la pertenencia a la lista es targeting.**

### 2. `title_preferred` es una whitelist BLANDA

Sube el score, **nunca rechaza**. Convive con `title_whitelist`, que sigue siendo la dura.

Es el arreglo estructural del caso Infinity: con la blanda, escribir mal los cargos cuesta **orden**, no **volumen**. El error de configuración se vuelve barato.

### 3. Sin backfill

Los leads previos quedan con `lead_score` NULL y los puntúa al vuelo `scoreLeadRow`. Evitar un `UPDATE` masivo sobre 2.500 filas en el tier Free es deliberado — esa base ya se ha caído cuatro veces por CPU.

### 4. Solo señales que ya están en la mano

`seniorityRank`, empresa confirmada por facet, `title_preferred`. Cero llamadas LLM nuevas, cero navegación extra. Los pesos **no están calibrados con datos** porque todavía no los hay: son el orden que el picker ya usaba, escrito explícito. Recalibrar contra tasa de aceptación cuando haya historia.

## Caminos descartados — no reintroducir

| Camino | Por qué se descartó | Dónde murió |
|---|---|---|
| **Sumar `fromList` como puntos del score** | Un CEO fuera de la lista le ganaba a un coordinador de la lista. Rompe la garantía del flujo congelado | `7e5a378` (26-ago) |
| **Endurecer `title_whitelist` para que "funcione bien"** | Reintroduce el fallo del caso Infinity: un error de config cuesta el 91% del pool, en silencio | 26-ago |
| **Backfill de `lead_score` a los leads existentes** | `UPDATE` masivo en Supabase Free sobre una instancia que ya colapsa por CPU | `7e5a378` |
| **Puntuar con el LLM en el ingest** | Coste y latencia en el camino caliente. El upgrade, si hace falta finura, va en el pass de enriquecimiento y sobrescribe `lead_score` sin cambiar la forma de la fila | 26-ago |

## Consecuencias

**A favor**: un error de configuración del cliente degrada el orden, no el volumen. Y por primera vez se puede ver *por qué* se eligió a alguien: `score_reasons` guarda el desglose.

**En contra**: dos whitelists con semánticas opuestas y nombres parecidos. `title_preferred` **parece** una feature a medio hacer, y ese es exactamente el aspecto que invita a "terminarla" endureciéndola.

Pendiente conocido: el top-3 puede caer entero en la misma empresa. Agrupar por empresa al invitar está sin hacer.

## Cómo se aplica

1. ¿La señal nueva dice **quién puede entrar**? Es targeting: va en el picker o en el ingest.
2. ¿Dice **quién es mejor**? Es calidad: va en `lead_score`.
3. Antes de convertir un criterio blando en duro, pregunta qué pasa si el cliente lo escribe mal. Si la respuesta es "se queda sin leads y nadie se entera", déjalo blando.
4. Self-check: `scripts/test-lead-score.js`.

Relacionado: [ADR-0006](0006-verificar-en-el-ingest.md), [ADR-0003](0003-nunca-title-only-en-company-scoped.md)
