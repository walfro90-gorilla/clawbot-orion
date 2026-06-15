"use client"

import { useEffect, useState } from "react"

// Banner verde de éxito tras guardar una campaña. Se monta cuando el listado
// recibe ?saved=<nombre> (el edit redirige ahí). Limpia el query param con
// history.replaceState (sin re-navegar, para no desmontarse) y se auto-oculta.

export function SaveSuccessToast({ message }: { message: string }) {
  const [show, setShow] = useState(true)

  useEffect(() => {
    // Quita ?saved de la URL sin disparar navegación de Next (un refresh ya no
    // re-muestra el toast). replaceState NO re-renderiza el server component.
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/dashboard/campaigns")
    }
    const t = setTimeout(() => setShow(false), 6000)
    return () => clearTimeout(t)
  }, [])

  if (!show) return null

  return (
    <div className="flex items-start gap-3 px-4 py-3 bg-emerald-500/10 border border-emerald-500/40 rounded-xl text-sm">
      <span className="text-lg leading-none shrink-0">✅</span>
      <p className="flex-1 text-emerald-200">{message}</p>
      <button
        type="button"
        onClick={() => setShow(false)}
        title="Cerrar"
        className="shrink-0 text-emerald-400/70 hover:text-emerald-200 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}
