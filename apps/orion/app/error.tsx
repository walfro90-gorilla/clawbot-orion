"use client"

import { useEffect } from "react"
import Link from "next/link"

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[Global Error]", error)
  }, [error])

  return (
    <html lang="es">
      <body className="bg-gray-950 min-h-screen flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <div className="text-6xl mb-4">🚨</div>
          <h1 className="text-white text-2xl font-bold mb-2">Error crítico</h1>
          <p className="text-gray-400 text-sm mb-6">
            {error.message || "La aplicación encontró un error inesperado."}
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={reset}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Reintentar
            </button>
            <Link
              href="/dashboard"
              className="px-5 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-lg transition-colors"
            >
              Ir al dashboard
            </Link>
          </div>
          {error.digest && (
            <p className="text-gray-600 text-xs mt-4">Error ID: {error.digest}</p>
          )}
        </div>
      </body>
    </html>
  )
}
