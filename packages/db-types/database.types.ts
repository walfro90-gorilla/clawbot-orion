export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      account_alerts: {
        Row: {
          alert_type: string
          auto_paused: boolean | null
          campaign_id: string | null
          created_at: string | null
          details: Json | null
          id: number
          linkedin_account_id: string | null
          message: string
          resolved_at: string | null
          resolved_by: string | null
          severity: string
        }
        Insert: {
          alert_type: string
          auto_paused?: boolean | null
          campaign_id?: string | null
          created_at?: string | null
          details?: Json | null
          id?: number
          linkedin_account_id?: string | null
          message: string
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
        }
        Update: {
          alert_type?: string
          auto_paused?: boolean | null
          campaign_id?: string | null
          created_at?: string | null
          details?: Json | null
          id?: number
          linkedin_account_id?: string | null
          message?: string
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_alerts_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_alerts_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "v_campaign_stats"
            referencedColumns: ["campaign_id"]
          },
          {
            foreignKeyName: "account_alerts_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["campaign_id_actual"]
          },
          {
            foreignKeyName: "account_alerts_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_alerts_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      account_connectivity_log: {
        Row: {
          created_at: string
          details: Json | null
          event_type: string
          ext_version: string | null
          id: number
          linkedin_account_id: string
        }
        Insert: {
          created_at?: string
          details?: Json | null
          event_type: string
          ext_version?: string | null
          id?: number
          linkedin_account_id: string
        }
        Update: {
          created_at?: string
          details?: Json | null
          event_type?: string
          ext_version?: string | null
          id?: number
          linkedin_account_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_connectivity_log_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_connectivity_log_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      activity_log: {
        Row: {
          action: string
          created_at: string | null
          details: Json | null
          duration_ms: number | null
          id: number
          lead_id: string | null
          linkedin_account_id: string | null
          result: string | null
        }
        Insert: {
          action: string
          created_at?: string | null
          details?: Json | null
          duration_ms?: number | null
          id?: number
          lead_id?: string | null
          linkedin_account_id?: string | null
          result?: string | null
        }
        Update: {
          action?: string
          created_at?: string | null
          details?: Json | null
          duration_ms?: number | null
          id?: number
          lead_id?: string | null
          linkedin_account_id?: string | null
          result?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_log_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_log_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_log_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_pipeline"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_log_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_log_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      ai_playbook: {
        Row: {
          applies_to_turns: number[]
          created_at: string
          created_by: string | null
          description: string | null
          example_message: string
          id: string
          is_active: boolean
          outcome: string
          outcome_count: number
          situation: string | null
          tags: string[]
          title: string
        }
        Insert: {
          applies_to_turns?: number[]
          created_at?: string
          created_by?: string | null
          description?: string | null
          example_message: string
          id?: string
          is_active?: boolean
          outcome?: string
          outcome_count?: number
          situation?: string | null
          tags?: string[]
          title: string
        }
        Update: {
          applies_to_turns?: number[]
          created_at?: string
          created_by?: string | null
          description?: string | null
          example_message?: string
          id?: string
          is_active?: boolean
          outcome?: string
          outcome_count?: number
          situation?: string | null
          tags?: string[]
          title?: string
        }
        Relationships: []
      }
      appointments: {
        Row: {
          conversation_id: string | null
          created_at: string | null
          duration_min: number
          id: string
          lead_id: string
          location: string | null
          meeting_url: string | null
          outcome: string | null
          reminder_sent: boolean | null
          scheduled_at: string
          status: string
          title: string
          updated_at: string | null
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string | null
          duration_min?: number
          id?: string
          lead_id: string
          location?: string | null
          meeting_url?: string | null
          outcome?: string | null
          reminder_sent?: boolean | null
          scheduled_at: string
          status?: string
          title?: string
          updated_at?: string | null
        }
        Update: {
          conversation_id?: string | null
          created_at?: string | null
          duration_min?: number
          id?: string
          lead_id?: string
          location?: string | null
          meeting_url?: string | null
          outcome?: string | null
          reminder_sent?: boolean | null
          scheduled_at?: string
          status?: string
          title?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "appointments_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["conversation_id"]
          },
          {
            foreignKeyName: "appointments_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_pipeline"
            referencedColumns: ["id"]
          },
        ]
      }
      brain_memory: {
        Row: {
          created_at: string | null
          embedding: string | null
          engagement_score: number | null
          id: string
          key_facts: Json
          last_updated: string | null
          lead_id: string
          summary: string | null
        }
        Insert: {
          created_at?: string | null
          embedding?: string | null
          engagement_score?: number | null
          id?: string
          key_facts?: Json
          last_updated?: string | null
          lead_id: string
          summary?: string | null
        }
        Update: {
          created_at?: string | null
          embedding?: string | null
          engagement_score?: number | null
          id?: string
          key_facts?: Json
          last_updated?: string | null
          lead_id?: string
          summary?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "brain_memory_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: true
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brain_memory_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: true
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brain_memory_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: true
            referencedRelation: "v_lead_pipeline"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          ai_company_context: string | null
          ai_example_messages: string | null
          ai_sender_persona: string | null
          ai_tone: string | null
          auto_dead_after_days: number | null
          auto_reply_delay_max: number | null
          auto_reply_delay_min: number | null
          auto_reply_mode: string | null
          batch_paused: boolean
          created_at: string | null
          daily_invite_target: number
          fm1_example_reply: string | null
          fm2_example_reply: string | null
          fm3_example_reply: string | null
          follow_up_delay_days: number | null
          follow_up_delay_hours: number | null
          follow_up_jitter_hours: number
          follow_up_message: string | null
          follow_up_paused: boolean | null
          follow_up_step2_delay_days: number | null
          follow_up_step2_delay_hours: number | null
          follow_up_step2_message: string | null
          follow_up_step3_delay_days: number | null
          follow_up_step3_delay_hours: number | null
          follow_up_step3_message: string | null
          follow_up_step4_delay_hours: number | null
          follow_up_step4_message: string | null
          follow_up_step5_delay_hours: number | null
          follow_up_step5_message: string | null
          gemini_system_prompt: string
          id: string
          invite_with_note: boolean
          is_active: boolean | null
          last_batch_at: string | null
          last_followup_at: string | null
          last_followup2_at: string | null
          last_followup3_at: string | null
          last_followup4_at: string | null
          last_followup5_at: string | null
          last_search_keyword_idx: number | null
          last_searched_at: string | null
          linkedin_account_id: string | null
          min_batch_gap_min: number
          min_pending_threshold: number
          name: string
          schedule_days: string[] | null
          schedule_end_hour: number
          schedule_start_hour: number
          scheduler_notes: string | null
          search_2nd_degree_only: boolean | null
          search_company_names: string[] | null
          search_count: number | null
          search_gap_hours: number
          search_keywords: string[] | null
          search_location: string | null
          search_min_employees: number | null
          search_paused: boolean
          target_audience: string | null
          title_blacklist: string[] | null
          title_whitelist: string[] | null
        }
        Insert: {
          ai_company_context?: string | null
          ai_example_messages?: string | null
          ai_sender_persona?: string | null
          ai_tone?: string | null
          auto_dead_after_days?: number | null
          auto_reply_delay_max?: number | null
          auto_reply_delay_min?: number | null
          auto_reply_mode?: string | null
          batch_paused?: boolean
          created_at?: string | null
          daily_invite_target?: number
          fm1_example_reply?: string | null
          fm2_example_reply?: string | null
          fm3_example_reply?: string | null
          follow_up_delay_days?: number | null
          follow_up_delay_hours?: number | null
          follow_up_jitter_hours?: number
          follow_up_message?: string | null
          follow_up_paused?: boolean | null
          follow_up_step2_delay_days?: number | null
          follow_up_step2_delay_hours?: number | null
          follow_up_step2_message?: string | null
          follow_up_step3_delay_days?: number | null
          follow_up_step3_delay_hours?: number | null
          follow_up_step3_message?: string | null
          follow_up_step4_delay_hours?: number | null
          follow_up_step4_message?: string | null
          follow_up_step5_delay_hours?: number | null
          follow_up_step5_message?: string | null
          gemini_system_prompt: string
          id?: string
          invite_with_note?: boolean
          is_active?: boolean | null
          last_batch_at?: string | null
          last_followup_at?: string | null
          last_followup2_at?: string | null
          last_followup3_at?: string | null
          last_followup4_at?: string | null
          last_followup5_at?: string | null
          last_search_keyword_idx?: number | null
          last_searched_at?: string | null
          linkedin_account_id?: string | null
          min_batch_gap_min?: number
          min_pending_threshold?: number
          name: string
          schedule_days?: string[] | null
          schedule_end_hour?: number
          schedule_start_hour?: number
          scheduler_notes?: string | null
          search_2nd_degree_only?: boolean | null
          search_company_names?: string[] | null
          search_count?: number | null
          search_gap_hours?: number
          search_keywords?: string[] | null
          search_location?: string | null
          search_min_employees?: number | null
          search_paused?: boolean
          target_audience?: string | null
          title_blacklist?: string[] | null
          title_whitelist?: string[] | null
        }
        Update: {
          ai_company_context?: string | null
          ai_example_messages?: string | null
          ai_sender_persona?: string | null
          ai_tone?: string | null
          auto_dead_after_days?: number | null
          auto_reply_delay_max?: number | null
          auto_reply_delay_min?: number | null
          auto_reply_mode?: string | null
          batch_paused?: boolean
          created_at?: string | null
          daily_invite_target?: number
          fm1_example_reply?: string | null
          fm2_example_reply?: string | null
          fm3_example_reply?: string | null
          follow_up_delay_days?: number | null
          follow_up_delay_hours?: number | null
          follow_up_jitter_hours?: number
          follow_up_message?: string | null
          follow_up_paused?: boolean | null
          follow_up_step2_delay_days?: number | null
          follow_up_step2_delay_hours?: number | null
          follow_up_step2_message?: string | null
          follow_up_step3_delay_days?: number | null
          follow_up_step3_delay_hours?: number | null
          follow_up_step3_message?: string | null
          follow_up_step4_delay_hours?: number | null
          follow_up_step4_message?: string | null
          follow_up_step5_delay_hours?: number | null
          follow_up_step5_message?: string | null
          gemini_system_prompt?: string
          id?: string
          invite_with_note?: boolean
          is_active?: boolean | null
          last_batch_at?: string | null
          last_followup_at?: string | null
          last_followup2_at?: string | null
          last_followup3_at?: string | null
          last_followup4_at?: string | null
          last_followup5_at?: string | null
          last_search_keyword_idx?: number | null
          last_searched_at?: string | null
          linkedin_account_id?: string | null
          min_batch_gap_min?: number
          min_pending_threshold?: number
          name?: string
          schedule_days?: string[] | null
          schedule_end_hour?: number
          schedule_start_hour?: number
          scheduler_notes?: string | null
          search_2nd_degree_only?: boolean | null
          search_company_names?: string[] | null
          search_count?: number | null
          search_gap_hours?: number
          search_keywords?: string[] | null
          search_location?: string | null
          search_min_employees?: number | null
          search_paused?: boolean
          target_audience?: string | null
          title_blacklist?: string[] | null
          title_whitelist?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      conversation_events: {
        Row: {
          ai_generated: boolean
          content: string | null
          conversation_id: string
          created_at: string | null
          direction: string
          event_type: string
          id: string
          metadata: Json | null
          sent_at: string | null
          sent_via: string | null
          subject: string | null
        }
        Insert: {
          ai_generated?: boolean
          content?: string | null
          conversation_id: string
          created_at?: string | null
          direction?: string
          event_type: string
          id?: string
          metadata?: Json | null
          sent_at?: string | null
          sent_via?: string | null
          subject?: string | null
        }
        Update: {
          ai_generated?: boolean
          content?: string | null
          conversation_id?: string
          created_at?: string | null
          direction?: string
          event_type?: string
          id?: string
          metadata?: Json | null
          sent_at?: string | null
          sent_via?: string | null
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversation_events_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_events_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["conversation_id"]
          },
        ]
      }
      conversations: {
        Row: {
          ai_draft_generated_at: string | null
          ai_reply_draft: string | null
          ai_reply_scheduled_at: string | null
          conversation_turn: number | null
          created_at: string | null
          follow_up_count: number
          id: string
          inbox_checked_at: string | null
          last_message_at: string | null
          last_message_text: string | null
          lead_id: string
          linkedin_account_id: string | null
          linkedin_thread_id: string | null
          next_follow_up_at: string | null
          status: string
          updated_at: string | null
        }
        Insert: {
          ai_draft_generated_at?: string | null
          ai_reply_draft?: string | null
          ai_reply_scheduled_at?: string | null
          conversation_turn?: number | null
          created_at?: string | null
          follow_up_count?: number
          id?: string
          inbox_checked_at?: string | null
          last_message_at?: string | null
          last_message_text?: string | null
          lead_id: string
          linkedin_account_id?: string | null
          linkedin_thread_id?: string | null
          next_follow_up_at?: string | null
          status?: string
          updated_at?: string | null
        }
        Update: {
          ai_draft_generated_at?: string | null
          ai_reply_draft?: string | null
          ai_reply_scheduled_at?: string | null
          conversation_turn?: number | null
          created_at?: string | null
          follow_up_count?: number
          id?: string
          inbox_checked_at?: string | null
          last_message_at?: string | null
          last_message_text?: string | null
          lead_id?: string
          linkedin_account_id?: string | null
          linkedin_thread_id?: string | null
          next_follow_up_at?: string | null
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: true
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: true
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: true
            referencedRelation: "v_lead_pipeline"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      crm_audit_log: {
        Row: {
          action: string
          actor_email: string | null
          actor_id: string | null
          created_at: string
          id: number
          lead_id: string | null
          payload_after: Json | null
          payload_before: Json | null
          reason: string | null
          reverted_at: string | null
          reverted_by: string | null
          target_table: string
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          id?: number
          lead_id?: string | null
          payload_after?: Json | null
          payload_before?: Json | null
          reason?: string | null
          reverted_at?: string | null
          reverted_by?: string | null
          target_table?: string
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_id?: string | null
          created_at?: string
          id?: number
          lead_id?: string | null
          payload_after?: Json | null
          payload_before?: Json | null
          reason?: string | null
          reverted_at?: string | null
          reverted_by?: string | null
          target_table?: string
        }
        Relationships: []
      }
      daily_activity: {
        Row: {
          created_at: string | null
          date: string
          errors: number
          id: string
          invites_sent: number
          linkedin_account_id: string
          messages_sent: number
          profiles_scraped: number
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          date?: string
          errors?: number
          id?: string
          invites_sent?: number
          linkedin_account_id: string
          messages_sent?: number
          profiles_scraped?: number
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          date?: string
          errors?: number
          id?: string
          invites_sent?: number
          linkedin_account_id?: string
          messages_sent?: number
          profiles_scraped?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "daily_activity_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_activity_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      extension_commands: {
        Row: {
          account_id: string
          action: string
          completed_at: string | null
          created_at: string
          current_phase: string | null
          dispatched_at: string | null
          error: string | null
          expires_at: string
          id: string
          micro_phase_log: Json | null
          payload: Json
          phase_log: Json | null
          related_lead_id: string | null
          result: Json | null
          status: string
        }
        Insert: {
          account_id: string
          action: string
          completed_at?: string | null
          created_at?: string
          current_phase?: string | null
          dispatched_at?: string | null
          error?: string | null
          expires_at?: string
          id?: string
          micro_phase_log?: Json | null
          payload?: Json
          phase_log?: Json | null
          related_lead_id?: string | null
          result?: Json | null
          status?: string
        }
        Update: {
          account_id?: string
          action?: string
          completed_at?: string | null
          created_at?: string
          current_phase?: string | null
          dispatched_at?: string | null
          error?: string | null
          expires_at?: string
          id?: string
          micro_phase_log?: Json | null
          payload?: Json
          phase_log?: Json | null
          related_lead_id?: string | null
          result?: Json | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "extension_commands_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extension_commands_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "extension_commands_related_lead_id_fkey"
            columns: ["related_lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extension_commands_related_lead_id_fkey"
            columns: ["related_lead_id"]
            isOneToOne: false
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extension_commands_related_lead_id_fkey"
            columns: ["related_lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_pipeline"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_notes: {
        Row: {
          author: string
          content: string
          created_at: string | null
          id: string
          lead_id: string
          priority: number | null
          tags: string[] | null
        }
        Insert: {
          author?: string
          content: string
          created_at?: string | null
          id?: string
          lead_id: string
          priority?: number | null
          tags?: string[] | null
        }
        Update: {
          author?: string
          content?: string
          created_at?: string | null
          id?: string
          lead_id?: string
          priority?: number | null
          tags?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_notes_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_notes_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_notes_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_pipeline"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_status_config: {
        Row: {
          color: string
          description: string | null
          icon: string
          is_automated: boolean
          is_terminal: boolean
          is_visible: boolean
          label_es: string
          stage_order: number
          value: string
        }
        Insert: {
          color: string
          description?: string | null
          icon: string
          is_automated?: boolean
          is_terminal?: boolean
          is_visible?: boolean
          label_es: string
          stage_order: number
          value: string
        }
        Update: {
          color?: string
          description?: string | null
          icon?: string
          is_automated?: boolean
          is_terminal?: boolean
          is_visible?: boolean
          label_es?: string
          stage_order?: number
          value?: string
        }
        Relationships: []
      }
      leads: {
        Row: {
          ai_message: string | null
          ai_qualified: boolean | null
          ai_subject: string | null
          awaiting_response_reason: string | null
          awaiting_response_since: string | null
          campaign_id: string | null
          connected_at: string | null
          consecutive_failures: number
          cooldown_until: string | null
          created_at: string | null
          dead_reason: string | null
          disqualification_reason: string | null
          full_name: string | null
          id: string
          inbound_message: string | null
          inbound_signal: string | null
          inmail_revert_count: number | null
          last_attempt_at: string | null
          last_failure_at: string | null
          last_failure_reason: string | null
          last_followup_at: string | null
          last_followup2_at: string | null
          last_followup3_at: string | null
          last_followup4_at: string | null
          last_followup5_at: string | null
          linkedin_url: string
          lockout_skip_count: number | null
          meeting_at: string | null
          meeting_url: string | null
          next_action_at: string | null
          profile_data: Json | null
          quarantined_at: string | null
          replied_at: string | null
          retry_count: number
          scraped_at: string | null
          sent_at: string | null
          source: string | null
          status: string | null
        }
        Insert: {
          ai_message?: string | null
          ai_qualified?: boolean | null
          ai_subject?: string | null
          awaiting_response_reason?: string | null
          awaiting_response_since?: string | null
          campaign_id?: string | null
          connected_at?: string | null
          consecutive_failures?: number
          cooldown_until?: string | null
          created_at?: string | null
          dead_reason?: string | null
          disqualification_reason?: string | null
          full_name?: string | null
          id?: string
          inbound_message?: string | null
          inbound_signal?: string | null
          inmail_revert_count?: number | null
          last_attempt_at?: string | null
          last_failure_at?: string | null
          last_failure_reason?: string | null
          last_followup_at?: string | null
          last_followup2_at?: string | null
          last_followup3_at?: string | null
          last_followup4_at?: string | null
          last_followup5_at?: string | null
          linkedin_url: string
          lockout_skip_count?: number | null
          meeting_at?: string | null
          meeting_url?: string | null
          next_action_at?: string | null
          profile_data?: Json | null
          quarantined_at?: string | null
          replied_at?: string | null
          retry_count?: number
          scraped_at?: string | null
          sent_at?: string | null
          source?: string | null
          status?: string | null
        }
        Update: {
          ai_message?: string | null
          ai_qualified?: boolean | null
          ai_subject?: string | null
          awaiting_response_reason?: string | null
          awaiting_response_since?: string | null
          campaign_id?: string | null
          connected_at?: string | null
          consecutive_failures?: number
          cooldown_until?: string | null
          created_at?: string | null
          dead_reason?: string | null
          disqualification_reason?: string | null
          full_name?: string | null
          id?: string
          inbound_message?: string | null
          inbound_signal?: string | null
          inmail_revert_count?: number | null
          last_attempt_at?: string | null
          last_failure_at?: string | null
          last_failure_reason?: string | null
          last_followup_at?: string | null
          last_followup2_at?: string | null
          last_followup3_at?: string | null
          last_followup4_at?: string | null
          last_followup5_at?: string | null
          linkedin_url?: string
          lockout_skip_count?: number | null
          meeting_at?: string | null
          meeting_url?: string | null
          next_action_at?: string | null
          profile_data?: Json | null
          quarantined_at?: string | null
          replied_at?: string | null
          retry_count?: number
          scraped_at?: string | null
          sent_at?: string | null
          source?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "v_campaign_stats"
            referencedColumns: ["campaign_id"]
          },
          {
            foreignKeyName: "leads_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["campaign_id_actual"]
          },
        ]
      }
      learned_selectors: {
        Row: {
          created_at: string
          disabled_at: string | null
          disabled_reason: string | null
          enabled: boolean
          hit_count: number
          id: number
          label: string
          last_hit_at: string | null
          last_miss_at: string | null
          miss_count: number
          notes: string | null
          phase_name: string | null
          priority: number
          selector: string
          selector_alternatives: string[] | null
          source_pin_id: number | null
          source_ticket_id: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          disabled_at?: string | null
          disabled_reason?: string | null
          enabled?: boolean
          hit_count?: number
          id?: number
          label: string
          last_hit_at?: string | null
          last_miss_at?: string | null
          miss_count?: number
          notes?: string | null
          phase_name?: string | null
          priority?: number
          selector: string
          selector_alternatives?: string[] | null
          source_pin_id?: number | null
          source_ticket_id?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          disabled_at?: string | null
          disabled_reason?: string | null
          enabled?: boolean
          hit_count?: number
          id?: number
          label?: string
          last_hit_at?: string | null
          last_miss_at?: string | null
          miss_count?: number
          notes?: string | null
          phase_name?: string | null
          priority?: number
          selector?: string
          selector_alternatives?: string[] | null
          source_pin_id?: number | null
          source_ticket_id?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "learned_selectors_source_pin_id_fkey"
            columns: ["source_pin_id"]
            isOneToOne: false
            referencedRelation: "selector_pins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "learned_selectors_source_ticket_id_fkey"
            columns: ["source_ticket_id"]
            isOneToOne: false
            referencedRelation: "selector_tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "learned_selectors_source_ticket_id_fkey"
            columns: ["source_ticket_id"]
            isOneToOne: false
            referencedRelation: "v_selector_tickets_open"
            referencedColumns: ["id"]
          },
        ]
      }
      linkedin_accounts: {
        Row: {
          cal_com_url: string | null
          created_at: string | null
          daily_connection_limit: number | null
          ext_version: string | null
          extension_api_key: string | null
          extension_last_seen_at: string | null
          extension_paused: boolean
          fingerprint_json: Json | null
          fingerprint_locked_at: string | null
          id: string
          inbound_decline_template: string | null
          inbound_enabled: boolean | null
          inbound_qualification_rules: string | null
          inbound_reply_mode: string | null
          inbox_gap_min: number
          inbox_paused: boolean
          label: string | null
          last_inbox_check_at: string | null
          last_sent_invites_check_at: string | null
          li_at_cookie: string
          li_at_cookie_updated_at: string | null
          linkedin_profile_url: string | null
          proxy_checked_at: string | null
          proxy_city: string | null
          proxy_country_code: string | null
          proxy_country_name: string | null
          proxy_ip: string | null
          proxy_url: string | null
          reply_delay_max: number | null
          reply_delay_min: number | null
          sent_invites_gap_min: number
          status: string | null
          timezone: string
          user_id: string | null
          warmup_started_at: string | null
          search_mode: string
          warmup_status: string
        }
        Insert: {
          cal_com_url?: string | null
          created_at?: string | null
          daily_connection_limit?: number | null
          ext_version?: string | null
          extension_api_key?: string | null
          extension_last_seen_at?: string | null
          extension_paused?: boolean
          fingerprint_json?: Json | null
          fingerprint_locked_at?: string | null
          id?: string
          inbound_decline_template?: string | null
          inbound_enabled?: boolean | null
          inbound_qualification_rules?: string | null
          inbound_reply_mode?: string | null
          inbox_gap_min?: number
          inbox_paused?: boolean
          label?: string | null
          last_inbox_check_at?: string | null
          last_sent_invites_check_at?: string | null
          li_at_cookie: string
          li_at_cookie_updated_at?: string | null
          linkedin_profile_url?: string | null
          proxy_checked_at?: string | null
          proxy_city?: string | null
          proxy_country_code?: string | null
          proxy_country_name?: string | null
          proxy_ip?: string | null
          proxy_url?: string | null
          reply_delay_max?: number | null
          reply_delay_min?: number | null
          sent_invites_gap_min?: number
          status?: string | null
          timezone?: string
          user_id?: string | null
          warmup_started_at?: string | null
          search_mode?: string
          warmup_status?: string
        }
        Update: {
          cal_com_url?: string | null
          created_at?: string | null
          daily_connection_limit?: number | null
          ext_version?: string | null
          extension_api_key?: string | null
          extension_last_seen_at?: string | null
          extension_paused?: boolean
          fingerprint_json?: Json | null
          fingerprint_locked_at?: string | null
          id?: string
          inbound_decline_template?: string | null
          inbound_enabled?: boolean | null
          inbound_qualification_rules?: string | null
          inbound_reply_mode?: string | null
          inbox_gap_min?: number
          inbox_paused?: boolean
          label?: string | null
          last_inbox_check_at?: string | null
          last_sent_invites_check_at?: string | null
          li_at_cookie?: string
          li_at_cookie_updated_at?: string | null
          linkedin_profile_url?: string | null
          proxy_checked_at?: string | null
          proxy_city?: string | null
          proxy_country_code?: string | null
          proxy_country_name?: string | null
          proxy_ip?: string | null
          proxy_url?: string | null
          reply_delay_max?: number | null
          reply_delay_min?: number | null
          sent_invites_gap_min?: number
          status?: string | null
          timezone?: string
          user_id?: string | null
          warmup_started_at?: string | null
          search_mode?: string
          warmup_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "linkedin_accounts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      message_templates: {
        Row: {
          campaign_id: string | null
          created_at: string | null
          example_bad: string | null
          example_good: string | null
          id: string
          is_active: boolean
          language: string
          max_chars: number
          message_rules: string | null
          name: string
          opening_hint: string | null
          qualification_rules: string | null
          tone: string
          updated_at: string | null
        }
        Insert: {
          campaign_id?: string | null
          created_at?: string | null
          example_bad?: string | null
          example_good?: string | null
          id?: string
          is_active?: boolean
          language?: string
          max_chars?: number
          message_rules?: string | null
          name: string
          opening_hint?: string | null
          qualification_rules?: string | null
          tone?: string
          updated_at?: string | null
        }
        Update: {
          campaign_id?: string | null
          created_at?: string | null
          example_bad?: string | null
          example_good?: string | null
          id?: string
          is_active?: boolean
          language?: string
          max_chars?: number
          message_rules?: string | null
          name?: string
          opening_hint?: string | null
          qualification_rules?: string | null
          tone?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "message_templates_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_templates_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "v_campaign_stats"
            referencedColumns: ["campaign_id"]
          },
          {
            foreignKeyName: "message_templates_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["campaign_id_actual"]
          },
        ]
      }
      messages_queue: {
        Row: {
          created_at: string | null
          error_log: string | null
          generated_copy: string | null
          id: string
          lead_id: string | null
          linkedin_account_id: string | null
          locked_at: string | null
          scheduled_for: string | null
          status: string | null
          worker_id: string | null
        }
        Insert: {
          created_at?: string | null
          error_log?: string | null
          generated_copy?: string | null
          id?: string
          lead_id?: string | null
          linkedin_account_id?: string | null
          locked_at?: string | null
          scheduled_for?: string | null
          status?: string | null
          worker_id?: string | null
        }
        Update: {
          created_at?: string | null
          error_log?: string | null
          generated_copy?: string | null
          id?: string
          lead_id?: string | null
          linkedin_account_id?: string | null
          locked_at?: string | null
          scheduled_for?: string | null
          status?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_queue_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_queue_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_queue_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_pipeline"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_queue_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_queue_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      orphan_conversations: {
        Row: {
          first_seen_at: string
          id: string
          last_activity_label: string | null
          last_seen_at: string
          linkedin_account_id: string
          linkedin_profile_url: string | null
          linkedin_thread_id: string | null
          matched_lead_id: string | null
          occurrence_count: number
          scraped_name: string
          snippet: string | null
          status: string
          unread_count: number | null
        }
        Insert: {
          first_seen_at?: string
          id?: string
          last_activity_label?: string | null
          last_seen_at?: string
          linkedin_account_id: string
          linkedin_profile_url?: string | null
          linkedin_thread_id?: string | null
          matched_lead_id?: string | null
          occurrence_count?: number
          scraped_name: string
          snippet?: string | null
          status?: string
          unread_count?: number | null
        }
        Update: {
          first_seen_at?: string
          id?: string
          last_activity_label?: string | null
          last_seen_at?: string
          linkedin_account_id?: string
          linkedin_profile_url?: string | null
          linkedin_thread_id?: string | null
          matched_lead_id?: string | null
          occurrence_count?: number
          scraped_name?: string
          snippet?: string | null
          status?: string
          unread_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "orphan_conversations_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orphan_conversations_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "orphan_conversations_matched_lead_id_fkey"
            columns: ["matched_lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orphan_conversations_matched_lead_id_fkey"
            columns: ["matched_lead_id"]
            isOneToOne: false
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orphan_conversations_matched_lead_id_fkey"
            columns: ["matched_lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_pipeline"
            referencedColumns: ["id"]
          },
        ]
      }
      phase_insights: {
        Row: {
          account_id: string | null
          acknowledged: boolean | null
          acknowledged_at: string | null
          acknowledged_by: string | null
          applied_at: string | null
          applied_value: Json | null
          auto_applied: boolean | null
          category: string
          confidence_score: number | null
          details: Json | null
          detected_at: string
          id: number
          message: string
          metric_value: number | null
          phase_name: string | null
          recommended_action: string | null
          rollback_value: Json | null
          sample_size: number | null
          severity: string
          window_hours: number | null
        }
        Insert: {
          account_id?: string | null
          acknowledged?: boolean | null
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          applied_at?: string | null
          applied_value?: Json | null
          auto_applied?: boolean | null
          category: string
          confidence_score?: number | null
          details?: Json | null
          detected_at?: string
          id?: number
          message: string
          metric_value?: number | null
          phase_name?: string | null
          recommended_action?: string | null
          rollback_value?: Json | null
          sample_size?: number | null
          severity?: string
          window_hours?: number | null
        }
        Update: {
          account_id?: string | null
          acknowledged?: boolean | null
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          applied_at?: string | null
          applied_value?: Json | null
          auto_applied?: boolean | null
          category?: string
          confidence_score?: number | null
          details?: Json | null
          detected_at?: string
          id?: number
          message?: string
          metric_value?: number | null
          phase_name?: string | null
          recommended_action?: string | null
          rollback_value?: Json | null
          sample_size?: number | null
          severity?: string
          window_hours?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "phase_insights_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "phase_insights_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      profiles: {
        Row: {
          company_name: string | null
          created_at: string | null
          email: string
          id: string
          linkedin_account_id: string | null
          onboarded_at: string | null
          onboarding_step: string | null
          role: string
        }
        Insert: {
          company_name?: string | null
          created_at?: string | null
          email: string
          id: string
          linkedin_account_id?: string | null
          onboarded_at?: string | null
          onboarding_step?: string | null
          role?: string
        }
        Update: {
          company_name?: string | null
          created_at?: string | null
          email?: string
          id?: string
          linkedin_account_id?: string | null
          onboarded_at?: string | null
          onboarding_step?: string | null
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      runtime_config: {
        Row: {
          insight_id: number | null
          key: string
          previous_value: Json | null
          reason: string | null
          updated_at: string
          updated_by: string
          value: Json
        }
        Insert: {
          insight_id?: number | null
          key: string
          previous_value?: Json | null
          reason?: string | null
          updated_at?: string
          updated_by: string
          value: Json
        }
        Update: {
          insight_id?: number | null
          key?: string
          previous_value?: Json | null
          reason?: string | null
          updated_at?: string
          updated_by?: string
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "runtime_config_insight_id_fkey"
            columns: ["insight_id"]
            isOneToOne: false
            referencedRelation: "phase_insights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "runtime_config_insight_id_fkey"
            columns: ["insight_id"]
            isOneToOne: false
            referencedRelation: "v_phase_insights_unacknowledged"
            referencedColumns: ["id"]
          },
        ]
      }
      runtime_config_heartbeat: {
        Row: {
          account_id: string
          ext_version: string | null
          page_errors_extra: Json | null
          phase_timeouts: Json | null
          reported_at: string
          send_method_order: Json | null
        }
        Insert: {
          account_id: string
          ext_version?: string | null
          page_errors_extra?: Json | null
          phase_timeouts?: Json | null
          reported_at?: string
          send_method_order?: Json | null
        }
        Update: {
          account_id?: string
          ext_version?: string | null
          page_errors_extra?: Json | null
          phase_timeouts?: Json | null
          reported_at?: string
          send_method_order?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "runtime_config_heartbeat_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "runtime_config_heartbeat_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      scheduler_log: {
        Row: {
          account_id: string | null
          batch_size: number | null
          campaign_id: string | null
          created_at: string | null
          details: Json | null
          duration_ms: number | null
          id: number
          job_type: string
          leads_found: number | null
          leads_sent: number | null
          skip_reason: string | null
          status: string
        }
        Insert: {
          account_id?: string | null
          batch_size?: number | null
          campaign_id?: string | null
          created_at?: string | null
          details?: Json | null
          duration_ms?: number | null
          id?: number
          job_type: string
          leads_found?: number | null
          leads_sent?: number | null
          skip_reason?: string | null
          status: string
        }
        Update: {
          account_id?: string | null
          batch_size?: number | null
          campaign_id?: string | null
          created_at?: string | null
          details?: Json | null
          duration_ms?: number | null
          id?: number
          job_type?: string
          leads_found?: number | null
          leads_sent?: number | null
          skip_reason?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduler_log_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduler_log_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "scheduler_log_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduler_log_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "v_campaign_stats"
            referencedColumns: ["campaign_id"]
          },
          {
            foreignKeyName: "scheduler_log_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["campaign_id_actual"]
          },
        ]
      }
      search_jobs: {
        Row: {
          campaign_id: string | null
          completed_at: string | null
          created_at: string | null
          error_log: string | null
          filters: Json
          found_count: number
          id: string
          search_type: string
          started_at: string | null
          status: string
          target_count: number
          updated_at: string | null
        }
        Insert: {
          campaign_id?: string | null
          completed_at?: string | null
          created_at?: string | null
          error_log?: string | null
          filters?: Json
          found_count?: number
          id?: string
          search_type?: string
          started_at?: string | null
          status?: string
          target_count?: number
          updated_at?: string | null
        }
        Update: {
          campaign_id?: string | null
          completed_at?: string | null
          created_at?: string | null
          error_log?: string | null
          filters?: Json
          found_count?: number
          id?: string
          search_type?: string
          started_at?: string | null
          status?: string
          target_count?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "search_jobs_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "search_jobs_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "v_campaign_stats"
            referencedColumns: ["campaign_id"]
          },
          {
            foreignKeyName: "search_jobs_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["campaign_id_actual"]
          },
        ]
      }
      selector_pins: {
        Row: {
          applied_to_runtime: boolean | null
          confidence: number | null
          created_at: string
          extracted_selector: string | null
          id: number
          label: string
          notes: string | null
          pin_x: number
          pin_y: number
          resolved_element: Json | null
          selector_candidates: Json | null
          ticket_id: number
        }
        Insert: {
          applied_to_runtime?: boolean | null
          confidence?: number | null
          created_at?: string
          extracted_selector?: string | null
          id?: number
          label: string
          notes?: string | null
          pin_x: number
          pin_y: number
          resolved_element?: Json | null
          selector_candidates?: Json | null
          ticket_id: number
        }
        Update: {
          applied_to_runtime?: boolean | null
          confidence?: number | null
          created_at?: string
          extracted_selector?: string | null
          id?: number
          label?: string
          notes?: string | null
          pin_x?: number
          pin_y?: number
          resolved_element?: Json | null
          selector_candidates?: Json | null
          ticket_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "selector_pins_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "selector_tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "selector_pins_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "v_selector_tickets_open"
            referencedColumns: ["id"]
          },
        ]
      }
      selector_tickets: {
        Row: {
          account_id: string | null
          command_id: string | null
          created_at: string
          dom_snapshot: Json | null
          id: number
          insight_id: number | null
          phase_name: string
          pinned_count: number
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          screenshot_path: string | null
          screenshot_url: string | null
          scroll_y: number | null
          status: string
          trigger_source: string
          url_at_capture: string | null
          viewport_height: number | null
          viewport_width: number | null
        }
        Insert: {
          account_id?: string | null
          command_id?: string | null
          created_at?: string
          dom_snapshot?: Json | null
          id?: number
          insight_id?: number | null
          phase_name: string
          pinned_count?: number
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          screenshot_path?: string | null
          screenshot_url?: string | null
          scroll_y?: number | null
          status?: string
          trigger_source: string
          url_at_capture?: string | null
          viewport_height?: number | null
          viewport_width?: number | null
        }
        Update: {
          account_id?: string | null
          command_id?: string | null
          created_at?: string
          dom_snapshot?: Json | null
          id?: number
          insight_id?: number | null
          phase_name?: string
          pinned_count?: number
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          screenshot_path?: string | null
          screenshot_url?: string | null
          scroll_y?: number | null
          status?: string
          trigger_source?: string
          url_at_capture?: string | null
          viewport_height?: number | null
          viewport_width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "selector_tickets_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "selector_tickets_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "selector_tickets_command_id_fkey"
            columns: ["command_id"]
            isOneToOne: false
            referencedRelation: "extension_commands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "selector_tickets_insight_id_fkey"
            columns: ["insight_id"]
            isOneToOne: false
            referencedRelation: "phase_insights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "selector_tickets_insight_id_fkey"
            columns: ["insight_id"]
            isOneToOne: false
            referencedRelation: "v_phase_insights_unacknowledged"
            referencedColumns: ["id"]
          },
        ]
      }
      stress_snapshots: {
        Row: {
          account_id: string | null
          after: Json | null
          before: Json
          case_id: string
          id: number
          lead_id: string | null
          notes: string | null
          pass: boolean | null
          restored_at: string | null
          result: Json | null
          taken_at: string
        }
        Insert: {
          account_id?: string | null
          after?: Json | null
          before: Json
          case_id: string
          id?: number
          lead_id?: string | null
          notes?: string | null
          pass?: boolean | null
          restored_at?: string | null
          result?: Json | null
          taken_at?: string
        }
        Update: {
          account_id?: string | null
          after?: Json | null
          before?: Json
          case_id?: string
          id?: number
          lead_id?: string | null
          notes?: string | null
          pass?: boolean | null
          restored_at?: string | null
          result?: Json | null
          taken_at?: string
        }
        Relationships: []
      }
      ui_pattern_failures: {
        Row: {
          account_id: string | null
          action: string
          ai_analyzed_at: string | null
          ai_diagnosis: Json | null
          command_id: string | null
          created_at: string
          dom_snippet: Json | null
          error: string
          ext_version: string | null
          id: string
          labeled_at: string | null
          labeled_by: string | null
          labeled_notes: string | null
          labeled_selector: string | null
          occurrence_count: number
          reason: string | null
          related_lead_id: string | null
          resolved_in_version: string | null
          screenshot_path: string | null
          status: string
          updated_at: string
          url: string | null
        }
        Insert: {
          account_id?: string | null
          action: string
          ai_analyzed_at?: string | null
          ai_diagnosis?: Json | null
          command_id?: string | null
          created_at?: string
          dom_snippet?: Json | null
          error: string
          ext_version?: string | null
          id?: string
          labeled_at?: string | null
          labeled_by?: string | null
          labeled_notes?: string | null
          labeled_selector?: string | null
          occurrence_count?: number
          reason?: string | null
          related_lead_id?: string | null
          resolved_in_version?: string | null
          screenshot_path?: string | null
          status?: string
          updated_at?: string
          url?: string | null
        }
        Update: {
          account_id?: string | null
          action?: string
          ai_analyzed_at?: string | null
          ai_diagnosis?: Json | null
          command_id?: string | null
          created_at?: string
          dom_snippet?: Json | null
          error?: string
          ext_version?: string | null
          id?: string
          labeled_at?: string | null
          labeled_by?: string | null
          labeled_notes?: string | null
          labeled_selector?: string | null
          occurrence_count?: number
          reason?: string | null
          related_lead_id?: string | null
          resolved_in_version?: string | null
          screenshot_path?: string | null
          status?: string
          updated_at?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ui_pattern_failures_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ui_pattern_failures_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "ui_pattern_failures_command_id_fkey"
            columns: ["command_id"]
            isOneToOne: false
            referencedRelation: "extension_commands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ui_pattern_failures_related_lead_id_fkey"
            columns: ["related_lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ui_pattern_failures_related_lead_id_fkey"
            columns: ["related_lead_id"]
            isOneToOne: false
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ui_pattern_failures_related_lead_id_fkey"
            columns: ["related_lead_id"]
            isOneToOne: false
            referencedRelation: "v_lead_pipeline"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_account_today: {
        Row: {
          account_id: string | null
          daily_connection_limit: number | null
          errors_today: number | null
          invites_sent_today: number | null
          label: string | null
          linkedin_profile_url: string | null
          messages_sent_today: number | null
          profiles_scraped_today: number | null
          remaining_quota: number | null
          status: string | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "linkedin_accounts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      v_campaign_stats: {
        Row: {
          acceptance_rate_pct: number | null
          account_label: string | null
          account_profile_url: string | null
          account_status: string | null
          batch_paused: boolean | null
          campaign_id: string | null
          campaign_name: string | null
          connected: number | null
          created_at: string | null
          daily_invite_target: number | null
          disqualified: number | null
          in_queue: number | null
          invite_rate_pct: number | null
          invited: number | null
          is_active: boolean | null
          last_batch_at: string | null
          last_searched_at: string | null
          last_sent_at: string | null
          linkedin_account_id: string | null
          lost: number | null
          meetings: number | null
          messaged: number | null
          min_batch_gap_min: number | null
          min_pending_threshold: number | null
          replied: number | null
          total_leads: number | null
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      v_crm_lead_list: {
        Row: {
          account_label: string | null
          awaiting_response_since: string | null
          campaign_id: string | null
          campaign_id_actual: string | null
          campaign_name: string | null
          connected_at: string | null
          consecutive_failures: number | null
          conversation_id: string | null
          cooldown_until: string | null
          created_at: string | null
          full_name: string | null
          health_flags: Json | null
          health_priority: number | null
          id: string | null
          inbound_count: number | null
          inmail_revert_count: number | null
          is_overdue: boolean | null
          last_attempt_at: string | null
          last_cmd_action: string | null
          last_cmd_at: string | null
          last_cmd_error: string | null
          last_cmd_phase: string | null
          last_cmd_result_reason: string | null
          last_cmd_result_status: string | null
          last_cmd_status: string | null
          last_failure_reason: string | null
          last_followup_at: string | null
          last_followup2_at: string | null
          last_followup3_at: string | null
          last_followup4_at: string | null
          last_followup5_at: string | null
          last_inbound_at: string | null
          last_message_at: string | null
          last_message_text: string | null
          last_outbound_at: string | null
          linkedin_account_id: string | null
          linkedin_url: string | null
          lockout_skip_count: number | null
          next_action_at: string | null
          outbound_count: number | null
          profile_data: Json | null
          quarantined_at: string | null
          recent_error_count_7d: number | null
          replied_at: string | null
          sent_at: string | null
          status: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "leads_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "v_campaign_stats"
            referencedColumns: ["campaign_id"]
          },
          {
            foreignKeyName: "leads_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["campaign_id_actual"]
          },
        ]
      }
      v_lead_phase_stuck: {
        Row: {
          account_id: string | null
          last_seen: string | null
          lead_name: string | null
          occurrences: number | null
          stuck_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "extension_commands_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extension_commands_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      v_lead_pipeline: {
        Row: {
          account_label: string | null
          ai_message: string | null
          ai_qualified: boolean | null
          ai_subject: string | null
          campaign_id: string | null
          campaign_name: string | null
          consecutive_failures: number | null
          cooldown_until: string | null
          created_at: string | null
          disqualification_reason: string | null
          full_name: string | null
          id: string | null
          last_failure_reason: string | null
          linkedin_account_id: string | null
          linkedin_url: string | null
          next_action_at: string | null
          profile_data: Json | null
          quarantined_at: string | null
          replied_at: string | null
          scraped_at: string | null
          sent_at: string | null
          status: string | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_linkedin_account_id_fkey"
            columns: ["linkedin_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
          {
            foreignKeyName: "leads_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "v_campaign_stats"
            referencedColumns: ["campaign_id"]
          },
          {
            foreignKeyName: "leads_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "v_crm_lead_list"
            referencedColumns: ["campaign_id_actual"]
          },
          {
            foreignKeyName: "linkedin_accounts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      v_learned_selectors_health: {
        Row: {
          created_at: string | null
          disabled_reason: string | null
          enabled: boolean | null
          hit_count: number | null
          hit_rate_pct: number | null
          id: number | null
          label: string | null
          last_hit_at: string | null
          last_miss_at: string | null
          miss_count: number | null
          phase_name: string | null
          priority: number | null
          selector: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          disabled_reason?: string | null
          enabled?: boolean | null
          hit_count?: number | null
          hit_rate_pct?: never
          id?: number | null
          label?: string | null
          last_hit_at?: string | null
          last_miss_at?: string | null
          miss_count?: number | null
          phase_name?: string | null
          priority?: number | null
          selector?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          disabled_reason?: string | null
          enabled?: boolean | null
          hit_count?: number | null
          hit_rate_pct?: never
          id?: number | null
          label?: string | null
          last_hit_at?: string | null
          last_miss_at?: string | null
          miss_count?: number | null
          phase_name?: string | null
          priority?: number | null
          selector?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      v_phase_error_pattern_classification: {
        Row: {
          distinct_leads: number | null
          error_msg: string | null
          leads_sample: string[] | null
          occurrences: number | null
          phase_name: string | null
        }
        Relationships: []
      }
      v_phase_insights_unacknowledged: {
        Row: {
          account_id: string | null
          account_label: string | null
          acknowledged: boolean | null
          acknowledged_at: string | null
          acknowledged_by: string | null
          applied_at: string | null
          auto_applied: boolean | null
          category: string | null
          details: Json | null
          detected_at: string | null
          id: number | null
          message: string | null
          metric_value: number | null
          phase_name: string | null
          recommended_action: string | null
          sample_size: number | null
          severity: string | null
          window_hours: number | null
        }
        Relationships: [
          {
            foreignKeyName: "phase_insights_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "phase_insights_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      v_phase_reliability_24h: {
        Row: {
          account_id: string | null
          action: string | null
          avg_ms: number | null
          avg_polls: number | null
          distinct_cmds: number | null
          errors_count: number | null
          occurrences: number | null
          p50_ms: number | null
          p95_ms: number | null
          p99_ms: number | null
          phase_name: string | null
          phase_state: string | null
        }
        Relationships: [
          {
            foreignKeyName: "extension_commands_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extension_commands_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      v_phase_reliability_7d: {
        Row: {
          account_id: string | null
          avg_ms: number | null
          occurrences: number | null
          p95_ms: number | null
          phase_name: string | null
          phase_state: string | null
        }
        Relationships: [
          {
            foreignKeyName: "extension_commands_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extension_commands_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      v_phase_success_rate_24h: {
        Row: {
          account_id: string | null
          ok_count: number | null
          phase_name: string | null
          success_pct: number | null
          timeout_count: number | null
          timeout_pct: number | null
          total: number | null
        }
        Relationships: [
          {
            foreignKeyName: "extension_commands_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extension_commands_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      v_selector_evidence_for_drift: {
        Row: {
          evidence: Json | null
          occurrences: number | null
          phase_name: string | null
        }
        Relationships: []
      }
      v_selector_tickets_open: {
        Row: {
          account_id: string | null
          account_label: string | null
          age_minutes: number | null
          created_at: string | null
          dom_elements_count: number | null
          id: number | null
          phase_name: string | null
          pinned_count: number | null
          screenshot_url: string | null
          status: string | null
          trigger_source: string | null
          url_at_capture: string | null
        }
        Relationships: [
          {
            foreignKeyName: "selector_tickets_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "selector_tickets_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
      v_send_method_distribution_7d: {
        Row: {
          send_method: string | null
          sent_count: number | null
          success_pct: number | null
          total_attempts: number | null
        }
        Relationships: []
      }
      v_timeout_drift_24h_vs_7d: {
        Row: {
          account_id: string | null
          drift_ratio: number | null
          p95_24h: number | null
          p95_7d: number | null
          phase_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "extension_commands_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "linkedin_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extension_commands_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_account_today"
            referencedColumns: ["account_id"]
          },
        ]
      }
    }
    Functions: {
      check_daily_limit: { Args: { p_account_id: string }; Returns: boolean }
      claim_next_job: {
        Args: { p_worker_id: string }
        Returns: {
          created_at: string | null
          error_log: string | null
          generated_copy: string | null
          id: string
          lead_id: string | null
          linkedin_account_id: string | null
          locked_at: string | null
          scheduled_for: string | null
          status: string | null
          worker_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "messages_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_next_lead: {
        Args: { p_campaign_id: string }
        Returns: {
          ai_message: string | null
          ai_qualified: boolean | null
          ai_subject: string | null
          awaiting_response_reason: string | null
          awaiting_response_since: string | null
          campaign_id: string | null
          connected_at: string | null
          consecutive_failures: number
          cooldown_until: string | null
          created_at: string | null
          dead_reason: string | null
          disqualification_reason: string | null
          full_name: string | null
          id: string
          inbound_message: string | null
          inbound_signal: string | null
          inmail_revert_count: number | null
          last_attempt_at: string | null
          last_failure_at: string | null
          last_failure_reason: string | null
          last_followup_at: string | null
          last_followup2_at: string | null
          last_followup3_at: string | null
          last_followup4_at: string | null
          last_followup5_at: string | null
          linkedin_url: string
          lockout_skip_count: number | null
          meeting_at: string | null
          meeting_url: string | null
          next_action_at: string | null
          profile_data: Json | null
          quarantined_at: string | null
          replied_at: string | null
          retry_count: number
          scraped_at: string | null
          sent_at: string | null
          source: string | null
          status: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "leads"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_campaign_account: {
        Args: { p_campaign_id: string }
        Returns: {
          account_id: string
          account_status: string
          daily_limit: number
          label: string
          li_at_cookie: string
          proxy_url: string
        }[]
      }
      get_lead_context: { Args: { p_lead_id: string }; Returns: Json }
      get_next_message_task: {
        Args: { p_worker_id: string }
        Returns: {
          created_at: string | null
          error_log: string | null
          generated_copy: string | null
          id: string
          lead_id: string | null
          linkedin_account_id: string | null
          locked_at: string | null
          scheduled_for: string | null
          status: string | null
          worker_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "messages_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      increment_daily_activity: {
        Args: { p_account_id: string; p_field: string }
        Returns: undefined
      }
      is_admin_or_above: { Args: never; Returns: boolean }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      unaccent: { Args: { "": string }; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
