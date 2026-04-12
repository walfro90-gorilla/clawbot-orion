"use client"

import { useEffect } from "react"

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[Dashboard Error]", error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-8 text-center">
      <div className="text-5xl mb-4">⚠️</div>
      <h2 className="text-white text-xl font-semibold mb-2">Algo salió mal</h2>
      <p className="text-gray-400 text-sm max-w-sm mb-6">
        {error.message || "Ocurrió un error inesperado en el dashboard."}
      </p>
      <button
        onClick={reset}
        className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
      >
        Reintentar
      </button>
      {error.digest && (
        <p className="text-gray-600 text-xs mt-4">Error ID: {error.digest}</p>
      )}
    </div>
  )
}
