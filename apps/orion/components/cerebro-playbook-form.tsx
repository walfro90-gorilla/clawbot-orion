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
  kind: string
  campaign_id: string
}

const INITIAL: FormState = {
  title: "",
  description: "",
  situation: "",
  tags: "",
  applies_to_turns: [0, 1, 2, 3],
  example_message: "",
  kind: "example",
  campaign_id: "",
}

export function CerebroPlaybookForm({ campaigns = [], proposalMode = false }: { campaigns?: { id: string; name: string }[]; proposalMode?: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  // Modo propuesta: sin ámbito global → arranca en la primera campaña propia.
  const initial: FormState = proposalMode ? { ...INITIAL, campaign_id: campaigns[0]?.id ?? "" } : INITIAL
  const [form, setForm] = useState<FormState>(initial)
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  // ── Análisis de screenshot (3-ago-2026) ────────────────────────────────────
  // Sube/pega una captura de una conversación real → Gemini Vision la transcribe,
  // diagnostica la situación y PRECARGA el form con un borrador de entrada. El humano
  // revisa/edita y guarda por el flujo normal — nada entra al playbook sin review.
  const [shot, setShot] = useState<{ b64: string; mime: string; preview: string } | null>(null)
  const [shotHint, setShotHint] = useState("")
  const [analyzing, setAnalyzing] = useState(false)
  const [analysis, setAnalysis] = useState<{ transcript: string; diagnosis: string } | null>(null)
  const [shotError, setShotError] = useState<string | null>(null)

  function loadImageFile(file: File | null | undefined) {
    if (!file || !/^image\/(png|jpe?g|webp)$/.test(file.type)) {
      setShotError("Formato no soportado — usa PNG, JPG o WebP.")
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      const b64 = dataUrl.split(",")[1] ?? ""
      setShot({ b64, mime: file.type, preview: dataUrl })
      setShotError(null)
      setAnalysis(null)
    }
    reader.readAsDataURL(file)
  }

  function handlePaste(e: React.ClipboardEvent) {
    const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith("image/"))
    if (item) { e.preventDefault(); loadImageFile(item.getAsFile()) }
  }

  async function analyzeShot() {
    if (!shot) return
    setAnalyzing(true)
    setShotError(null)
    try {
      const res = await fetch("/api/cerebro/analyze-screenshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: shot.b64, mimeType: shot.mime, hint: shotHint.trim() || undefined }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setShotError(json.error ?? "Error al analizar"); return }
      // Precargar el form con el borrador — el humano edita antes de guardar
      setForm(f => ({
        ...f,
        kind: json.draft.kind,
        title: json.draft.title,
        description: json.draft.description,
        situation: json.draft.situation,
        tags: (json.draft.tags ?? []).join(", "),
        applies_to_turns: json.draft.applies_to_turns ?? [0, 1, 2, 3],
        example_message: json.draft.example_message,
      }))
      setAnalysis({ transcript: json.transcript, diagnosis: json.diagnosis })
    } catch {
      setShotError("Error de red al analizar. Intenta de nuevo.")
    } finally {
      setAnalyzing(false)
    }
  }

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
    if (form.kind !== "principle" && form.applies_to_turns.length === 0) next.applies_to_turns = "Selecciona al menos un turno"
    if (proposalMode && !form.campaign_id) next.campaign_id = "Elige una de tus campañas"
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
          kind: form.kind,
          campaign_id: form.campaign_id || undefined,
        }),
      })

      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setServerError(json.error ?? "Error al guardar")
        return
      }

      setForm(initial)
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
        {proposalMode ? "+ Proponer ejemplo" : "+ Nuevo ejemplo"}
      </button>
    )
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4" onPaste={handlePaste}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-50">{proposalMode ? "Proponer ejemplo de playbook" : "Nuevo ejemplo de playbook"}</h3>
        <button
          onClick={() => { setOpen(false); setForm(initial); setErrors({}); setShot(null); setAnalysis(null); setShotError(null) }}
          className="text-gray-500 hover:text-gray-300 text-xs transition-colors"
        >
          Cancelar
        </button>
      </div>

      {/* ── Analizar screenshot de una conversación ─────────────────────────── */}
      <div
        className="bg-purple-950/30 border border-purple-500/20 rounded-lg p-4 space-y-3"
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); loadImageFile(e.dataTransfer.files?.[0]) }}
      >
        <div className="flex items-center gap-2">
          <span>📸</span>
          <h4 className="text-xs font-semibold text-purple-300">
            Empezar desde un screenshot — pega (Ctrl+V), arrastra o elige una captura de la conversación
          </h4>
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <label className="cursor-pointer bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 rounded-lg px-3 py-2 text-xs transition-colors">
            Elegir imagen…
            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
              onChange={e => loadImageFile(e.target.files?.[0])} />
          </label>
          {shot && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={shot.preview} alt="captura a analizar" className="h-24 rounded-lg border border-gray-700 object-contain" />
          )}
          {shot && (
            <div className="flex-1 min-w-55 space-y-2">
              <input
                type="text"
                value={shotHint}
                onChange={e => setShotHint(e.target.value)}
                placeholder="Contexto opcional: ej. 'el lead es un proveedor que nos quiere vender'"
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 text-xs placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
              <button
                type="button"
                onClick={analyzeShot}
                disabled={analyzing}
                className="bg-purple-600 hover:bg-purple-500 text-white rounded-lg px-4 py-2 text-xs transition-colors disabled:opacity-50"
              >
                {analyzing ? "Analizando…" : "🧠 Analizar y precargar el formulario"}
              </button>
            </div>
          )}
        </div>
        {shotError && (
          <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{shotError}</p>
        )}
        {analysis && (
          <div className="space-y-2 text-xs">
            <div className="bg-gray-900/70 border border-gray-800 rounded-lg p-3">
              <p className="text-purple-300 font-semibold mb-1">Diagnóstico</p>
              <p className="text-gray-300 leading-relaxed">{analysis.diagnosis}</p>
            </div>
            {analysis.transcript && (
              <details className="bg-gray-900/70 border border-gray-800 rounded-lg p-3">
                <summary className="text-gray-400 cursor-pointer">Transcript extraído</summary>
                <pre className="text-gray-400 whitespace-pre-wrap mt-2 text-[11px] leading-relaxed">{analysis.transcript}</pre>
              </details>
            )}
            <p className="text-amber-300/80">
              ⚠️ Borrador precargado abajo — revísalo y ajústalo antes de guardar. Nada entra al Cerebro sin tu OK.
            </p>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {proposalMode && (
          <p className="text-amber-300/90 text-xs bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
            📋 Tu ejemplo quedará <strong>pendiente de revisión</strong>: un admin lo activará antes de que la IA lo use. Aplica solo a tus campañas.
          </p>
        )}
        {/* Kind + scope */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Tipo</label>
            <select
              value={form.kind}
              onChange={e => setForm(f => ({ ...f, kind: e.target.value }))}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="example">Ejemplo (que funcionó)</option>
              <option value="objection">Manejo de objeción</option>
              <option value="principle">Principio / metodología (siempre aplica)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Ámbito</label>
            <select
              value={form.campaign_id}
              onChange={e => setForm(f => ({ ...f, campaign_id: e.target.value }))}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {/* Modo propuesta: sin ámbito global — solo campañas propias */}
              {!proposalMode && <option value="">🌐 Global (todas las campañas)</option>}
              {campaigns.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {errors.campaign_id && <p className="text-red-400 text-xs mt-1">{errors.campaign_id}</p>}
          </div>
        </div>

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

        {/* Applies to turns — no aplica a principios (siempre se inyectan) */}
        {form.kind !== "principle" && (
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
        )}

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
            onClick={() => { setOpen(false); setForm(initial); setErrors({}) }}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition-colors"
          >
            Cancelar
          </button>
        </div>
      </form>
    </div>
  )
}
