# Búsqueda por empresa (company-scoped) — ground truth

> **⚠️ FLUJO CONGELADO (3-ago-2026, ext 0.10.9).** Costó 15 bugs encadenados dejarlo
> funcional. NO modificar los archivos de la sección "Piezas" sin (1) leer este doc
> completo, (2) correr `npm test -w apps/prometheus`, y (3) confirmación EXPLÍCITA del
> usuario de que quiere tocar algo que ya funciona. El hook de protección de
> `.claude/hooks/` pide esa confirmación automáticamente.

## Qué hace

La lista maestra de empresas del cliente (`campaigns.search_company_names`, editable en
Orion) se trabaja empresa por empresa: se resuelve la **página corporativa REAL** de cada
una, se busca gente ahí con el **facet nativo `currentCompany`**, un **puesto a la vez**,
y se invita **primero a los leads de la lista, y dentro de la lista al de más
responsabilidad**.

## Piezas (NO tocar sin leer esto)

| Archivo | Qué contiene | Trampas que YA se pagaron |
|---|---|---|
| `apps/prometheus/scheduler-extension.js` | sync de lista→`campaign_target_companies` (TTL 30min, `sort_order`), cursor de empresa (`last_searched_at nulls first`), cursor de puestos por empresa (`title_idx`, pase de `COMPANY_TITLES_PER_PASS=6`), **NUNCA title-only en companyMode** (escape eliminado 10-ago: title-only surfaceaba empresas fuera de la lista + otros países en SalesNav — Josh reportó un competidor de India), autocuración (pase completo sin leads → re-resolver, máx 3), `getEligiblePendingCount` cuenta SOLO leads de la lista en modo empresa, picker `fromList > seniorityRank` | El grupo booleano `OR` NO funciona en free (texto literal → 0 resultados). La válvula vieja BORRABA la lista. El pool viejo congelaba las búsquedas. |
| `apps/prometheus/lib/extension-dispatch.js` | `dispatchSearch` (facet URN, sin geoUrn/minEmployees con empresa; **0.10.10**: cuentas `sales_navigator` usan filtro nativo CURRENT_COMPANY — probado en vivo cmd 8392b757; sin URN → free con `"nombre exacto"`), `dispatchResolveCompanies`, `dispatchReloadExtension`, `seniorityRank`, gates de versión | El OR booleano no existe en free. SalesNav ve toda la plantilla; free solo tu red (Mondelēz: 4 vs plantilla completa). |
| `apps/orion-extension/background.js` | `resolveCompanies` (batch + reintento con **nombre núcleo** si la mejor página <1000 seg), `buildSearchUrl` con `currentCompany`, `reload_extension`, agregador que PASA los campos de diagnóstico | El agregador tiraba `followers/candidates/contentVersion` y los probes salían ciegos. `chrome.runtime.reload()` aplica DISCO, no descarga. |
| `apps/orion-extension/content.js` | `resolveCompanyOnPage`: aislar tarjeta (`_companyResultCard` por slugs), puntuar SOLO el nombre (`_leadingDoubledName` + slug, jamás la descripción), nombre = FILTRO (token distintivo obligatorio, `DISTINCTIVE_HIT`) y tamaño decide entre válidas; `_parseFollowers`; `CONTENT_VERSION` | Subir 4 niveles a ciegas agarraba el contenedor de TODA la lista. Puntuar descripción regalaba el match a proveedores que presumen al cliente. El fallback genérico ató Arca Continental (351k) a "Grupo Aduanero M.S.". |
| `apps/prometheus/extension-bridge.js` | `ingestSearch` etiqueta `targetCompany` (y `currentCompany` SOLO con facet), contador `leads_found`, `ingestResolveCompanies` guarda `followers` + `page_title` | Sin facet NO poblar `currentCompany` (NO_INVENT_COMPANY_RULE). |

## Datos

`campaign_target_companies`: cursor + caché por empresa. `status` pending→ready/unresolved,
`linkedin_urn`, `followers` + `page_title` (auditoría: ¿ató la página correcta?),
`title_idx` (cursor de puestos), `sort_order` (orden de la lista del usuario),
`leads_found`. Sin UI — la lista se edita en Orion como siempre.

## Auditar salud (sin tocar nada)

```sql
-- ¿empresas mal atadas? (nombre vs página elegida, tamaño)
select name, page_title, followers from campaign_target_companies
 where status='ready' order by followers asc nulls first limit 20;
-- ¿el flujo entrega? invites de la lista por día
select date_trunc('day',created_at)::date d, count(*) total,
 count(*) filter (where details->>'fromTargetList'='true') de_la_lista
 from scheduler_log where job_type='batch' group by 1 order by 1 desc limit 7;
```

## Self-checks (correr ANTES de cualquier cambio aquí)

```bash
npm test -w apps/prometheus   # scoring de nombres, cursor de puestos, seniority
```

## Versionado de la extensión (lección cara)

Chrome carga una COPIA, no el repo. `ext_version` reporta el manifest del service worker
— la pestaña puede correr `content.js` VIEJO (por eso existe `contentVersion` en los
resultados y la recarga de pestañas por cambio de versión). Flujo de release:
`publish.sh` (hook post-merge lo corre en cada pull de prod) → operador corre el
one-liner de `/download/install.sh` → `dispatchReloadExtension` aplica sin tocar la
máquina. Verificación real: `linkedin_accounts.ext_version` **y** `contentVersion` en un
`resolve_companies`.

## Perillas de operación (esto SÍ es ajustable sin miedo)

- `campaigns.min_pending_threshold` — cuántos leads DE LA LISTA mantener en cola (Josh 45, Café 30).
- `linkedin_accounts.daily_connection_limit` — cap de invites/día (anti-ban; LinkedIn ~100-200/semana).
- `campaigns.search_gap_hours`, `search_2nd_degree_only`, `COMPANY_TITLES_PER_PASS` (código).
