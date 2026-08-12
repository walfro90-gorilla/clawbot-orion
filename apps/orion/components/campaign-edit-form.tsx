"use client"

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react"

// Envuelve el formulario de edición de campaña (server-rendered como children) y
// le agrega 3 cosas que el <form action> plano no daba:
//   1. Dirty-tracking: el botón "Guardar" sólo se habilita cuando hay cambios reales
//      vs. el estado inicial. Sin cambios → deshabilitado (no más submits vacíos).
//   2. Confirmación con summary: al guardar muestra un modal con el diff legible
//      (campo: antes → después) antes de mandar nada al server.
//   3. Feedback de envío: estado "Guardando…" + manejo de error inline. El éxito
//      redirige al listado con ?saved=<nombre> (toast verde allá).
//
// Se invoca el server action manualmente dentro de un useTransition (mismo patrón
// que delete-campaign-btn) para poder interceptar con la confirmación y leer el
// resultado de error sin throw → error.tsx.

type SaveResult = { error: string } | void

interface Props {
  action: (formData: FormData) => Promise<SaveResult>
  accountLabels: Record<string, string>
  children: ReactNode
}

// name del input → etiqueta legible para el summary de cambios.
const LABELS: Record<string, string> = {
  name:                  "Nombre",
  is_active:             "Estado",
  linkedin_account_id:   "Cuenta LinkedIn",
  target_audience:       "Audiencia objetivo",
  daily_invite_target:   "Actividad / día",
  min_batch_gap_min:     "Gap entre batches (min)",
  min_pending_threshold: "Umbral mínimo en cola",
  schedule_start_hour:   "Hora de inicio",
  schedule_end_hour:     "Hora de fin",
  schedule_days:         "Días activos",
  search_gap_hours:      "Gap entre búsquedas (h)",
  batch_paused:          "Pausar envío de invitaciones",
  search_paused:         "Pausar búsqueda de leads",
  follow_up_paused:      "Pausar seguimientos",
  search_keywords:       "Keywords de búsqueda",
  search_location:       "Ubicación",
  search_count:          "Máx. leads por búsqueda",
  search_2nd_degree_only:"Solo conexiones de 2do grado",
  title_whitelist:       "Whitelist de cargos",
  title_blacklist:       "Blacklist de cargos",
  search_company_names:  "Empresas específicas",
  search_min_employees:  "Mínimo de empleados",
  template_name:         "Nombre del template",
  tone:                  "Tono del template",
  language:              "Idioma",
  max_chars:             "Límite de caracteres",
  qualification_rules:   "Reglas de calificación",
  message_rules:         "Reglas de mensaje",
  opening_hint:          "Hint de apertura",
  example_good:          "Ejemplo de mensaje bueno",
  example_bad:           "Ejemplo de mensaje malo",
  followup_tone_directive:"Tono de seguimientos",
  followup_steps_json:   "Secuencia de seguimientos",
  auto_dead_after_days:  "Días hasta marcar Perdido",
  digest_recipients:     "Emails del digest diario",
  fm1_example_reply:     "Ejemplo FM1 (rapport)",
  fm2_example_reply:     "Ejemplo FM2 (profundidad)",
  fm3_example_reply:     "Ejemplo FM3 (cierre)",
  auto_reply_mode:       "Modo de respuesta automática",
  auto_reply_delay_min:  "Retraso mínimo auto-reply (min)",
  auto_reply_delay_max:  "Retraso máximo auto-reply (min)",
  ai_tone:               "Tono de comunicación IA",
  ai_sender_persona:     "Perfil del vendedor",
  ai_company_context:    "Contexto de empresa",
  ai_example_messages:   "Mensajes de ejemplo IA",
}

// Campos checkbox con hidden "false" pareado → su valor real es "incluye true".
const BOOL_FIELDS = new Set([
  "batch_paused", "search_paused", "follow_up_paused", "search_2nd_degree_only",
])

const AUTO_REPLY_MODE_LABELS: Record<string, string> = {
  manual:    "Manual",
  semi_auto: "Semi-automático",
  auto:      "Automático",
}

interface Change { name: string; label: string; before: string; after: string }

// Serializa el form a un mapa name→valor normalizado (comparable y estable).
function readValues(form: HTMLFormElement): Record<string, string> {
  const fd = new FormData(form)
  const out: Record<string, string> = {}
  for (const name of Object.keys(LABELS)) {
    if (name === "schedule_days") {
      out[name] = fd.getAll(name).map(String).sort().join(",")
    } else if (BOOL_FIELDS.has(name)) {
      out[name] = fd.getAll(name).includes("true") ? "true" : "false"
    } else {
      out[name] = String(fd.get(name) ?? "")
    }
  }
  return out
}

