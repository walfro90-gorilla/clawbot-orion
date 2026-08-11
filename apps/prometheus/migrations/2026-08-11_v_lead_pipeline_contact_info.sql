-- v_lead_pipeline + contact_info (11-ago-2026): la página de detalle del lead
-- (leads/[id]) lee de esta vista; expone el email/teléfono scrapeado del overlay.
-- Columna AÑADIDA AL FINAL — requisito de CREATE OR REPLACE VIEW.
create or replace view v_lead_pipeline as
 select l.id,
    l.full_name,
    l.linkedin_url,
    l.status,
    l.ai_qualified,
    l.ai_message,
    l.ai_subject,
    l.disqualification_reason,
    l.sent_at,
    l.replied_at,
    l.next_action_at,
    l.scraped_at,
    l.created_at,
    l.profile_data,
    l.campaign_id,
    c.name as campaign_name,
    c.linkedin_account_id,
    la.label as account_label,
    la.user_id,
    l.consecutive_failures,
    l.cooldown_until,
    l.quarantined_at,
    l.last_failure_reason,
    l.contact_info
   from leads l
     join campaigns c on c.id = l.campaign_id
     join linkedin_accounts la on la.id = c.linkedin_account_id;
