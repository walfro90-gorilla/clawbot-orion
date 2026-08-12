// Parseo compartido de emails del digest diario (columna campaigns.digest_recipients: text[] | null).
// Acepta emails separados por coma o salto de línea. Trim + lowercase + dedup + validación básica.
// Vacío (o todo inválido) → null, NUNCA [] (el digest espera null como "sin destinatarios extra").

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function parseDigestRecipients(raw: string | null | undefined): string[] | null {
  const list = [
    ...new Set(
      (raw ?? "")
        .split(/[\n,]/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => EMAIL_RE.test(s)),
    ),
  ]
  return list.length ? list : null
}
