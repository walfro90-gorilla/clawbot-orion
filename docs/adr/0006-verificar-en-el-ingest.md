# ADR-0006 · La empresa y la geografía se verifican al ingerir, no en la URL de búsqueda

- **Estado**: aceptado (11-ago-2026), ampliado (17-ago y 26-ago-2026)
- **Contexto que lo detona**: en Aduanas Infinity, de 104 leads con empresa objetivo, **46 trabajaban en otra** — BWI, Sensata, Dana, Astemo, ISUZU, Samsung, hasta un gerente de una cafetería. Solo 43 en la pedida.
- **Gobierna**: `apps/prometheus/extension-bridge.js`, `apps/prometheus/lib/company-match.js`

## El problema, dicho una sola vez

Lo intuitivo es filtrar en la consulta: meter la geo y la empresa en la URL de búsqueda y confiar en que LinkedIn devuelva solo lo pedido. No funciona, por dos razones distintas:

**La geo no cabe en la URL.** Con el facet de empresa aplicado, añadir `geoUrn` daba **cero resultados** — los dos filtros chocan. Sin él, una empresa multinacional de la lista (hunter douglas, MOLEX, Siemens) surfacea empleados de Brasil, Alemania e India.

**El nombre de empresa sin URN es texto libre.** Desde el 12-ago LinkedIn dejó de exponer el company URN en los resultados de búsqueda, así que toda empresa nueva entra degradada: el nombre viaja como texto y LinkedIn lo matchea tan laxo que devuelve a cualquiera que cuadre con puesto y geo. **En modo degradado el scoping de empresa es decorativo.**

Lo peor: el código ya calculaba `companyIsCertain` desde el 27-jul, pero solo lo usaba para decidir si estampaba `currentCompany`. **No descartaba nada.** La señal existía y no se leía.

## Decisión

**Lo que la URL no puede garantizar, se verifica al insertar.**

`ingestSearch` es el chokepoint: cubre búsqueda free **y** SalesNav sin tocar ningún scraper, y sin depender de la versión de la extensión que tenga cada cuenta.

### 1. Geo — `matchesCampaignGeo`, conservador

Descarta solo si la ubicación nombra un país **extranjero explícito**. Ciudad o región sin país ("Área metropolitana de San Luis Potosí") o location vacía: se conserva. El facet ya garantiza la empresa; no hace falta ser agresivo.

### 2. Empresa — `headlineNamesCompany`, y solo cuando hace falta

Corre únicamente si `targetCompany && !companyIsCertain`. **Con URN resuelto el filtro ni se ejecuta.**

Exige **todos** los tokens significativos, no alguno. Con `some`, "ISUZU **Motors** de México" pasaba como "General **Motors** de México".

### 3. Sin headline no es evidencia en contra — es falta de evidencia

Nombrar otra empresa es motivo de rechazo. **Headline ausente no prueba nada**, y antes se descartaba igual, en silencio. Ahora entra como `disqualified` con `disqualification_reason='needs_review:*'`: fuera del pool invitable, del digest y de la válvula anti-sequía, pero recuperable y contable.

Se eligió reutilizar `disqualified` en vez de crear un estado nuevo porque `leads_status_check` no lo incluye — **vivir dentro del CHECK constraint en lugar de migrarlo** es parte de la decisión.

## Caminos descartados — no reintroducir

| Camino | Por qué se descartó | Dónde murió |
|---|---|---|
| **`geoUrn` en la URL junto al facet de empresa** | Los filtros chocan: cero resultados | `0ae88b1` (11-ago) |
| **Filtro de geo naive (exigir que nombre el país pedido)** | Tiró 40 leads mexicanos válidos cuya location era solo la ciudad | 11-ago |
| **`some` en vez de `every` para los tokens del nombre** | "General Motors de México" pasaba como "ISUZU Motors de México" | `f4c892f` (17-ago) |
| **Filtrar en el scraper de la extensión** | Habría que duplicarlo en free y SalesNav, y quedaría atado a la versión instalada en cada máquina | 11-ago |
| **Descartar en silencio al lead sin headline** | Confunde "no cuadra" con "no sé". Invisible en las métricas | `7e5a378` (26-ago) |
| **Crear un `status` nuevo para el triaje** | `leads_status_check` no lo admite; migrar el constraint por esto no se paga | 26-ago |

## Consecuencias

**A favor**: un solo punto server-side gobierna la calidad de todo lo que entra, cubre los dos modos de búsqueda y no depende de la versión de la extensión.

**En contra**: se gasta cuota de búsqueda trayendo gente que después se descarta — el filtro corrige el resultado, no el gasto. En modo degradado el descarte llega al ~92%.

## Cómo se aplica

1. ¿Un criterio nuevo de calidad del lead? Va en `ingestSearch`, no en la URL ni en el scraper.
2. ¿Comparas nombres de empresa? `every`, nunca `some`.
3. ¿Vas a descartar por un campo que puede venir vacío? Distingue "no cuadra" de "no sé". El segundo se difiere, no se tira.
4. Self-checks obligatorios: `scripts/test-geo-filter.js`, `scripts/test-company-match.js`, `scripts/test-ingest-triage.js` — con los casos reales que motivaron cada regla. Ver [ADR-0008](0008-sin-framework-de-tests.md).

Relacionado: [ADR-0003](0003-nunca-title-only-en-company-scoped.md), `docs/company-scoped-flujo.md`
