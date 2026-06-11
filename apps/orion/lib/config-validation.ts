// Validación del Centro de Control por Cuenta (v0.7.47).
// Errores (hard) bloquean el save; warnings (soft) muestran banner ban-risk pero permiten
// (god_admin override). Importable tanto en server action como client-side (sin deps server).
import { FIELDS, FIELD_BY_KEY } from "./config-fields"

export interface ValidationResult {
  ok: boolean
  errors: { key: string; label: string; msg: string }[]
  warnings: { key: string; label: string; msg: string }[]
}

// values: mapa key→valor ya parseado (number para int/float, string, boolean, string[]).
export function validateAccountConfig(values: Record<string, any>): ValidationResult {
  const errors: ValidationResult["errors"] = []
  const warnings: ValidationResult["warnings"] = []

  for (const f of FIELDS) {
    if (!(f.key in values)) continue
    const v = values[f.key]
    if (v == null || v === "") continue
    if ((f.type === "int" || f.type === "float") && typeof v === "number" && !Number.isNaN(v)) {
      const b = f.bounds ?? {}
      if (b.hardMin != null && v < b.hardMin) errors.push({ key: f.key, label: f.label, msg: `mínimo ${b.hardMin}` })
      if (b.hardMax != null && v > b.hardMax) errors.push({ key: f.key, label: f.label, msg: `máximo ${b.hardMax}` })
      if (b.warnBelow != null && v < b.warnBelow) warnings.push({ key: f.key, label: f.label, msg: `${v} es bajo (recomendado ≥${b.warnBelow}) — riesgo` })
      if (b.warnAbove != null && v > b.warnAbove) warnings.push({ key: f.key, label: f.label, msg: `${v} es alto (recomendado ≤${b.warnAbove}) — riesgo de ban` })
    }
  }

  // Reglas cross-field
  const num = (k: string) => (typeof values[k] === "number" ? values[k] : undefined)
  const pairMaxMin = (minK: string, maxK: string) => {
    const mn = num(minK), mx = num(maxK)
    if (mn != null && mx != null && mx < mn) {
      const f = FIELD_BY_KEY[maxK]
      errors.push({ key: maxK, label: f?.label ?? maxK, msg: "el máx no puede ser menor que el mín" })
    }
  }
  pairMaxMin("auto_reply_delay_min", "auto_reply_delay_max")

  const sStart = num("schedule_start_hour"), sEnd = num("schedule_end_hour")
  if (sStart != null && sEnd != null) {
    if (sEnd <= sStart) errors.push({ key: "schedule_end_hour", label: "Horario", msg: "la hora fin debe ser mayor que la de inicio" })
    else if (sEnd - sStart > 12) warnings.push({ key: "schedule_end_hour", label: "Horario", msg: "ventana >12h se ve poco humana" })
  }

  return { ok: errors.length === 0, errors, warnings }
}
