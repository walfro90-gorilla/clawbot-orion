// Registro ÚNICO de campos del Centro de Control por Cuenta (v0.7.47).
// Fuente de verdad para: enrutar cada campo a su store, validar, renderizar y mostrar el origen.
//   store: 'campaign'  → columna en campaigns (la cuenta toma su campaña activa)
//          'account'   → columna en linkedin_accounts
//          'account_config' → fila key/value en account_config (override sobre runtime_config global)
//   type:  'int' | 'float' | 'text' | 'textarea' | 'bool' | 'list' (CSV) | 'enum' | 'days'
//   autoTuned: el valor lo afina phase-analyzer (L3/L4/L5); editable solo si se "fija" (lock).
//   bounds: hard = error (bloquea save) · soft = warning (banner ban-risk, permite).

export type ConfigType = "int" | "float" | "text" | "textarea" | "bool" | "list" | "enum" | "days"
export type ConfigStore = "campaign" | "account" | "account_config"

export interface ConfigField {
  key: string
  store: ConfigStore
  type: ConfigType
  tab: string
  label: string
  hint?: string
  options?: { value: string; label: string }[]
  autoTuned?: boolean
  bounds?: { hardMin?: number; hardMax?: number; warnBelow?: number; warnAbove?: number }
}

export const TABS = [
  { key: "operacion", label: "⚙️ Operación" },
  { key: "busqueda", label: "🔍 Búsqueda" },
  { key: "seguimientos", label: "💬 Seguimientos" },
  { key: "ia", label: "🧠 IA / Voz" },
  { key: "antiban", label: "🛡️ Anti-ban avanzado" },
] as const

const DAYS = [
  { value: "lunes", label: "Lun" }, { value: "martes", label: "Mar" },
  { value: "miércoles", label: "Mié" }, { value: "jueves", label: "Jue" },
  { value: "viernes", label: "Vie" }, { value: "sábado", label: "Sáb" }, { value: "domingo", label: "Dom" },
]

