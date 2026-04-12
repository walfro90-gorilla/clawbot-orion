import type { LeadStatusConfig } from "@clawbot/db-types"

interface Props {
  status: string | null
  configs: LeadStatusConfig[]
  size?: "sm" | "md"
}

export function StatusBadge({ status, configs, size = "md" }: Props) {
  const cfg = configs.find((c) => c.value === status)
  const label = cfg?.label_es ?? status ?? "—"
  const color = cfg?.color ?? "#6b7280"
  const icon  = cfg?.icon  ?? "•"

  const pad = size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs"

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${pad}`}
      style={{ backgroundColor: `${color}20`, color, border: `1px solid ${color}40` }}
    >
      <span>{icon}</span>
      {label}
    </span>
  )
}
