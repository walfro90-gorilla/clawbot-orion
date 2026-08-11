-- Digest diario de conexiones + scraping de contact-info (11-ago-2026)
--
-- contact_info: {email, phones[], websites[], birthday} scrapeado del overlay
-- /overlay/contact-info/ (visible solo para 1er grado). Centinela {} o {error:...}
-- = "visitado, sin datos" (mismo patrón que profile_data.currentCompany = '').
-- NULL = pendiente de scrape.
alter table leads add column if not exists contact_info    jsonb;
alter table leads add column if not exists contact_info_at timestamptz;

-- Cola de scraping: conectados sin contact_info. Índice parcial → tamaño mínimo.
create index if not exists leads_contact_info_todo
  on leads (connected_at desc)
  where contact_info is null and connected_at is not null;

-- Config del digest (Orion la edita en /dashboard/settings). El ESTADO
-- (last_sent_date, high_water) vive en la key SEPARADA 'daily_digest_state' que
-- solo escribe el scheduler — un save de UI jamás pisa el high-water.
-- ⚠️ updated_by es NOT NULL sin default.
insert into runtime_config (key, value, updated_by)
values ('daily_digest',
        '{"enabled": false, "recipients": [], "send_hour": 7, "tz": "America/Mexico_City"}',
        'migration:2026-08-11')
on conflict (key) do nothing;
