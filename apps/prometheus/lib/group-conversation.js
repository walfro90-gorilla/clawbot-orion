// Conversaciones GRUPALES de LinkedIn (3+ personas). LinkedIn las nombra
// "Nombre1, Nombre2 y tú" / "Nombre1, Nombre2 y N más" / "Nombre1, Nombre2, +N".
// NO son leads 1:1 — suelen ser intros/referidos donde escriben varios
// participantes. El auto-reply mezcla el contexto de todos y confunde al AI:
// caso Yatin Kalra + Rajveer (2026-06-08) — Orion respondió dirigiéndose al
// DUEÑO de la cuenta ("Walfre, con gusto conversamos…") con contexto de OTRA
// conversación previa. Estos threads NUNCA deben ingerirse como lead ni recibir
// auto-reply/FU; se dejan para manejo humano. Mismo patrón que
// isSystemLinkedInAccount (system-accounts.js).

export function isGroupConversationName(name) {
  const n = (name ?? "").trim();
  if (!n) return false;
  return (
    /\sy\s+t[úu]\b/i.test(n) ||            // "… y tú"
    /\sand\s+you\b/i.test(n) ||           // "… and you"
    /\sy\s+\d+\s+m[áa]s\b/i.test(n) ||     // "… y 3 más"
    /\sand\s+\d+\s+other/i.test(n) ||     // "… and 3 others"
    /,\s*\+\d+/.test(n) ||                // "…, +2"
    (/,/.test(n) && /\s(?:y|and)\s/i.test(n)) // "A, B y C" / "A, B and C"
  );
}