export function CampaignEditForm({ action, accountLabels, children }: Props) {
  const formRef    = useRef<HTMLFormElement>(null)
  const initialRef = useRef<Record<string, string> | null>(null)
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [dirty, setDirty]           = useState(false)
  const [changes, setChanges]       = useState<Change[]>([])
  const [confirming, setConfirming] = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  // Snapshot inicial tras montar — para entonces el hidden controlado de
  // followups (followup_steps_json) ya está renderizado con su valor real.
  useEffect(() => {
    if (formRef.current) initialRef.current = readValues(formRef.current)
  }, [])

  // Recalcula dirty tras cada input. El setTimeout deja que React confirme el
  // render (p.ej. followup_steps_json es controlado y se actualiza tras el
  // onChange de los inputs internos del editor) antes de volver a leer el form.
  function scheduleDirtyCheck() {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const form = formRef.current
      const initial = initialRef.current
      if (!form || !initial) return
      const cur = readValues(form)
      setDirty(Object.keys(LABELS).some(k => cur[k] !== initial[k]))
    }, 60)
  }

  function prettify(name: string, raw: string): string {
    if (raw === "") return "(vacío)"
    if (name === "is_active")           return raw === "true" ? "Activa" : "Inactiva"
    if (BOOL_FIELDS.has(name))          return raw === "true" ? "Sí" : "No"
    if (name === "auto_reply_mode")     return AUTO_REPLY_MODE_LABELS[raw] ?? raw
    if (name === "linkedin_account_id") return accountLabels[raw] ?? "Sin cuenta"
    if (name === "followup_steps_json") {
      try {
        const n = (JSON.parse(raw) as unknown[]).length
        return `${n} paso${n === 1 ? "" : "s"}`
      } catch { return "actualizada" }
    }
    const flat = raw.replace(/\s+/g, " ").trim()
    return flat.length > 60 ? flat.slice(0, 60) + "…" : flat
  }

  function computeChanges(): Change[] {
    const form = formRef.current
    const initial = initialRef.current
    if (!form || !initial) return []
    const cur = readValues(form)
    const list: Change[] = []
    for (const name of Object.keys(LABELS)) {
      if (cur[name] !== initial[name]) {
        list.push({ name, label: LABELS[name], before: prettify(name, initial[name]), after: prettify(name, cur[name]) })
      }
    }
    return list
  }

  function openConfirm() {
    if (!dirty || isPending) return
    const list = computeChanges()
    if (list.length === 0) { setDirty(false); return }   // por si acaso quedó dirty fantasma
    setError(null)
    setChanges(list)
    setConfirming(true)
  }

  function doSave() {
    const form = formRef.current
    if (!form) return
    const fd = new FormData(form)
    startTransition(async () => {
      // Éxito → el action hace redirect (no retorna). Error → { error }.
      const res = await action(fd)
      if (res?.error) setError(res.error)
    })
  }

  return (
    <form
      ref={formRef}
      // noValidate: el form vive dentro de tabs con display:none (CampaignTabs). Si un campo
      // con min/max/required queda fuera de rango en una tab INACTIVA (p.ej. min_batch_gap_min=0
      // vs min=30 en la tab General), la validación nativa del submit intenta enfocar ese input
      // oculto, no puede ("An invalid form control is not focusable") y ABORTA el submit en
      // silencio → el botón "no hace nada" al editar desde otra tab. La validación real la hace
      // el server action (devuelve {error}) + el modal de confirmación; los min/max quedan como
      // hint visual. ponytail: sin esto, cualquier valor legado fuera de rango rompe el guardado.
      noValidate
      onSubmit={(e) => { e.preventDefault(); openConfirm() }}
      onInput={scheduleDirtyCheck}
      onChange={scheduleDirtyCheck}
      // onClick cubre cambios que no emiten input/change: los botones del editor
      // de seguimientos (➕ agregar / 🗑️ eliminar paso) mutan followup_steps_json
      // vía onClick. Un re-check de más en clicks no-op es inofensivo (sólo compara).
      onClick={scheduleDirtyCheck}
      className="space-y-6"
    >
      {children}

      {/* ── ACTIONS — sticky, siempre visibles fuera de las tabs ───────────── */}
      <div className="flex items-center gap-3 pt-2 sticky bottom-0 -mx-4 sm:-mx-8 px-4 sm:px-8 py-4 bg-gray-950/95 backdrop-blur border-t border-gray-800 z-10">
        <button
          type="submit"
          disabled={!dirty || isPending}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
        >
          {isPending ? "Guardando…" : "Guardar cambios"}
        </button>
        <button
          type="button"
          onClick={() => {
            if (dirty && !confirm("Tienes cambios sin guardar. ¿Salir y descartarlos?")) return
            window.location.href = "/dashboard/campaigns"
          }}
          className="px-6 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium text-sm rounded-lg transition-colors"
        >
          Cancelar
        </button>
        <span className={`text-xs ${dirty ? "text-blue-300/80" : "text-gray-500"}`}>
          {isPending ? "" : dirty ? "Cambios sin guardar." : "No hay cambios por guardar."}
        </span>
      </div>

      {/* ── CONFIRM MODAL — summary del diff antes de mandar ───────────────── */}
      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => { if (!isPending) setConfirming(false) }}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl max-w-lg w-full max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-gray-800">
              <h2 className="text-lg font-bold text-gray-50">Confirmar cambios</h2>
              <p className="text-sm text-gray-400 mt-0.5">
                Vas a guardar {changes.length} cambio{changes.length === 1 ? "" : "s"} en esta campaña.
              </p>
            </div>

            <div className="px-6 py-4 overflow-y-auto space-y-3">
              {changes.map((c) => (
                <div key={c.name} className="text-sm">
                  <div className="text-gray-300 font-medium">{c.label}</div>
                  <div className="flex items-center gap-2 text-xs mt-1 flex-wrap">
                    <span className="px-2 py-0.5 rounded bg-red-500/10 text-red-300/90 border border-red-500/20 line-through decoration-red-400/40 break-all">
                      {c.before}
                    </span>
                    <span className="text-gray-600">→</span>
                    <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 break-all">
                      {c.after}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {error && (
              <div className="mx-6 mb-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-300">
                ⚠️ No se pudo guardar: {error}
              </div>
            )}

            <div className="px-6 py-4 border-t border-gray-800 flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={isPending}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-lg transition-colors disabled:opacity-50"
              >
                Volver
              </button>
              <button
                type="button"
                onClick={doSave}
                disabled={isPending}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm rounded-lg transition-colors disabled:opacity-50"
              >
                {isPending ? "Guardando…" : "Confirmar y guardar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  )
}
