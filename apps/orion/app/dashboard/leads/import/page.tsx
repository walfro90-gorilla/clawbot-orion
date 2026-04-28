"use client"

import { useState, useRef } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"

interface ImportResult {
  ok: boolean
  imported: number
  skipped: number
  total: number
  errors?: string[]
}

export default function ImportLeadsPage() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [campaignId, setCampaignId] = useState("")
  const [campaigns, setCampaigns]   = useState<{ id: string; name: string }[]>([])
  const [loaded, setLoaded]         = useState(false)
  const [file, setFile]             = useState<File | null>(null)
  const [preview, setPreview]       = useState<string[][]>([])
  const [importing, setImporting]   = useState(false)
  const [result, setResult]         = useState<ImportResult | null>(null)
  const [error, setError]           = useState<string | null>(null)

  // Load campaigns on mount
  async function loadCampaigns() {
    if (loaded) return
    setLoaded(true)
    try {
      const res = await fetch("/api/campaigns-list")
      if (res.ok) setCampaigns(await res.json())
    } catch { /* silent */ }
  }

  function handleFile(f: File | null) {
    setFile(f)
    setResult(null)
    setError(null)
    if (!f) { setPreview([]); return }

    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      const lines = text.trim().split(/\r?\n/).slice(0, 6) // header + first 5 rows
      setPreview(lines.map(l => l.split(",").map(c => c.replace(/^["']|["']$/g, "").trim())))
    }
    reader.readAsText(f)
  }

  async function handleImport() {
    if (!file || !campaignId) return
    setImporting(true)
    setError(null)
    try {
      const form = new FormData()
      form.append("file", file)
      form.append("campaignId", campaignId)

      const res = await fetch("/api/leads/import", { method: "POST", body: form })
      const body = await res.json()

      if (!res.ok) {
        setError(body.error ?? "Error al importar")
      } else {
        setResult(body)
        if (body.imported > 0) {
          setTimeout(() => router.push("/dashboard/leads"), 3000)
        }
      }
    } catch (e: any) {
      setError(e.message ?? "Error desconocido")
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/leads" className="text-gray-500 hover:text-gray-50 text-sm">
          ← Leads
        </Link>
        <span className="text-gray-700">/</span>
        <h1 className="text-xl font-bold text-gray-50">Importar leads desde CSV</h1>
      </div>

      {/* Instructions */}
      <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4">
        <p className="text-blue-300 text-sm font-medium mb-2">Formato del CSV</p>
        <p className="text-blue-200/70 text-xs leading-relaxed">
          El CSV debe tener al menos una columna con <code className="bg-blue-900/40 px-1 rounded">linkedin_url</code> o similar.
          Columna de nombre: <code className="bg-blue-900/40 px-1 rounded">full_name</code> o <code className="bg-blue-900/40 px-1 rounded">nombre</code> (opcional).
        </p>
        <p className="text-blue-200/70 text-xs mt-2">
          Ejemplo: <code className="bg-blue-900/40 px-1 rounded">linkedin_url,full_name</code>
          <br />
          <code className="bg-blue-900/40 px-1 rounded">https://www.linkedin.com/in/juan-perez/,Juan Pérez</code>
        </p>
        <p className="text-blue-200/50 text-xs mt-2">Máximo 500 filas por importación. Duplicados en la misma campaña se omiten.</p>
      </div>

      {/* Campaign selector */}
      <div>
        <label className="block text-sm text-gray-400 mb-2">Campaña destino *</label>
        <select
          value={campaignId}
          onChange={e => setCampaignId(e.target.value)}
          onFocus={loadCampaigns}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-50 focus:outline-none focus:border-blue-500"
        >
          <option value="">— Seleccionar campaña —</option>
          {campaigns.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {campaigns.length === 0 && loaded && (
          <p className="text-gray-500 text-xs mt-1">
            No se cargaron campañas.{" "}
            <Link href="/dashboard/campaigns" className="text-blue-400 hover:underline">Ver campañas</Link>
          </p>
        )}
      </div>

      {/* File upload */}
      <div>
        <label className="block text-sm text-gray-400 mb-2">Archivo CSV *</label>
        <div
          className="border-2 border-dashed border-gray-700 hover:border-gray-500 rounded-xl p-8 text-center cursor-pointer transition-colors"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0] ?? null) }}
        >
          {file ? (
            <div>
              <p className="text-gray-50 font-medium">{file.name}</p>
              <p className="text-gray-400 text-xs mt-1">{(file.size / 1024).toFixed(1)} KB</p>
              <button
                onClick={e => { e.stopPropagation(); handleFile(null); if (fileInputRef.current) fileInputRef.current.value = "" }}
                className="text-red-400 text-xs mt-2 hover:underline"
              >
                Quitar archivo
              </button>
            </div>
          ) : (
            <div>
              <p className="text-gray-400">Arrastra un archivo CSV aquí</p>
              <p className="text-gray-600 text-xs mt-1">o haz clic para seleccionar</p>
            </div>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={e => handleFile(e.target.files?.[0] ?? null)}
        />
      </div>

      {/* Preview */}
      {preview.length > 0 && (
        <div>
          <p className="text-sm text-gray-400 mb-2">Vista previa (primeras 5 filas)</p>
          <div className="overflow-x-auto bg-gray-900 border border-gray-800 rounded-lg">
            <table className="text-xs w-full">
              <thead>
                <tr className="border-b border-gray-800">
                  {preview[0].map((h, i) => (
                    <th key={i} className="px-3 py-2 text-left text-gray-400 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.slice(1).map((row, ri) => (
                  <tr key={ri} className="border-b border-gray-800/50">
                    {row.map((cell, ci) => (
                      <td key={ci} className="px-3 py-2 text-gray-300 truncate max-w-[200px]">{cell || "—"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className={`rounded-lg p-4 border ${result.imported > 0 ? "bg-green-500/10 border-green-500/30" : "bg-gray-800 border-gray-700"}`}>
          <p className={`font-semibold text-sm ${result.imported > 0 ? "text-green-400" : "text-gray-300"}`}>
            {result.imported > 0 ? "✅ Importación completada" : "Sin leads nuevos"}
          </p>
          <div className="mt-2 space-y-1 text-xs text-gray-400">
            <p>Importados: <span className="text-gray-50 font-medium">{result.imported}</span></p>
            <p>Omitidos (duplicados o inválidos): <span className="text-gray-50 font-medium">{result.skipped}</span></p>
            <p>Total procesados: <span className="text-gray-50 font-medium">{result.total}</span></p>
          </div>
          {result.errors && result.errors.length > 0 && (
            <div className="mt-2">
              <p className="text-yellow-400 text-xs font-medium">Errores parciales:</p>
              {result.errors.map((e, i) => <p key={i} className="text-yellow-300/70 text-xs">{e}</p>)}
            </div>
          )}
          {result.imported > 0 && (
            <p className="text-gray-500 text-xs mt-2">Redirigiendo a leads en 3s...</p>
          )}
        </div>
      )}

      {/* Import button */}
      <div className="flex gap-3">
        <Link
          href="/dashboard/leads"
          className="flex-1 text-center px-4 py-2.5 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-50 hover:bg-gray-800 text-sm transition-colors"
        >
          Cancelar
        </Link>
        <button
          onClick={handleImport}
          disabled={importing || !file || !campaignId}
          className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-gray-50  text-sm font-medium transition-colors"
        >
          {importing ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Importando...
            </span>
          ) : "Importar leads"}
        </button>
      </div>
    </div>
  )
}
