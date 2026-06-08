// Cuentas de SISTEMA de LinkedIn (no son personas): "LinkedIn Talent Solutions",
// "LinkedIn", "LinkedIn Member", "Sales Navigator", etc. Mandan notificaciones y
// mensajes automáticos que el inbox ingest puede tomar como "replies" → el lead
// queda 'replied' → el auto-reply intenta responderles → thread_editor_not_found
// (no se les puede responder) → loop de fallos. NUNCA deben recibir auto-reply/FU
// ni crearse como leads/orphans.

export function isSystemLinkedInAccount(name) {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return false;
  return (
    /^linkedin(\b|\s|$)/.test(n) ||          // "LinkedIn", "LinkedIn Talent Solutions", "LinkedIn Member"…
    n.includes("talent solutions") ||
    n.includes("sales navigator") ||
    n.includes("linkedin recruiter") ||
    n.includes("linkedin learning") ||
    n.includes("linkedin news")
  );
}
