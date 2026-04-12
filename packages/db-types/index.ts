export * from "./database.types"

import type { Database } from "./database.types"

// Convenience type aliases for common view rows
export type CampaignStats    = Database["public"]["Views"]["v_campaign_stats"]["Row"]
export type AccountToday     = Database["public"]["Views"]["v_account_today"]["Row"]
export type LeadPipeline     = Database["public"]["Views"]["v_lead_pipeline"]["Row"]

// Convenience type aliases for common table rows
export type LeadStatusConfig = Database["public"]["Tables"]["lead_status_config"]["Row"]
export type Lead             = Database["public"]["Tables"]["leads"]["Row"]
export type Campaign         = Database["public"]["Tables"]["campaigns"]["Row"]
export type LinkedInAccount  = Database["public"]["Tables"]["linkedin_accounts"]["Row"]
export type Conversation     = Database["public"]["Tables"]["conversations"]["Row"]
export type AccountAlert     = Database["public"]["Tables"]["account_alerts"]["Row"]
