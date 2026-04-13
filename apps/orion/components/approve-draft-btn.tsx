"use client"

import { useState } from "react"

interface ApproveDraftBtnProps {
  leadId: string
  leadName: string
  draft: string
}

export function ApproveDraftBtn({ leadId, leadName, draft }: ApproveDraftBtnProps) {
  const [open, setOpen]         = useState(false)
  const [message, setMessage]   = useState(draft)
  const [loading, setLoading]   = useState(false)
  const [result, setResult]     = useState<"ok" | "error" | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  function openModal() {
    setMessage(draft)
    setResult(null)
    setErrorMsg(null)
    setOpen(true)
  }

  async function handleApprove() {
    if (!message.trim()) return
    setLoading(true)
    try {
      const res = await fetch("/api/leads/approve-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId, message: message.trim() }),
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
      if (result !== "error") {
        setTimeout(() => {
          setOpen(false)
          setResult(null)
        }, 3000)
      }
    }
  }

  return (
    <>
      <button
        onClick={openModal}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg font-medium transition-colors border bg-yellow-500/15 hover:bg-yellow-500/30 text-yellow-300 border-yellow-500/30 whitespace-nowrap"
        title="Revisar y aprobar borrador de IA para enviar"
      >
        ✨ Aprobar draft
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => !loading && setOpen(false)}
          />
          <div className="relative bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl">
            {result === null ? (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-yellow-400 text-lg">✨</span>
                  <h2 className="text-white font-semibold text-lg">Draft IA — {leadName}</h2>
                </div>
                <p className="text-gray-400 text-xs mb-4">
                  Borrador generado por Gemini. Edítalo si lo necesitas antes de aprobar.
                  Se enviará vía LinkedIn (~90s).
                </p>

                <textarea
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-yellow-500/60 leading-relaxed"
                  rows={6}
                  maxLength={2000}
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  disabled={loading}
                  autoFocus
                />
                <div className="flex justify-between items-center mt-1 mb-4">
                  <span className="text-gray-600 text-xs">{message.length}/2000 caracteres</span>
                  <button
                    onClick={() => setMessage(draft)}
                    className="text-gray-500 hover:text-gray-300 text-xs underline"
                    disabled={loading}
                  >
                    Restaurar original
                  </button>
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
                    onClick={handleApprove}
                    disabled={loading || !message.trim()}
                    className="flex-1 px-4 py-2 rounded-lg bg-yellow-600 hover:bg-yellow-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
                  >
                    {loading ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Enviando...
                      </span>
                    ) : "Aprobar y enviar"}
                  </button>
                </div>
              </>
            ) : result === "ok" ? (
              <div className="text-center py-6">
                <div className="text-5xl mb-3">✅</div>
                <p className="text-green-400 font-semibold text-lg">Respuesta aprobada y enviada</p>
                <p className="text-gray-500 text-sm mt-1">Aparecerá en el historial en ~2 min</p>
              </div>
            ) : (
              <div className="text-center py-6">
                <div className="text-5xl mb-3">❌</div>
                <p className="text-red-400 font-semibold text-lg">Error al enviar</p>
                <p className="text-gray-500 text-sm mt-1">{errorMsg ?? "Revisa los logs del servidor"}</p>
                <button
                  onClick={() => setResult(null)}
                  className="mt-4 px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-white text-sm"
                >
                  Reintentar
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
