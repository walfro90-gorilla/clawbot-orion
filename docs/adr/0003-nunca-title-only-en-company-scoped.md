# ADR-0003 · En modo empresa nunca se busca por título suelto

- **Estado**: aceptado (10-ago-2026), reforzado (15-ago-2026)
- **Contexto que lo detona**: Josh, cuya campaña busca en una lista de empresas cliente, recibió como lead a un founder de India — un competidor directo. La búsqueda había caído a title-only por una válvula anti-sequía.
- **Gobierna**: `apps/prometheus/scheduler-extension.js`, `apps/prometheus/lib/extension-dispatch.js`

## El problema, dicho una sola vez

Cuando una campaña define `search_company_names`, cada búsqueda se acota a **una** empresa de la lista con el facet nativo de LinkedIn. Si la lista se agota o las empresas están recién buscadas, no hay leads nuevos ese tick. Eso se siente como una avería y la tentación es obvia: buscar por título sin filtro de empresa "para no quedarnos secos".

Esa tentación se implementó dos veces y las dos hicieron daño:

| Versión | Qué hacía | Daño |
|---|---|---|
| 1ª | Borraba `search_company_names` al detectar sequía | Bucle: la campaña perdía su lista y ya nunca volvía al modo empresa. Anulaba la feature entera |
| 2ª | Tras `dry_search_streak ≥ 5`, UNA búsqueda title-only de reabastecimiento | Tira el filtro de empresa. En SalesNav ignora además la geo. Josh recibió competencia extranjera; Aduanas Infinity juntó 25 leads, ninguno de la lista, incluidas agencias aduanales rivales |

Y aun después de eliminar la válvula, quedaba una puerta lateral: si el modo empresa no lograba resolver un objetivo, el código caía al camino genérico. Por ahí se colaron los 25 leads de Aduanas.

## Decisión

**En `companyMode` no existe ningún camino que busque sin empresa.**

Si todas las empresas están recién buscadas, el cursor repite la más vieja. Si no hay objetivo resoluble, la búsqueda devuelve `skipped: 'no_company_target'` y no se busca.

**Menos leads de la lista es mejor que más leads fuera de parámetros.** Un lead de la competencia no es un lead con menos valor: es daño — se le manda un pitch a un rival y se quema una de las ~25 invitaciones diarias.

## Caminos descartados — no reintroducir

| Camino | Por qué se descartó | Dónde murió |
|---|---|---|
| **Borrar `search_company_names` en sequía** | Bucle que anulaba la feature: la campaña perdía la lista para siempre | 1ª válvula, ago-2026 |
| **Válvula `COMPANY_DRY_STREAK_ESCAPE` (title-only de reabastecimiento)** | Tira el filtro de empresa; en SalesNav además la geo. Josh recibió un competidor de India | `89be071` (10-ago), docs `d992635` |
| **Caer al camino genérico cuando no hay objetivo resoluble** | Última puerta al title-only. 25 leads fuera de lista en Aduanas Infinity | `ecdad90` (15-ago) |
| **Grupo booleano `("A" OR "B")` en el buscador free** | LinkedIn lo lee como texto literal → cero resultados, con el facet correcto aplicado | 31-jul-2026 |

**La búsqueda degradada por `"nombre exacto"` NO está descartada.** Cuando LinkedIn no expone el URN, el nombre viaja como texto libre. Sigue siendo on-list y es la única alternativa a no buscar. Es contención, no cura — y por eso existe [ADR-0006](0006-verificar-en-el-ingest.md), que verifica la empresa al ingerir. Confundir esa degradación con el title-only descartado es el error de lectura más fácil de cometer aquí.

## Consecuencias

**A favor**: todo lead que entra pertenece al universo que el cliente pidió. La feature no se anula sola.

**En contra**: **el síntoma de que esta decisión funciona es indistinguible de una avería.** Una campaña puede pasar días sin traer leads y estar operando exactamente como se diseñó. Eso obliga a auditar antes de "arreglar" — y ya se pagó dos veces por no hacerlo.

## Cómo se aplica

1. ¿Una campaña "no busca"? **Ese es el modo seguro hasta que se demuestre lo contrario.** Audita con las queries de `docs/company-scoped-flujo.md` antes de tocar el scheduler.
2. ¿Vas a añadir un fallback para cuando no haya empresa disponible? No. Repetir la empresa más vieja del cursor es la respuesta.
3. ¿Un cambio nuevo puede dejar `targetCompany` vacío en `companyMode`? Entonces necesita su propio `skipped:`, no un camino alternativo.

Relacionado: `docs/company-scoped-flujo.md` (ground truth y candado), [ADR-0006](0006-verificar-en-el-ingest.md), [ADR-0001](0001-degradacion-silenciosa.md)
