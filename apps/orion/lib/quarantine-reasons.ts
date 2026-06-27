// Traduce los `last_failure_reason` técnicos (los que escribe lib/lead-failure.js
// del motor Prometheus) a una explicación entendible + acción sugerida.
// Usado por /dashboard/quarantine.

export type QuarantineSeverity = "info" | "warn" | "danger"

export interface QuarantineExplain {
  /** Título corto y humano */
  title: string
  /** Qué pasó, en lenguaje claro */
  detail: string
  /** Qué conviene hacer */
  suggestion: string
  severity: QuarantineSeverity
  /** true si liberar probablemente vuelva a fallar hasta arreglar la causa raíz */
  retryLikelyFails?: boolean
}

/**
 * Normaliza una razón para AGRUPAR (quita los milisegundos variables).
 * "micro_phase_typing_complete_timeout_30225ms" -> "micro_phase_typing_complete_timeout"
 */
export function normalizeReason(raw: string | null | undefined): string {
  const r = (raw ?? "").trim()
  if (!r) return "unknown"
  return r.replace(/_\d+ms$/, "").replace(/_\d+$/, "")
}

/** Explica una razón de cuarentena en español. */
export function explainReason(raw: string | null | undefined): QuarantineExplain {
  const r = (raw ?? "").trim()

  if (!r || r === "unknown") {
    return {
      title: "Razón no registrada",
      detail: "El lead quedó en cuarentena sin una razón específica guardada (registro legacy o reset parcial).",
      suggestion: "Libéralo para reintentar, o márcalo muerto si ya no aplica.",
      severity: "info",
    }
  }

  // micro_phase_<fase>_timeout_<ms>ms  — una micro-fase del envío no completó a tiempo
  const micro = r.match(/^micro_phase_(.+)_timeout_(\d+)ms$/)
  if (micro) {
    const phase = micro[1]
    const secs = Math.round(Number(micro[2]) / 1000)
    if (phase === "typing_complete") {
      return {
        title: "El tecleo del mensaje agotó el tiempo",
        detail: `El mensaje no terminó de escribirse en ~${secs}s. Causa típica: Chrome ralentiza las pestañas en segundo plano (throttling), así que el tecleo "humano" se atasca y nunca confirma.`,
        suggestion: "Liberar para reintentar (idealmente con la pestaña de la extensión visible). Causa raíz en revisión.",
        severity: "warn",
        retryLikelyFails: true,
      }
    }
    return {
      title: `La fase "${phase}" agotó el tiempo`,
      detail: `La micro-fase "${phase}" del envío no se completó en ~${secs}s.`,
      suggestion: "Liberar para reintentar. Si reincide en varios leads, puede ser un cambio de UI de LinkedIn (revisar selectores en Visual Tickets).",
      severity: "warn",
    }
  }

  // exec_hard_timeout_<accion>_<ms>ms — la acción completa excedió el tope duro
  const hard = r.match(/^exec_hard_timeout_(.+)_(\d+)ms$/)
  if (hard) {
    const action = hard[1]
    const secs = Math.round(Number(hard[2]) / 1000)
    return {
      title: `"${action}" excedió el tope duro de ejecución`,
      detail: `La acción "${action}" tardó ~${secs}s en total (tope de seguridad). Suele pasar con mensajes muy largos o pestañas en segundo plano (throttling).`,
      suggestion: "Liberar para reintentar. Si el mensaje es muy largo, considera acortar el template.",
      severity: "warn",
    }
  }

  switch (r) {
    case "thread_editor_not_found":
      return {
        title: "No se encontró el editor del hilo",
        detail: "LinkedIn no mostró el cuadro de texto para responder. Suele ocurrir con cuentas de sistema (p.ej. “The LinkedIn Team”), hilos archivados, o un cambio en el DOM de LinkedIn.",
        suggestion: "Si es una cuenta de sistema/no-lead, márcalo muerto. Si es un lead real, libéralo para reintentar.",
        severity: "warn",
      }
    case "preload_modal_not_rendered":
      return {
        title: "El modal de invitación no cargó",
        detail: "LinkedIn no renderizó el modal de “Conectar” al abrir el perfil (posible cambio de UI, perfil restringido, o límite de invitaciones).",
        suggestion: "Liberar para reintentar. Si reincide, revisar selectores (Visual Tickets). Cuarentena estructural: a los 3 fallos.",
        severity: "danger",
      }
    case "linkedin_security_check":
      return {
        title: "LinkedIn pidió verificación de seguridad",
        detail: "Apareció un checkpoint/captcha durante la acción. La cuenta puede necesitar atención manual.",
        suggestion: "Revisar la cuenta de LinkedIn manualmente antes de liberar.",
        severity: "danger",
      }
    case "profile_not_found":
      return {
        title: "Perfil no encontrado",
        detail: "El perfil del lead ya no existe o la URL cambió.",
        suggestion: "Marcar muerto: el perfil no es alcanzable.",
        severity: "info",
      }
    case "lead_not_messageable":
      return {
        title: "No se puede mensajear al lead",
        detail: "LinkedIn no permite enviar mensaje a este perfil (no conectado / restricciones de privacidad).",
        suggestion: "Liberar si esperas que cambie, o marcar muerto.",
        severity: "info",
      }
    default:
      return {
        title: r,
        detail: "Razón técnica sin traducción amigable todavía.",
        suggestion: "Liberar o marcar muerto según el caso.",
        severity: "info",
      }
  }
}
