"use client"

import { useState } from "react"

interface RunNowBtnProps {
  jobType: "search" | "batch" | "inbox" | "followup"
  campaignId?: string
  accountId?: string
  color?: "purple" | "blue" | "teal" | "amber"
}

export function RunNowBtn({ jobType, campaignId, accountId, color = "blue" }: RunNowBtnProps) {
  const [open, setOpen]       = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult]   = useState<"ok" | "error" | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const colorCls = {
    purple: "bg-purple-600/20 hover:bg-purple-600/40 text-purple-400 border-purple-500/30",
    blue:   "bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 border-blue-500/30",
    teal:   "bg-teal-600/20 hover:bg-teal-600/40 text-teal-400 border-teal-500/30",
    amber:  "bg-amber-600/20 hover:bg-amber-600/40 text-amber-400 border-amber-500/30",
  }[color]

  async function handleConfirm() {
    setLoading(true)
    try {
      const res = await fetch("/api/run-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobType, campaignId, accountId }),
      })
      if (res.ok) {
        setResult("ok")
      } else {
        const body = await res.json().catch(() => ({}))
        setErrorMsg(body.error ?? "Error desconocido")
        setResult("error")
      }
    } catch {
      setResult("error")
    } finally {
      setLoading(false)
      setTimeout(() => {
        setOpen(false)
        setResult(null)
      }, 2000)
    }
  }

  const jobLabel = { search: "Search", batch: "Batch", inbox: "Inbox", followup: "Follow-up" }[jobType]

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors border whitespace-nowrap ${colorCls}`}
        title="Ejecutar ahora (fuera del cron)"
      >
        ▶ Correr
      </button>

      {/* Modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => !loading && setOpen(false)}
          />

          {/* Dialog */}
          <div className="relative bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            {result === null ? (
              <>
                <div className="mb-4">
                  <div className="text-2xl mb-2">⚡</div>
                  <h2 className="text-white font-semibold text-lg">
                    Ejecutar {jobLabel} ahora
                  </h2>
                  <p className="text-gray-400 text-sm mt-1">
                    Se lanzará el job fuera del cron, sin modificar cooldowns ni horarios.
                  </p>

                  {/* Ban warning */}
                  <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/40">
                    <p className="text-red-400 text-xs font-semibold mb-1">🚫 Riesgo de baneo</p>
                    <ul className="text-red-300/80 text-xs space-y-0.5 list-disc list-inside">
                      <li>LinkedIn detecta actividad fuera de horario normal</li>
                      <li>Ejecutar seguido puede marcar la cuenta como bot</li>
                      <li>Usar solo en emergencias o pruebas puntuales</li>
                    </ul>
                  </div>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => setOpen(false)}
                    disabled={loading}
                    className="flex-1 px-4 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-800 text-sm transition-colors"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={handleConfirm}
                    disabled={loading}
                    className="flex-1 px-4 py-2 rounded-lg bg-red-600/80 hover:bg-red-600 disabled:opacity-60 text-white text-sm font-medium transition-colors"
                  >
                    {loading ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Iniciando...
                      </span>
                    ) : "Confirmar y ejecutar"}
                  </button>
                </div>
              </>
            ) : result === "ok" ? (
              <div className="text-center py-4">
                <div className="text-4xl mb-3">✅</div>
                <p className="text-green-400 font-medium">Job iniciado correctamente</p>
                <p className="text-gray-500 text-xs mt-1">Revisa el log del sistema en unos segundos</p>
              </div>
            ) : (
              <div className="text-center py-4">
                <div className="text-4xl mb-3">❌</div>
                <p className="text-red-400 font-medium">Error al iniciar el job</p>
                <p className="text-gray-500 text-xs mt-1">{errorMsg ?? "Verifica los logs del servidor"}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
