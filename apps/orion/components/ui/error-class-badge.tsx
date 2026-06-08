import { classifyCommandError } from "@/lib/error-class";

interface Props {
  error: string | null | undefined;
  status?: string | null;
  size?: "sm" | "md";
  showRawOnHover?: boolean;
}

/** Badge que clasifica un error de comando en cola/infra/ejecución/negocio/seguridad. */
export function ErrorClassBadge({ error, status, size = "sm", showRawOnHover = true }: Props) {
  const c = classifyCommandError(error, status);
  if (c.key === "ok") return null;
  const pad = size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${pad}`}
      style={{ backgroundColor: `${c.color}20`, color: c.color, border: `1px solid ${c.color}40` }}
      title={showRawOnHover ? `${c.hint}${error ? `\n\nError: ${error}` : ""}` : c.hint}
    >
      {c.isFault && <span aria-hidden>●</span>}
      {c.label}
    </span>
  );
}
