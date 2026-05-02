"use client"

import { useState, useRef } from "react"
import { useRouter } from "next/navigation"

const TURN_LABELS: Record<number, string> = {
  0: "Rapport",
  1: "Profundizar",
  2: "Profundizar 2",
  3: "Cierre",
}

interface FormState {
  title: string
  description: string
  situation: string
  tags: string
  applies_to_turns: number[]
  example_message: string
}

const INITIAL: FormState = {
  title: "",
  description: "",
  situation: "",
  tags: "",
  applies_to_turns: [0, 1, 2, 3],
  example_message: "",
}

export function CerebroPlaybookForm() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<FormState>(INITIAL)
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  function toggleTurn(turn: number) {
    setForm(f => ({
      ...f,
      applies_to_turns: f.applies_to_turns.includes(turn)
        ? f.applies_to_turns.filter(t => t !== turn)
        : [...f.applies_to_turns, turn].sort(),
    }))
  }

  function validate(): boolean {
    const next: typeof errors = {}
    if (!form.title.trim()) next.title = "El título es obligatorio"
    if (!form.example_message.trim()) next.example_message = "El mensaje de ejemplo es obligatorio"
    if (form.applies_to_turns.length === 0) next.applies_to_turns = "Selecciona al menos un turno"
    setErrors(next)
    return Object.keys(next).length === 0
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!validate()) return
    setSubmitting(true)
    setServerError(null)

    const tags = form.tags
      .split(",")
      .map(t => t.trim())
      .filter(Boolean)

    try {
      const res = await fetch("/api/cerebro/playbook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title.trim(),
          description: form.description.trim() || undefined,
          situation: form.situation.trim() || undefined,
          tags,
          applies_to_turns: form.applies_to_turns,
          example_message: form.example_message.trim(),
        }),
      })

      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setServerError(json.error ?? "Error al guardar")
        return
      }

      setForm(INITIAL)
      setErrors({})
      setOpen(false)
      router.refresh()
    } catch {
      setServerError("Error de red. Intenta de nuevo.")
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => { setOpen(true); setTimeout(() => titleRef.current?.focus(), 50) }}
        className="bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-4 py-2 text-sm transition-colors"
      >
        + Nuevo ejemplo
      </button>
    )
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-50">Nuevo ejemplo de playbook</h3>
        <button
          onClick={() => { setOpen(false); setForm(INITIAL); setErrors({}) }}
          className="text-gray-500 hover:text-gray-300 text-xs transition-colors"
        >
          Cancelar
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Title */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            Título <span className="text-red-400">*</span>
          </label>
          <input
            ref={titleRef}
            type="text"
            value={form.title}
            onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            placeholder="ej: CEO manufactura FU1"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {errors.title && <p className="text-red-400 text-xs mt-1">{errors.title}</p>}
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            Descripción <span className="text-gray-600">(opcional)</span>
          </label>
          <textarea
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            placeholder="Breve descripción del propósito de este ejemplo"
            rows={2}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>

        {/* Situation */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            Situacion <span className="text-gray-600">(opcional)</span>
          </label>
          <textarea
            value={form.situation}
            onChange={e => setForm(f => ({ ...f, situation: e.target.value }))}
            placeholder="¿Cuándo usar este ejemplo? ej: CEO en manufactura que no ha respondido al FU1"
            rows={2}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>

        {/* Tags */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            Tags <span className="text-gray-600">(separados por coma)</span>
          </label>
          <input
            type="text"
            value={form.tags}
            onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
            placeholder="CEO, manufactura, FU1, no-reply"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Applies to turns */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-2">
            Aplica a turnos <span className="text-red-400">*</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {([0, 1, 2, 3] as const).map(turn => (
              <label key={turn} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.applies_to_turns.includes(turn)}
                  onChange={() => toggleTurn(turn)}
                  className="w-4 h-4 rounded border-gray-600 bg-gray-800 accent-blue-600"
                />
                <span className={`text-xs px-2 py-0.5 rounded-full border ${
                  form.applies_to_turns.includes(turn)
                    ? "bg-blue-600/20 border-blue-500/40 text-blue-300"
                    : "bg-gray-800 border-gray-700 text-gray-500"
                }`}>
                  {turn} — {TURN_LABELS[turn]}
                </span>
              </label>
            ))}
          </div>
          {errors.applies_to_turns && <p className="text-red-400 text-xs mt-1">{errors.applies_to_turns}</p>}
        </div>

        {/* Example message */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            Mensaje de ejemplo <span className="text-red-400">*</span>
          </label>
          <textarea
            value={form.example_message}
            onChange={e => setForm(f => ({ ...f, example_message: e.target.value }))}
            placeholder="Escribe aquí el mensaje que ha funcionado bien para esta situación..."
            rows={6}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
          />
          {errors.example_message && <p className="text-red-400 text-xs mt-1">{errors.example_message}</p>}
        </div>

        {serverError && (
          <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            {serverError}
          </p>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={submitting}
            className="bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-4 py-2 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Guardando..." : "Guardar ejemplo"}
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); setForm(INITIAL); setErrors({}) }}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition-colors"
          >
            Cancelar
          </button>
        </div>
      </form>
    </div>
  )
}
