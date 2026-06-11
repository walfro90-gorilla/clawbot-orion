// Presets anti-ban del Centro de Control por Cuenta (v0.7.47).
// Bundles seguros aplicables con 1 click. "Aplicar" valida, RESPETA keys fijadas (locked),
// y escribe cada valor a su store (campaign/account/account_config) según FIELD_BY_KEY.
export interface Preset {
  label: string
  emoji: string
  desc: string
  values: Record<string, number | string>
}

export const PRESETS: Record<string, Preset> = {
  conservador: {
    label: "Conservador", emoji: "🐢", desc: "Máxima seguridad anti-ban. Volumen bajo, gaps amplios.",
    values: {
      daily_invite_target: 8, daily_connection_limit: 10, min_batch_gap_min: 90, search_gap_hours: 20,
      inbox_gap_min: 90, sent_invites_gap_min: 480, max_daily_messages: 20,
      jitter_pct_typing: 0.7, jitter_pct_fu_delay: 0.4, auto_reply_delay_min: 8, auto_reply_delay_max: 20,
      schedule_start_hour: 9, schedule_end_hour: 19,
    },
  },
  balanceado: {
    label: "Balanceado", emoji: "⚖️", desc: "Equilibrio volumen/seguridad. Recomendado por defecto.",
    values: {
      daily_invite_target: 15, daily_connection_limit: 18, min_batch_gap_min: 45, search_gap_hours: 12,
      inbox_gap_min: 60, sent_invites_gap_min: 360, max_daily_messages: 30,
      jitter_pct_typing: 0.6, jitter_pct_fu_delay: 0.35, auto_reply_delay_min: 4, auto_reply_delay_max: 12,
      schedule_start_hour: 9, schedule_end_hour: 19,
    },
  },
  agresivo: {
    label: "Agresivo", emoji: "🚀", desc: "Máximo volumen. Solo cuentas calientes (hot). Mayor riesgo.",
    values: {
      daily_invite_target: 22, daily_connection_limit: 25, min_batch_gap_min: 25, search_gap_hours: 6,
      inbox_gap_min: 45, sent_invites_gap_min: 300, max_daily_messages: 30,
      jitter_pct_typing: 0.5, jitter_pct_fu_delay: 0.3, auto_reply_delay_min: 2, auto_reply_delay_max: 8,
      schedule_start_hour: 8, schedule_end_hour: 20,
    },
  },
}
