"use client"

import { useState } from "react"

interface ReplyBtnProps {
  leadId: string
  leadName: string
}

export function ReplyBtn({ leadId, leadName }: ReplyBtnProps) {
  const [open, setOpen]       = useState(false)
  const [message, setMessage] = useState("")
  const [loading, setLoading] = useState(false)
  const [result, setResult]   = useState<"ok" | "error" | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  async function handleSend() {
    if (!message.trim()) return
    setLoading(true)
    try {
      const res = await fetch("/api/leads/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId, message: message.trim() }),
      })
      if (res.ok) {
        setResult("ok")
        setMessage("")
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
        setErrorMsg(null)
      }, 3000)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-xs rounded-lg font-medium transition-colors border bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 border-blue-500/30 whitespace-nowrap"
        title="Responder desde Orion vía LinkedIn"
      >
        ↩ Responder
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !loading && setOpen(false)} />
          <div className="relative bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            {result === null ? (
              <>
                <h2 className="text-white font-semibold text-lg mb-1">Responder a {leadName}</h2>
                <p className="text-gray-400 text-xs mb-4">
                  El mensaje se enviará vía LinkedIn Playwright. Proceso ~90s.
                </p>

                <textarea
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500"
                  rows={5}
                  maxLength={2000}
                  placeholder="Escribe tu respuesta..."
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  disabled={loading}
                  autoFocus
                />
                <div className="flex justify-between items-center mt-1 mb-4">
                  <span className="text-gray-600 text-xs">{message.length}/2000</span>
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
                    onClick={handleSend}
                    disabled={loading || !message.trim()}
                    className="flex-1 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
                  >
                    {loading ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Enviando...
                      </span>
                    ) : "Enviar respuesta"}
                  </button>
                </div>
              </>
            ) : result === "ok" ? (
              <div className="text-center py-4">
                <div className="text-4xl mb-3">✅</div>
                <p className="text-green-400 font-medium">Respuesta enviada</p>
                <p className="text-gray-500 text-xs mt-1">Aparecerá en el historial en ~2 min</p>
              </div>
            ) : (
              <div className="text-center py-4">
                <div className="text-4xl mb-3">❌</div>
                <p className="text-red-400 font-medium">Error al enviar</p>
                <p className="text-gray-500 text-xs mt-1">{errorMsg ?? "Revisa los logs del servidor"}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
