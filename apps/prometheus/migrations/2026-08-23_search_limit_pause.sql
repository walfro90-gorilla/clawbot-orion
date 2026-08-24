-- Pausa de búsquedas por límite mensual de LinkedIn (23-ago-2026)
--
-- LinkedIn free corta las búsquedas de perfiles al llegar a un tope MENSUAL (Commercial
-- Use Limit): difumina los resultados y ofrece Premium. Hasta la ext 0.10.38 el scraper
-- veía 0 perfiles y devolvía `no_results_found` — o sea "busqué bien y no hay nadie",
-- indistinguible de una empresa sin gente en ese puesto. La cuenta de Rosy pasó días
-- buscando contra una pared mientras el sistema reportaba búsquedas sanas.
--
-- Gemela de `invites_paused_until`, a propósito: MISMA forma, misma semántica, un eje
-- distinto. Se separa de `extension_paused_until` porque ese apaga la cuenta entera —
-- con el límite de búsqueda agotado, los invites, follow-ups e inbox siguen perfectamente
-- válidos y pausarlos costaría negocio real.
alter table linkedin_accounts
  add column if not exists searches_paused_until timestamptz;

comment on column linkedin_accounts.searches_paused_until is
  'Búsquedas pausadas hasta esta fecha por límite mensual de LinkedIn (ext 0.10.38). '
  'NULL = sin pausa. Solo afecta búsquedas; invites/FU/inbox siguen. '
  'El scheduler la respeta en trySearchForCampaign; al expirar, la siguiente búsqueda '
  're-sondea y renueva la pausa si el límite persiste.';
