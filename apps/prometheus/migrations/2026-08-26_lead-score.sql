-- Puntuación de leads (26-ago-2026). Ver apps/prometheus/lib/lead-score.js.
--
-- Aditivo y reversible: todo nullable, ningún default, ningún backfill. Los 2.504 leads
-- previos quedan con lead_score NULL y el picker los puntúa al vuelo con scoreLeadRow(),
-- así que no hace falta reescribir la tabla (Supabase Free, CPU al 99% — evitar el UPDATE
-- masivo es deliberado).

alter table leads add column if not exists lead_score    integer;
alter table leads add column if not exists score_reasons jsonb;

-- Índice para el picker: ordena por score dentro de una campaña sobre el pool 'scraped'.
create index if not exists leads_campaign_score_ix
  on leads (campaign_id, lead_score desc nulls last)
  where status = 'scraped';

-- Whitelist BLANDA: sube el score, NUNCA rechaza. Es el opuesto de title_whitelist, que
-- sigue rechazando igual que siempre.
--
-- Por qué existe: Aduanas Infinity tenía frases completas en title_whitelist ("Gerente de
-- Logística") y como el filtro compara por SUBSTRING solo pasaban 20 de 225 leads (9%) sin
-- que nada lo delatara desde fuera — la campaña "iba lenta" y ya. Un criterio blando que
-- ordena en vez de matar hace que ese error de config cueste orden, no volumen.
alter table campaigns add column if not exists title_preferred text[];

comment on column leads.lead_score is
  'Calidad del perfil 0..100 (lib/lead-score.js). NO incluye pertenencia a la lista de empresas: eso es targeting y vive como llave primaria del picker.';
comment on column campaigns.title_preferred is
  'Whitelist BLANDA: sube lead_score, nunca rechaza. title_whitelist sigue siendo la dura.';
