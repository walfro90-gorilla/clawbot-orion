"use client"

import { useState } from "react"

export function CopyTextButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          /* clipboard bloqueado — el usuario puede seleccionar el texto manualmente */
        }
      }}
      className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-200"
    >
      {copied ? "✓ Copiado" : "Copiar texto"}
    </button>
  )
}