export const FIELDS: ConfigField[] = [
  // ── Operación ──────────────────────────────────────────────────────────────
  { key: "status", store: "account", type: "enum", tab: "operacion", label: "Estado de la cuenta",
    options: [{value:"active",label:"Activa"},{value:"rate_limited",label:"Rate-limited"},{value:"banned",label:"Baneada"},{value:"disconnected",label:"Desconectada"}] },
  { key: "warmup_status", store: "account", type: "enum", tab: "operacion", label: "Temperatura (warmup)",
    hint: "Limita el cap diario según la edad de la cuenta.",
    options: [{value:"cold",label:"❄️ Cold"},{value:"warming",label:"🌡️ Warming"},{value:"warm",label:"☀️ Warm"},{value:"hot",label:"🔥 Hot"}] },
  { key: "extension_paused", store: "account", type: "bool", tab: "operacion", label: "Pausar toda la cuenta" },
  { key: "daily_connection_limit", store: "account", type: "int", tab: "operacion", label: "Cap diario de invites",
    hint: "Tope de connects/día. No debe exceder la rampa de warmup.", bounds: { hardMin: 1, hardMax: 30, warnAbove: 25 } },
  { key: "timezone", store: "account", type: "text", tab: "operacion", label: "Timezone (IANA)",
    hint: "Ej: America/Mexico_City. Alinea horario de negocio y conteo diario." },
  { key: "inbox_gap_min", store: "account", type: "int", tab: "operacion", label: "Gap entre checks de inbox (min)", bounds: { hardMin: 5, warnBelow: 30 } },
  { key: "inbox_paused", store: "account", type: "bool", tab: "operacion", label: "Pausar inbox" },
  { key: "sent_invites_gap_min", store: "account", type: "int", tab: "operacion", label: "Gap entre checks de invites enviados (min)", bounds: { hardMin: 5 } },
  { key: "min_batch_gap_min", store: "campaign", type: "int", tab: "operacion", label: "Gap entre invites (min)",
    hint: "Minutos entre cada invite. <30 = riesgo de ráfaga.", bounds: { hardMin: 5, warnBelow: 30 } },
  { key: "daily_invite_target", store: "campaign", type: "int", tab: "operacion", label: "Target diario de invites (campaña)", bounds: { hardMin: 1, hardMax: 30, warnAbove: 25 } },
  { key: "search_gap_hours", store: "campaign", type: "int", tab: "operacion", label: "Gap entre búsquedas (h)", bounds: { hardMin: 1, warnBelow: 6 } },
  { key: "min_pending_threshold", store: "campaign", type: "int", tab: "operacion", label: "Umbral de leads pendientes (dispara búsqueda)", bounds: { hardMin: 1 } },
  { key: "schedule_start_hour", store: "campaign", type: "int", tab: "operacion", label: "Hora inicio horario", bounds: { hardMin: 0, hardMax: 23 } },
  { key: "schedule_end_hour", store: "campaign", type: "int", tab: "operacion", label: "Hora fin horario", bounds: { hardMin: 0, hardMax: 23 } },
  { key: "schedule_days", store: "campaign", type: "days", tab: "operacion", label: "Días activos", options: DAYS },

  // ── Búsqueda ───────────────────────────────────────────────────────────────
  { key: "search_keywords", store: "campaign", type: "list", tab: "busqueda", label: "Keywords (coma)", hint: "Títulos a buscar. Se rotan." },
  { key: "search_company_names", store: "campaign", type: "list", tab: "busqueda", label: "Empresas (coma)", hint: "Opcional. Empresa va dentro del keyword (match suave)." },
  { key: "search_location", store: "campaign", type: "text", tab: "busqueda", label: "Ubicación" },
  { key: "search_count", store: "campaign", type: "int", tab: "busqueda", label: "Perfiles por búsqueda", bounds: { hardMin: 1, hardMax: 50 } },
  { key: "search_2nd_degree_only", store: "campaign", type: "bool", tab: "busqueda", label: "Solo 2do grado" },
  { key: "title_whitelist", store: "campaign", type: "list", tab: "busqueda", label: "Whitelist de títulos (coma)" },
  { key: "title_blacklist", store: "campaign", type: "list", tab: "busqueda", label: "Blacklist de títulos (coma)" },

  // ── Seguimientos ───────────────────────────────────────────────────────────
  { key: "follow_up_paused", store: "campaign", type: "bool", tab: "seguimientos", label: "Pausar seguimientos" },
  { key: "follow_up_message", store: "campaign", type: "textarea", tab: "seguimientos", label: "FU1 — mensaje" },
  { key: "follow_up_delay_days", store: "campaign", type: "int", tab: "seguimientos", label: "FU1 — delay (días)", bounds: { hardMin: 0 } },
  { key: "follow_up_step2_message", store: "campaign", type: "textarea", tab: "seguimientos", label: "FU2 — mensaje" },
  { key: "follow_up_step2_delay_hours", store: "campaign", type: "int", tab: "seguimientos", label: "FU2 — delay (h)", bounds: { hardMin: 1 } },
  { key: "follow_up_step3_message", store: "campaign", type: "textarea", tab: "seguimientos", label: "FU3 — mensaje" },
  { key: "follow_up_step3_delay_hours", store: "campaign", type: "int", tab: "seguimientos", label: "FU3 — delay (h)", bounds: { hardMin: 1 } },
  { key: "follow_up_step4_message", store: "campaign", type: "textarea", tab: "seguimientos", label: "FU4 — mensaje" },
  { key: "follow_up_step4_delay_hours", store: "campaign", type: "int", tab: "seguimientos", label: "FU4 — delay (h)", bounds: { hardMin: 1 } },
  { key: "follow_up_step5_message", store: "campaign", type: "textarea", tab: "seguimientos", label: "FU5 — mensaje" },
  { key: "follow_up_step5_delay_hours", store: "campaign", type: "int", tab: "seguimientos", label: "FU5 — delay (h)", bounds: { hardMin: 1 } },
  { key: "followup_tone_directive", store: "campaign", type: "textarea", tab: "seguimientos", label: "Directiva de tono de FU (Gemini)" },
  { key: "auto_dead_after_days", store: "campaign", type: "int", tab: "seguimientos", label: "Auto-dead sin respuesta (días)", bounds: { hardMin: 1 } },
  { key: "auto_reply_mode", store: "campaign", type: "enum", tab: "seguimientos", label: "Modo de auto-respuesta",
    options: [{value:"manual",label:"Manual"},{value:"semi_auto",label:"Semi-auto"},{value:"auto",label:"Auto"}] },
  { key: "auto_reply_delay_min", store: "campaign", type: "int", tab: "seguimientos", label: "Delay auto-reply mín (min)", bounds: { hardMin: 0, warnBelow: 5 } },
  { key: "auto_reply_delay_max", store: "campaign", type: "int", tab: "seguimientos", label: "Delay auto-reply máx (min)", bounds: { hardMin: 0 } },

  // ── IA / Voz ───────────────────────────────────────────────────────────────
  { key: "ai_tone", store: "campaign", type: "enum", tab: "ia", label: "Tono",
    options: [{value:"casual",label:"Casual"},{value:"professional",label:"Profesional"},{value:"executive",label:"Ejecutivo"},{value:"technical",label:"Técnico"}] },
  { key: "ai_sender_persona", store: "campaign", type: "textarea", tab: "ia", label: "Persona del remitente" },
  { key: "ai_company_context", store: "campaign", type: "textarea", tab: "ia", label: "Contexto de empresa/producto" },
  { key: "ai_example_messages", store: "campaign", type: "textarea", tab: "ia", label: "Mensajes de ejemplo (estilo)" },
  { key: "target_audience", store: "campaign", type: "textarea", tab: "ia", label: "Audiencia objetivo" },
  { key: "fm1_example_reply", store: "campaign", type: "textarea", tab: "ia", label: "Ejemplo respuesta FM1 (rapport)" },
  { key: "fm2_example_reply", store: "campaign", type: "textarea", tab: "ia", label: "Ejemplo respuesta FM2 (pitch)" },
  { key: "fm3_example_reply", store: "campaign", type: "textarea", tab: "ia", label: "Ejemplo respuesta FM3 (cierre + cal.com)" },

  // ── Anti-ban avanzado (account_config → runtime_config global → default) ─────
  { key: "max_daily_messages", store: "account_config", type: "int", tab: "antiban", label: "Cap diario de mensajes (FU+auto-reply)",
    hint: "Override del env MAX_DAILY_MESSAGES (default 30).", bounds: { hardMin: 1, hardMax: 50, warnAbove: 30 } },
  { key: "jitter_pct_typing", store: "account_config", type: "float", tab: "antiban", label: "Jitter de typing (0-1)",
    hint: "Aleatoriedad del tecleo. <0.15 = muy robótico.", autoTuned: true, bounds: { hardMin: 0, hardMax: 1, warnBelow: 0.15 } },
  { key: "jitter_pct_fu_delay", store: "account_config", type: "float", tab: "antiban", label: "Jitter de delay de FU (0-1)",
    hint: "Aleatoriedad de los delays FU2-5.", autoTuned: true, bounds: { hardMin: 0, hardMax: 1, warnBelow: 0.15 } },
  { key: "deep_sweep_gap_h", store: "account_config", type: "int", tab: "antiban", label: "Gap del deep sweep de inbox (h)",
    hint: "Cada cuánto el barrido profundo recupera inbounds sepultados (default 20h).", bounds: { hardMin: 4 } },
  { key: "dead_after_lockouts", store: "account_config", type: "int", tab: "antiban", label: "Lockouts antes de marcar dead",
    hint: "Cuántos timeouts 24h antes de matar el lead (default 3).", bounds: { hardMin: 1 } },
]

export const FIELD_BY_KEY: Record<string, ConfigField> = Object.fromEntries(FIELDS.map(f => [f.key, f]))
