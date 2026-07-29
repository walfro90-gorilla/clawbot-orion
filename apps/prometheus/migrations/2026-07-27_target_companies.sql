-- Fase 1 — búsqueda company-scoped real (27-jul-2026)
--
-- Problema: `campaigns.search_company_names` era un array plano rotado por
-- `last_search_keyword_idx % N` y la empresa viajaba como TEXTO dentro del keyword.
-- Sin cursor por empresa, sin facet `currentCompany`, sin memoria de qué empresa ya
-- se visitó. Resultado medido en CAFE 57: 21/182 empresas tocadas, 10% de leads de la
-- lista maestra.
--
-- Esta tabla es el cursor + la caché de resolución de URN. La lista que el usuario
-- edita sigue siendo `campaigns.search_company_names` (sin UI nueva); el scheduler
-- sincroniza filas aquí en cada tick.

create table if not exists campaign_target_companies (
  id                   uuid primary key default gen_random_uuid(),
  campaign_id          uuid not null references campaigns(id) on delete cascade,
  name                 text not null,
  linkedin_urn         text,          -- id numérico de la organización ("1035") para el facet currentCompany
  slug                 text,          -- /company/<slug>/
  status               text not null default 'pending',  -- pending | ready | unresolved
  resolve_attempts     int  not null default 0,
  resolve_attempted_at timestamptz,
  last_searched_at     timestamptz,
  leads_found          int  not null default 0,
  sort_order           int  not null default 0,   -- posición en la lista del usuario (29-jul)
  created_at           timestamptz not null default now()
);

-- Idempotencia del sync nombre→fila (case-insensitive).
create unique index if not exists campaign_target_companies_uniq
  on campaign_target_companies (campaign_id, lower(name));

-- Cursor: siguiente empresa = la de last_searched_at más viejo (nulls first). En la
-- primera vuelta todas son NULL → desempata sort_order = orden de la lista del usuario.
create index if not exists campaign_target_companies_cursor
  on campaign_target_companies (campaign_id, status, last_searched_at nulls first, sort_order);

-- Mismo patrón que campaign_followups / post_opportunities: RLS on, cero policies
-- → solo service_role (prometheus) accede.
alter table campaign_target_companies enable row level security;
