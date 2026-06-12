"use client"

import { useState } from "react"

// v0.8 FU dinámico: editor de la secuencia de seguimientos (1..20 pasos) por campaña.
// Reemplaza los 5 pares de campos fijos (FU1..FU5). El estado se serializa a un
// <input type="hidden" name="followup_steps_json"> que el server action de
// /dashboard/accounts/[id]/config/page.tsx parsea y vuelca en la tabla campaign_followups.

export interface FollowupStep {
  message: string
  delay_value: number
  delay_unit: "hours" | "days"
  jitter_hours: number
  enabled: boolean
}

const MAX_STEPS = 20

const inp =
  "w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"

function emptyStep(): FollowupStep {
  return { message: "", delay_value: 24, delay_unit: "hours", jitter_hours: 0, enabled: true }
}

export function FollowupSequenceEditor({
  initialSteps,
  disabled,
}: {
  initialSteps: FollowupStep[]
  disabled?: boolean
}) {
  const [steps, setSteps] = useState<FollowupStep[]>(
    initialSteps.length > 0 ? initialSteps : [emptyStep()],
  )

  function update(i: number, patch: Partial<FollowupStep>) {
    setSteps(prev => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  }
  function remove(i: number) {
    setSteps(prev => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)))
  }
  function add() {
    setSteps(prev => (prev.length >= MAX_STEPS ? prev : [...prev, emptyStep()]))
  }

  return (
    <div className="space-y-3">
      {/* Serialización para el server action (un solo submit con todo el form) */}
      <input type="hidden" name="followup_steps_json" value={JSON.stringify(steps)} readOnly />

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-200">
          💬 Secuencia de seguimientos
          <span className="ml-2 text-xs font-normal text-gray-500">
            {steps.length}/{MAX_STEPS} pasos
          </span>
        </h3>
      </div>
      <p className="text-[11px] text-gray-600 -mt-1">
        El sistema envía cada paso en orden. El delay se cuenta desde la conexión (FU1) o desde el
        seguimiento anterior. Vacía un paso y elimínalo para acortar la secuencia. Placeholders:{" "}
        <code className="text-gray-500">{"{nombre}"}</code>, <code className="text-gray-500">{"{empresa}"}</code>,{" "}
        <code className="text-gray-500">{"{cal_url}"}</code>.
      </p>

      {steps.map((s, i) => (
        <div
          key={i}
          className={
            "rounded-lg border p-3 space-y-2 " +
            (s.enabled ? "bg-gray-900/60 border-gray-700" : "bg-gray-900/30 border-gray-800 opacity-60")
          }
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-blue-300">Seguimiento {i + 1}</span>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-[11px] text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={e => update(i, { enabled: e.target.checked })}
                  className="accent-blue-500"
                  disabled={disabled}
                />
                Activo
              </label>
              <button
                type="button"
                onClick={() => remove(i)}
                disabled={disabled || steps.length <= 1}
                className="text-[11px] px-2 py-0.5 bg-gray-800 hover:bg-red-900/40 border border-gray-700 hover:border-red-700 rounded text-gray-400 hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                🗑️ Eliminar
              </button>
            </div>
          </div>

          <textarea
            value={s.message}
            onChange={e => update(i, { message: e.target.value })}
            rows={3}
            disabled={disabled}
            placeholder={`Mensaje del seguimiento ${i + 1}…  (vacío = generado por IA si la campaña tiene prompt)`}
            className={inp}
          />

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[11px] text-gray-500">Delay</label>
              <input
                type="number"
                min={0}
                value={s.delay_value}
                onChange={e => update(i, { delay_value: Number(e.target.value) })}
                disabled={disabled}
                className={inp}
              />
            </div>
            <div>
              <label className="text-[11px] text-gray-500">Unidad</label>
              <select
                value={s.delay_unit}
                onChange={e => update(i, { delay_unit: e.target.value as "hours" | "days" })}
                disabled={disabled}
                className={inp}
              >
                <option value="hours">Horas</option>
                <option value="days">Días</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] text-gray-500" title="Aleatoriedad ± para humanizar el envío">
                Jitter (h)
              </label>
              <input
                type="number"
                min={0}
                step="0.5"
                value={s.jitter_hours}
                onChange={e => update(i, { jitter_hours: Number(e.target.value) })}
                disabled={disabled}
                className={inp}
              />
            </div>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={add}
        disabled={disabled || steps.length >= MAX_STEPS}
        className="w-full py-2 text-sm font-medium bg-gray-800/60 hover:bg-gray-800 border border-dashed border-gray-700 hover:border-blue-700 rounded-lg text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        ➕ Agregar seguimiento
      </button>
    </div>
  )
}
