"use client"

import { useState } from "react"
import { ExtensionPanel } from "./extension-panel"
import { OnboardingActivatePanel } from "./onboarding-activate-panel"

type Campaign = {
  search_keywords: string[] | null
  search_location: string | null
  ai_sender_persona: string | null
  target_audience: string | null
  daily_invite_target: number | null
}

const inp = "w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"

const STEPS = ["Bienvenida", "Extensión", "Campaña", "Activar"]

export function OnboardingWizard({
  accountId, accountLabel, apiKey, profileUrl, campaign, downloadBaseUrl,
}: {
  accountId: string
  accountLabel: string
  apiKey: string | null
  profileUrl: string | null
  campaign: Campaign | null
  downloadBaseUrl: string
}) {
  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function saveCampaign(form: HTMLFormElement) {
    setSaving(true); setErr(null)
    const fd = new FormData(form)
    try {
      const r = await fetch("/api/onboarding/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          search_keywords:     fd.get("search_keywords"),
          search_location:     fd.get("search_location"),
          ai_sender_persona:   fd.get("ai_sender_persona"),
          target_audience:     fd.get("target_audience"),
          daily_invite_target: fd.get("daily_invite_target"),
        }),
      })
      const j = await r.json()
      if (r.ok && j.ok) { setStep(3) }
      else setErr(j.error ?? "No se pudo guardar")
    } catch (e: any) {
      setErr(e?.message ?? "Error de red")
    }
    setSaving(false)
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-gray-900 border border-gray-800 rounded-2xl shadow-xl overflow-hidden">
        {/* Header + step indicator */}
        <div className="px-6 py-5 border-b border-gray-800 bg-gradient-to-br from-blue-600/10 to-purple-600/10">
          <div className="flex items-center gap-2">
            <span className="text-xl">🚀</span>
            <h1 className="text-lg font-bold text-gray-50">Configura tu cuenta de Orion</h1>
          </div>
          <div className="flex items-center gap-1.5 mt-4">
            {STEPS.map((s, i) => (
              <div key={s} className="flex-1 flex items-center gap-1.5">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                  i < step ? "bg-green-600 text-white" : i === step ? "bg-blue-600 text-white" : "bg-gray-700 text-gray-400"
                }`}>{i < step ? "✓" : i + 1}</div>
                <span className={`text-xs ${i === step ? "text-gray-100 font-medium" : "text-gray-500"}`}>{s}</span>
                {i < STEPS.length - 1 && <div className="flex-1 h-px bg-gray-700" />}
              </div>
            ))}
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* ── Paso 1: Bienvenida ── */}
          {step === 0 && (
            <div className="space-y-4">
              <p className="text-gray-300 text-sm">
                ¡Bienvenido! En unos minutos dejamos tu cuenta lista para que Orion prospecte en LinkedIn por ti.
                Vamos a (1) instalar la extensión, (2) ajustar tu campaña, y (3) activar.
              </p>
              <div className="rounded-xl border border-gray-800 bg-gray-800/40 p-4 space-y-1 text-sm">
                <div className="text-gray-400 text-xs uppercase tracking-wide">Tu cuenta</div>
                <div className="text-gray-100 font-medium">{accountLabel}</div>
                {profileUrl && <a href={profileUrl} target="_blank" className="text-blue-400 text-xs hover:underline">{profileUrl}</a>}
              </div>
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-xs text-amber-300">
                ⚠️ Importante: inicia sesión en <b>LinkedIn</b> en este mismo navegador (Chrome) antes de continuar.
                Orion trabaja con tu sesión real, así que debes estar logueado con la cuenta correcta.
              </div>
            </div>
          )}

          {/* ── Paso 2: Extensión ── */}
          {step === 1 && (
            <div className="space-y-3">
              <p className="text-gray-300 text-sm">
                Instala la extensión <b>Orion Sync</b> y conéctala. Los 3 valores ya están pre-cargados abajo —
                solo cópialos en el popup de la extensión y dale <b>Conectar</b>.
              </p>
              <ExtensionPanel
                accountId={accountId}
                accountLabel={accountLabel}
                initialApiKey={apiKey}
                downloadBaseUrl={downloadBaseUrl}
              />
              <p className="text-xs text-gray-500">
                Cuando la extensión esté conectada lo verás reflejado en el último paso (checklist).
              </p>
            </div>
          )}

          {/* ── Paso 3: Campaña ── */}
          {step === 2 && (
            <form onSubmit={(e) => { e.preventDefault(); saveCampaign(e.currentTarget) }} className="space-y-4">
              <p className="text-gray-300 text-sm">Define a quién quieres contactar. Puedes afinar todo después desde el panel.</p>
              <div className="space-y-1">
                <label className="block text-xs text-gray-400 font-medium">Keywords de búsqueda * <span className="text-gray-600">(separadas por coma)</span></label>
                <input name="search_keywords" required defaultValue={(campaign?.search_keywords ?? []).join(", ")}
                  placeholder="Director General, CEO, Director Comercial" className={inp} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="block text-xs text-gray-400 font-medium">Ubicación</label>
                  <input name="search_location" defaultValue={campaign?.search_location ?? ""} placeholder="Mexico" className={inp} />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs text-gray-400 font-medium">Invitaciones por día</label>
                  <input name="daily_invite_target" type="number" min={1} max={30} defaultValue={campaign?.daily_invite_target ?? 8} className={inp} />
                </div>
              </div>
              <div className="space-y-1">
                <label className="block text-xs text-gray-400 font-medium">Audiencia objetivo <span className="text-gray-600">(para la IA)</span></label>
                <textarea name="target_audience" rows={2} defaultValue={campaign?.target_audience ?? ""}
                  placeholder="Directores de empresas medianas en México interesados en..." className={inp} />
              </div>
              <div className="space-y-1">
                <label className="block text-xs text-gray-400 font-medium">Tu voz / persona <span className="text-gray-600">(cómo se presenta la IA)</span></label>
                <textarea name="ai_sender_persona" rows={2} defaultValue={campaign?.ai_sender_persona ?? ""}
                  placeholder="Soy consultor B2B, tono cercano y directo, sin lenguaje corporativo." className={inp} />
              </div>
              {err && <p className="text-xs text-red-400">{err}</p>}
              <button type="submit" disabled={saving}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white text-sm font-semibold rounded-lg transition-colors">
                {saving ? "Guardando…" : "Guardar y continuar"}
              </button>
            </form>
          )}

          {/* ── Paso 4: Activar ── */}
          {step === 3 && (
            <div className="space-y-3">
              <p className="text-gray-300 text-sm">
                Último paso. Cuando el checklist esté completo, activa tu cuenta y Orion empezará a trabajar.
              </p>
              <OnboardingActivatePanel accountId={accountId} redirectTo="/dashboard" />
            </div>
          )}

          {/* Nav */}
          <div className="flex items-center justify-between pt-2 border-t border-gray-800">
            <button onClick={() => setStep(s => Math.max(0, s - 1))} disabled={step === 0}
              className="px-4 py-2 text-xs text-gray-400 hover:text-gray-100 disabled:opacity-40 disabled:cursor-not-allowed">
              ← Atrás
            </button>
            {step < 2 && (
              <button onClick={() => setStep(s => s + 1)}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg transition-colors">
                Siguiente →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
