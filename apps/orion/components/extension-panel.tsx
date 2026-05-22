"use client"

import { useState, useEffect, useCallback } from "react"

interface Props {
  accountId:    string
  accountLabel: string
  initialApiKey: string | null
  downloadBaseUrl: string
}

export function ExtensionPanel({ accountId, accountLabel, initialApiKey, downloadBaseUrl }: Props) {
  const [apiKey, setApiKey] = useState<string | null>(initialApiKey)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [lastSeen, setLastSeen] = useState<number | null>(null)
  const [reveal, setReveal] = useState(false)
  const [copyOk, setCopyOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(`/api/extension/status?accountId=${accountId}`, { cache: "no-store" })
      const j = await r.json()
      setConnected(!!j.connected)
      setLastSeen(j.lastSeen ?? null)
    } catch {
      setConnected(false)
    }
  }, [accountId])

  useEffect(() => {
    fetchStatus()
    const id = setInterval(fetchStatus, 8000)
    return () => clearInterval(id)
  }, [fetchStatus])

  async function generateKey() {
    if (apiKey && !confirm("Esto invalidará la API key actual y desconectará la extension. ¿Continuar?")) return
    setBusy(true)
    try {
      const r = await fetch("/api/extension/generate-key", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ accountId }),
      })
      const j = await r.json()
      if (j.apiKey) {
        setApiKey(j.apiKey)
        setReveal(true)
      } else {
        alert(`Error: ${j.error ?? "unknown"}`)
      }
    } catch (err) {
      alert(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function copyKey() {
    if (!apiKey) return
    await navigator.clipboard.writeText(apiKey)
    setCopyOk(true)
    setTimeout(() => setCopyOk(false), 1500)
  }

  const masked = apiKey
    ? `${apiKey.slice(0, 12)}${"•".repeat(16)}${apiKey.slice(-4)}`
    : null

  const orionUrl = typeof window !== "undefined" ? window.location.origin : ""
  const wsUrl = orionUrl.replace(/^http/, "ws") + "/api/extension/ws"

  return (
    <div className="border-t border-gray-700 pt-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">
          🧩 Extension Chrome
        </p>
        <div className="flex items-center gap-2">
          {connected === null ? (
            <span className="text-xs text-gray-500">…</span>
          ) : connected ? (
            <span className="text-xs px-2 py-0.5 rounded-full border bg-green-500/10 border-green-500/30 text-green-400 font-medium">
              ● Conectada
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded-full border bg-gray-500/10 border-gray-500/30 text-gray-400 font-medium">
              ○ Desconectada
            </span>
          )}
        </div>
      </div>

      {!apiKey ? (
        <div className="bg-gray-800/40 border border-gray-700 rounded-lg px-3 py-2.5 space-y-2">
          <p className="text-xs text-gray-400">
            Conecta tu Chrome con Orion para ejecutar acciones LinkedIn desde tu propia IP — sin riesgo de baneo multi-IP.
          </p>
          <button
            onClick={generateKey}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-500/15 hover:bg-blue-500/25
              border border-blue-500/30 text-blue-300 font-medium disabled:opacity-50"
          >
            {busy ? "Generando…" : "🔑 Generar API key"}
          </button>
        </div>
      ) : (
        <div className="bg-gray-800/40 border border-gray-700 rounded-lg px-3 py-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={reveal ? apiKey : (masked ?? "")}
              className="flex-1 px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-gray-300 font-mono"
            />
            <button
              onClick={() => setReveal(!reveal)}
              className="text-xs px-2 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300"
              title={reveal ? "Ocultar" : "Mostrar"}
            >
              {reveal ? "🙈" : "👁️"}
            </button>
            <button
              onClick={copyKey}
              className="text-xs px-2 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300"
            >
              {copyOk ? "✓" : "📋"}
            </button>
          </div>
          <button
            onClick={generateKey}
            disabled={busy}
            className="text-xs text-gray-500 hover:text-gray-300 underline"
          >
            {busy ? "Generando…" : "Regenerar"}
          </button>
        </div>
      )}

      <button
        onClick={() => setOpen(!open)}
        className="text-xs text-blue-400 hover:text-blue-300 underline"
      >
        {open ? "Ocultar" : "Mostrar"} instrucciones de instalación
      </button>

      {open && (
        <InstallInstructions
          accountId={accountId}
          accountLabel={accountLabel}
          orionUrl={orionUrl}
          downloadBaseUrl={downloadBaseUrl}
        />
      )}

      {lastSeen && !connected && (
        <p className="text-xs text-gray-600">
          Última conexión: {new Date(lastSeen).toLocaleString("es-MX")}
        </p>
      )}
    </div>
  )
}

function InstallInstructions({ accountId, accountLabel, orionUrl, downloadBaseUrl }: {
  accountId: string; accountLabel: string; orionUrl: string; downloadBaseUrl: string;
}) {
  const isWindows = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows")
  const [os, setOs] = useState<"windows" | "unix">(isWindows ? "windows" : "unix")

  // Usamos URLs .txt porque algunos ISPs (Telmex/Megacable MX) bloquean
  // descargas HTTP de .ps1/.sh como anti-malware transparente.
  const winCmd  = `irm ${downloadBaseUrl}/install-win.txt | iex`
  const unixCmd = `curl -fsSL ${downloadBaseUrl}/install-unix.txt | bash`

  return (
    <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-3 space-y-3 text-xs">
      <div className="flex gap-1.5">
        <button
          onClick={() => setOs("windows")}
          className={`px-2.5 py-1 rounded text-xs font-medium ${
            os === "windows"
              ? "bg-blue-500/20 border border-blue-500/40 text-blue-300"
              : "bg-gray-700/30 border border-gray-700 text-gray-400"
          }`}
        >
          Windows
        </button>
        <button
          onClick={() => setOs("unix")}
          className={`px-2.5 py-1 rounded text-xs font-medium ${
            os === "unix"
              ? "bg-blue-500/20 border border-blue-500/40 text-blue-300"
              : "bg-gray-700/30 border border-gray-700 text-gray-400"
          }`}
        >
          macOS / Linux
        </button>
      </div>

      <div className="space-y-2">
        <p className="text-gray-300 font-medium">
          1️⃣ Instalar — copia y pega en {os === "windows" ? "PowerShell" : "Terminal"}:
        </p>
        <CopyCmd cmd={os === "windows" ? winCmd : unixCmd} />
        <p className="text-gray-500 leading-snug">
          Esto descarga la extension, la descomprime y abre <code className="text-gray-300 bg-gray-900 px-1 rounded">chrome://extensions</code> automáticamente.
        </p>
      </div>

      <div className="space-y-1">
        <p className="text-gray-300 font-medium">2️⃣ En chrome://extensions:</p>
        <ul className="text-gray-400 space-y-0.5 pl-4 list-disc">
          <li>Activa <span className="text-gray-200">Modo de desarrollador</span> (esquina superior derecha)</li>
          <li>Click <span className="text-gray-200">"Cargar extensión sin empaquetar"</span></li>
          <li>El path ya está en tu portapapeles — pégalo (Ctrl+V) y selecciona la carpeta</li>
        </ul>
      </div>

      <div className="space-y-1">
        <p className="text-gray-300 font-medium">3️⃣ Configura el popup del ícono Orion:</p>
        <div className="space-y-1.5 pl-2">
          <PopupField label="Orion URL"  value={orionUrl} />
          <PopupField label="Account ID" value={accountId} />
          <p className="text-gray-500">API key: la que generaste arriba ☝️</p>
        </div>
      </div>

      <p className="text-gray-400 leading-snug pt-1 border-t border-gray-700">
        4️⃣ Click <span className="text-gray-200">Conectar</span> y abre LinkedIn como <span className="text-gray-200">{accountLabel}</span>. El badge se pone verde.
      </p>
    </div>
  )
}

function CopyCmd({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="flex items-stretch gap-1.5">
      <code className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-gray-200 font-mono text-xs overflow-x-auto whitespace-nowrap">
        {cmd}
      </code>
      <button
        onClick={copy}
        className="px-2 py-1.5 rounded bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/30 text-blue-300 text-xs font-medium"
      >
        {copied ? "✓" : "📋"}
      </button>
    </div>
  )
}

function PopupField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-gray-500 w-20">{label}:</span>
      <code className="flex-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-gray-200 font-mono text-xs truncate">
        {value}
      </code>
      <button
        onClick={copy}
        className="text-gray-400 hover:text-gray-200 text-xs"
        title="Copiar"
      >
        {copied ? "✓" : "📋"}
      </button>
    </div>
  )
}
