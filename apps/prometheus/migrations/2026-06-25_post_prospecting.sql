-- ============================================================================
-- Post-Prospecting Agent — DB migration
-- Aplica con: mcp__supabase__apply_migration (proyecto cjbvutiugmehrhdnfeta)
-- o psql contra la DB de producción. Idempotente donde es posible.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extender constraints de tablas existentes (correr ANTES de insertar valores nuevos)
-- ---------------------------------------------------------------------------

-- leads.status += post_found, commented
alter table leads drop constraint leads_status_check;
alter table leads add constraint leads_status_check check (status = any (array[
  'scraped','pending','processing','disqualified','invite_sent','connected',
  'message_sent','follow_up_sent','follow_up_sent_2','follow_up_sent_3',
  'follow_up_sent_4','follow_up_sent_5','awaiting_response','replied',
  'meeting_booked','failed','dead','thread_lost',
  'post_found','commented'
]));

-- conversation_events.event_type += comment_posted
alter table conversation_events drop constraint conversation_events_event_type_check;
alter table conversation_events add constraint conversation_events_event_type_check check (event_type = any (array[
  'invite_sent','invite_accepted','invite_rejected','message_sent','message_failed',
  'reply_received','reply_sent','follow_up_sent','follow_up_sent_2','follow_up_sent_3',
  'follow_up_sent_4','follow_up_sent_5','meeting_proposed','meeting_confirmed',
  'meeting_booked','note_added','comment_posted'
]));

-- Shadow campaign flag: las campañas-sombra de post quedan ocultas del NAV de personas
alter table campaigns add column if not exists is_shadow boolean not null default false;

-- Contador diario separado para comentarios públicos (nunca comparte el presupuesto de invites)
alter table daily_activity add column if not exists comments_posted integer not null default 0;

-- Extender el RPC de conteo diario con comments_posted
create or replace function public.increment_daily_activity(p_account_id uuid, p_field text)
 returns void
 language plpgsql
as $function$
declare
  mx_today date := (now() at time zone 'America/Mexico_City')::date;
begin
  insert into daily_activity (linkedin_account_id, date, invites_sent, messages_sent, profiles_scraped, errors, comments_posted)
  values (p_account_id, mx_today, 0, 0, 0, 0, 0)
  on conflict (linkedin_account_id, date) do nothing;

  if p_field = 'invites_sent' then
    update daily_activity set invites_sent = invites_sent + 1, updated_at = now()
    where linkedin_account_id = p_account_id and date = mx_today;
  elsif p_field = 'messages_sent' then
    update daily_activity set messages_sent = messages_sent + 1, updated_at = now()
    where linkedin_account_id = p_account_id and date = mx_today;
  elsif p_field = 'profiles_scraped' then
    update daily_activity set profiles_scraped = profiles_scraped + 1, updated_at = now()
    where linkedin_account_id = p_account_id and date = mx_today;
  elsif p_field = 'comments_posted' then
    update daily_activity set comments_posted = comments_posted + 1, updated_at = now()
    where linkedin_account_id = p_account_id and date = mx_today;
  elsif p_field = 'errors' then
    update daily_activity set errors = errors + 1, updated_at = now()
    where linkedin_account_id = p_account_id and date = mx_today;
  end if;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. post_campaigns — tipo de campaña separado para post-prospecting
-- ---------------------------------------------------------------------------
create table if not exists post_campaigns (
  id uuid primary key default gen_random_uuid(),
  linkedin_account_id uuid not null references linkedin_accounts(id) on delete cascade,
  shadow_campaign_id  uuid references campaigns(id) on delete set null,
  name text not null,
  is_active boolean not null default false,
  post_search_paused boolean not null default false,

  -- targeting
  post_keywords text[] not null default '{}',
  post_recency text default 'past-week',          -- token datePosted de LinkedIn

  -- servicio / IA
  service_description text,                        -- qué vendemos (qualifyPost + comment)
  comment_rules text,                             -- guía del comentario value-first
  pitch_note text,                                -- va en la nota PRIVADA de conexión
  gemini_system_prompt text,                       -- persona/voz
  qualify_min_score int not null default 6,        -- umbral 0..10 de qualifyPost

  -- caps / cadencia (bajos y separados de invites)
  daily_comment_target int not null default 5,
  min_comment_gap_min int not null default 0,      -- 0 = dinámico
  search_gap_hours int not null default 12,
  min_pending_threshold int not null default 8,    -- oportunidades esperando revisión
  schedule_start_hour int not null default 9,
  schedule_end_hour int not null default 19,
  schedule_days text[] not null default array['lunes','martes','miércoles','jueves','viernes'],

  -- bookkeeping
  last_searched_at timestamptz,
  last_commented_at timestamptz,
  last_search_keyword_idx int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_post_campaigns_account_active on post_campaigns(linkedin_account_id, is_active);

-- ---------------------------------------------------------------------------
-- 3. post_opportunities — cola de revisión + fuente de graduación a lead
-- ---------------------------------------------------------------------------
create table if not exists post_opportunities (
  id uuid primary key default gen_random_uuid(),
  post_campaign_id uuid not null references post_campaigns(id) on delete cascade,
  linkedin_account_id uuid not null references linkedin_accounts(id) on delete cascade,

  -- post scrapeado
  post_urn text not null,                          -- activity URN, clave de dedup
  post_permalink text,
  post_text text,
  author_name text,
  author_profile_url text,                         -- REQUERIDO para graduar (leads.linkedin_url NOT NULL)
  author_headline text,

  -- IA
  qualify_relevant boolean,
  qualify_score int,
  qualify_reason text,
  draft_comment text,
  edited_comment text,

  -- ciclo de vida
  status text not null default 'scraped',
  rejected_reason text,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  posted_at timestamptz,
  lead_id uuid references leads(id),
  command_id uuid,                                -- extension_commands.id del comment_on_post
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint post_opportunities_status_check check (status in (
    'scraped',          -- insertado por ingestSearchPosts, antes de IA
    'qualifying',
    'disqualified',     -- IA: no relevante / bajo umbral
    'pending_review',   -- tiene draft_comment, espera humano
    'approved',         -- humano aprobó -> scheduler despacha comment+connect
    'dispatched',       -- comment_on_post encolado
    'posted',           -- comentario publicado; lead graduado + connect enviado
    'rejected',         -- humano rechazó
    'failed'            -- error de la extensión
  )),
  constraint post_opportunities_post_urn_campaign_uniq unique (post_campaign_id, post_urn)
);
create index if not exists idx_post_opp_status on post_opportunities(post_campaign_id, status);
create index if not exists idx_post_opp_review on post_opportunities(status) where status = 'pending_review';
create index if not exists idx_post_opp_command on post_opportunities(command_id);
