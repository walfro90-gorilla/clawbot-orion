// Clasificador TOLERANTE de errores de extension_commands.
// Los strings de error en producción son un mix sucio: taxonomía nueva
// (expired_in_queue / content_unreachable / content_died_mid_work), legacy
// (extension_did_not_respond), variantes exec_hard_timeout_*, mensajes de infra
// de Chrome, y reglas de negocio de LinkedIn (lead_not_first_degree) que NO son
// fallos. Este helper los agrupa en clases con color + si es fallo real.

export type ErrorClassKey =
  | "ok" | "queue" | "infra" | "content" | "business" | "security" | "unknown";

export interface ErrorClass {
  key: ErrorClassKey;
  label: string;
  color: string;     // hex, para el patrón de badge con alpha
  isFault: boolean;  // true = fallo real del sistema que merece acción humana
  hint: string;
}

const CLASSES: Record<ErrorClassKey, Omit<ErrorClass, "key">> = {
  ok:       { label: "OK",             color: "#22c55e", isFault: false, hint: "Completado sin error" },
  queue:    { label: "Cola",           color: "#6b7280", isFault: false, hint: "Nunca se despachó (cuenta pausada/offline). No es fallo del sistema" },
  infra:    { label: "Infra",          color: "#f97316", isFault: false, hint: "content.js no recibió el comando (SW/WS). Se reintenta automáticamente" },
  content:  { label: "Ejecución",      color: "#ef4444", isFault: true,  hint: "content.js corrió pero falló (timeout / selector / DOM)" },
  business: { label: "Regla LinkedIn", color: "#3b82f6", isFault: false, hint: "Resultado esperado de LinkedIn (no 1er grado, no mensajeable, esperando respuesta…)" },
  security: { label: "Seguridad",      color: "#a855f7", isFault: false, hint: "Banner de LinkedIn (captcha / bloqueo / sesión). La cuenta se pausa" },
  unknown:  { label: "Otro",           color: "#64748b", isFault: false, hint: "Sin clasificar" },
};

export function classifyCommandError(
  error: string | null | undefined,
  status?: string | null,
): ErrorClass {
  const make = (k: ErrorClassKey): ErrorClass => ({ key: k, ...CLASSES[k] });

  const e = (error ?? "").toLowerCase().trim();
  if (!e || e === "null") {
    return status === "error" || status === "timeout" ? make("unknown") : make("ok");
  }

  // Orden importa: de más específico/seguro a más genérico.
  if (e.includes("expired_in_queue")) return make("queue");

  if (/captcha|checkpoint|account_locked|session_expired|security_check|linkedin_security/.test(e))
    return make("security");

  // Reglas de negocio de LinkedIn — NO son fallos del sistema.
  if (/not_first_degree|not_messageable|invite_still_pending|profile_not_found|awaiting_response|already_responded|inmail_only|still_pending/.test(e))
    return make("business");

  // Infra: content.js nunca recibió el comando (SW killed / WS / no inyectado).
  if (/content_unreachable|extension_did_not_respond|could not establish connection|receiving end does not exist|message channel closed|message port closed|no current window|no window|extension context invalidated/.test(e))
    return make("infra");

  // Ejecución: content.js corrió pero falló.
  if (/content_died_mid_work|exec_hard_timeout|content_busy|typing_incomplete|truncated|button_not_found|editor_not_found|textarea_not|selector|container_not_found|modal_not_rendered|thread_not_found|thread_header_mismatch|_not_found|render/.test(e))
    return make("content");

  return make("unknown");
}
