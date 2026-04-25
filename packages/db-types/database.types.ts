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
          follow_up_delay_days: number | null
          follow_up_message: string | null
          follow_up_paused: boolean | null
          follow_up_step2_delay_days: number | null
          follow_up_step2_message: string | null
          follow_up_step3_delay_days: number | null
          follow_up_step3_message: string | null
          gemini_system_prompt: string
          id: string
          is_active: boolean | null
          last_batch_at: string | null
          last_followup_at: string | null
          last_followup2_at: string | null
          last_followup3_at: string | null
          last_searched_at: string | null
          linkedin_account_id: string | null
          min_batch_gap_min: number
          min_pending_threshold: number
          name: string
          schedule_end_hour: number
          schedule_start_hour: number
          scheduler_notes: string | null
          search_count: number | null
          search_gap_hours: number
          search_keywords: string[] | null
          search_location: string | null
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
          follow_up_delay_days?: number | null
          follow_up_message?: string | null
          follow_up_paused?: boolean | null
          follow_up_step2_delay_days?: number | null
          follow_up_step2_message?: string | null
          follow_up_step3_delay_days?: number | null
          follow_up_step3_message?: string | null
          gemini_system_prompt: string
          id?: string
          is_active?: boolean | null
          last_batch_at?: string | null
          last_followup_at?: string | null
          last_followup2_at?: string | null
          last_followup3_at?: string | null
          last_searched_at?: string | null
          linkedin_account_id?: string | null
          min_batch_gap_min?: number
          min_pending_threshold?: number
          name: string
          schedule_end_hour?: number
          schedule_start_hour?: number
          scheduler_notes?: string | null
          search_count?: number | null
          search_gap_hours?: number
          search_keywords?: string[] | null
          search_location?: string | null
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
          follow_up_delay_days?: number | null
          follow_up_message?: string | null
          follow_up_paused?: boolean | null
          follow_up_step2_delay_days?: number | null
          follow_up_step2_message?: string | null
          follow_up_step3_delay_days?: number | null
          follow_up_step3_message?: string | null
          gemini_system_prompt?: string
          id?: string
          is_active?: boolean | null
          last_batch_at?: string | null
          last_followup_at?: string | null
          last_followup2_at?: string | null
          last_followup3_at?: string | null
          last_searched_at?: string | null
          linkedin_account_id?: string | null
          min_batch_gap_min?: number
          min_pending_threshold?: number
          name?: string
          schedule_end_hour?: number
          schedule_start_hour?: number
          scheduler_notes?: string | null
          search_count?: number | null
          search_gap_hours?: number
          search_keywords?: string[] | null
          search_location?: string | null
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
          content: string | null
          conversation_id: string
          created_at: string | null
          direction: string
          event_type: string
          id: string
          metadata: Json | null
          sent_at: string | null
          subject: string | null
        }
        Insert: {
          content?: string | null
          conversation_id: string
          created_at?: string | null
          direction?: string
          event_type: string
          id?: string
          metadata?: Json | null
          sent_at?: string | null
          subject?: string | null
        }
        Update: {
          content?: string | null
          conversation_id?: string
          created_at?: string | null
          direction?: string
          event_type?: string
          id?: string
          metadata?: Json | null
          sent_at?: string | null
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
          campaign_id: string | null
          created_at: string | null
          dead_reason: string | null
          disqualification_reason: string | null
          full_name: string | null
          id: string
          last_followup2_at: string | null
          last_followup3_at: string | null
          linkedin_url: string
          meeting_at: string | null
          meeting_url: string | null
          next_action_at: string | null
          profile_data: Json | null
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
          campaign_id?: string | null
          created_at?: string | null
          dead_reason?: string | null
          disqualification_reason?: string | null
          full_name?: string | null
          id?: string
          last_followup2_at?: string | null
          last_followup3_at?: string | null
          linkedin_url: string
          meeting_at?: string | null
          meeting_url?: string | null
          next_action_at?: string | null
          profile_data?: Json | null
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
          campaign_id?: string | null
          created_at?: string | null
          dead_reason?: string | null
          disqualification_reason?: string | null
          full_name?: string | null
          id?: string
          last_followup2_at?: string | null
          last_followup3_at?: string | null
          linkedin_url?: string
          meeting_at?: string | null
          meeting_url?: string | null
          next_action_at?: string | null
          profile_data?: Json | null
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
        ]
      }
      linkedin_accounts: {
        Row: {
          cal_com_url: string | null
          created_at: string | null
          daily_connection_limit: number | null
          id: string
          inbox_gap_min: number
          inbox_paused: boolean
          label: string | null
          last_inbox_check_at: string | null
          li_at_cookie: string
          li_at_cookie_updated_at: string | null
          linkedin_profile_url: string | null
          proxy_url: string | null
          reply_delay_max: number | null
          reply_delay_min: number | null
          status: string | null
          user_id: string | null
          warmup_started_at: string | null
          warmup_status: string
        }
        Insert: {
          cal_com_url?: string | null
          created_at?: string | null
          daily_connection_limit?: number | null
          id?: string
          inbox_gap_min?: number
          inbox_paused?: boolean
          label?: string | null
          last_inbox_check_at?: string | null
          li_at_cookie: string
          li_at_cookie_updated_at?: string | null
          linkedin_profile_url?: string | null
          proxy_url?: string | null
          reply_delay_max?: number | null
          reply_delay_min?: number | null
          status?: string | null
          user_id?: string | null
          warmup_started_at?: string | null
          warmup_status?: string
        }
        Update: {
          cal_com_url?: string | null
          created_at?: string | null
          daily_connection_limit?: number | null
          id?: string
          inbox_gap_min?: number
          inbox_paused?: boolean
          label?: string | null
          last_inbox_check_at?: string | null
          li_at_cookie?: string
          li_at_cookie_updated_at?: string | null
          linkedin_profile_url?: string | null
          proxy_url?: string | null
          reply_delay_max?: number | null
          reply_delay_min?: number | null
          status?: string | null
          user_id?: string | null
          warmup_started_at?: string | null
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
      profiles: {
        Row: {
          company_name: string | null
          created_at: string | null
          email: string
          id: string
          linkedin_account_id: string | null
          onboarded_at: string | null
          role: string
        }
        Insert: {
          company_name?: string | null
          created_at?: string | null
          email: string
          id: string
          linkedin_account_id?: string | null
          onboarded_at?: string | null
          role?: string
        }
        Update: {
          company_name?: string | null
          created_at?: string | null
          email?: string
          id?: string
          linkedin_account_id?: string | null
          onboarded_at?: string | null
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
      v_lead_pipeline: {
        Row: {
          account_label: string | null
          ai_message: string | null
          ai_qualified: boolean | null
          ai_subject: string | null
          campaign_id: string | null
          campaign_name: string | null
          created_at: string | null
          disqualification_reason: string | null
          full_name: string | null
          id: string | null
          linkedin_account_id: string | null
          linkedin_url: string | null
          next_action_at: string | null
          profile_data: Json | null
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
            foreignKeyName: "linkedin_accounts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
          campaign_id: string | null
          created_at: string | null
          dead_reason: string | null
          disqualification_reason: string | null
          full_name: string | null
          id: string
          last_followup2_at: string | null
          last_followup3_at: string | null
          linkedin_url: string
          meeting_at: string | null
          meeting_url: string | null
          next_action_at: string | null
          profile_data: Json | null
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
