"use client"

// Form con "dirty-state": el botón Guardar se deshabilita cuando no hay cambios y
// muestra "Cambios sin guardar." / "No hay cambios por guardar." (mismo patrón que
// el form de Campañas). Drop-in para forms server-action: en vez de
//   <form action={serverAction}>...campos...<button>Guardar</button></form>
// usar
//   <DirtyAwareForm action={serverAction}>...campos...</DirtyAwareForm>
// El wrapper aporta el <form>, el botón y la lógica de cambios.

import { useEffect, useRef, useState, useTransition, type ReactNode, type FormEvent } from "react"

// Serializa todos los campos nombrados a un string estable (orden-independiente).
// Captura inputs/select/textarea/hidden/checkbox vía FormData.
function serialize(form: HTMLFormElement): string {
  const fd = new FormData(form)
  const parts: string[] = []
  for (const [k, v] of fd.entries()) {
    if (typeof v === "string") parts.push(`${k}=${v}`)
  }
  return parts.sort().join("")
}

type SaveResult = { error?: string } | void

export function DirtyAwareForm({
  action,
  children,
  className,
  saveLabel = "Guardar configuración",
  footerClassName,
  footerExtra,
}: {
  action: (fd: FormData) => Promise<SaveResult> | SaveResult
  children: ReactNode
  className?: string
  saveLabel?: string
  /** className del contenedor del footer (botón + texto de cambios). Default: fila simple. */
  footerClassName?: string
  /** contenido extra al inicio del footer (p.ej. una nota); usa mr-auto para empujar el botón a la derecha. */
  footerExtra?: ReactNode
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const initialRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [isPending, startTransition] = useTransition()

  // Snapshot inicial tras montar (los hidden controlados — p.ej. followup_steps_json —
  // ya están renderizados con su valor real para entonces).
  useEffect(() => {
    if (formRef.current) initialRef.current = serialize(formRef.current)
  }, [])

  function recheck() {
    if (timerRef.current) clearTimeout(timerRef.current)
    // setTimeout deja que React confirme el render de hidden controlados antes de releer.
    timerRef.current = setTimeout(() => {
      const form = formRef.current
      if (!form || initialRef.current == null) return
      const changed = serialize(form) !== initialRef.current
      setDirty(changed)
      if (changed) setSaved(false)
    }, 60)
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!dirty || isPending) return
    const form = formRef.current
    if (!form) return
    const fd = new FormData(form)
    setError(null)
    startTransition(async () => {
      try {
        const res = await action(fd)
        if (res && typeof res === "object" && "error" in res && res.error) {
          setError(res.error)
          return
        }
        // Éxito sin redirect (revalidate): re-snapshot → ya no hay cambios.
        if (formRef.current) initialRef.current = serialize(formRef.current)
        setDirty(false)
        setSaved(true)
      } catch (err) {
        // Los redirects de Next se relanzan para que el framework navegue.
        const digest = (err as { digest?: string })?.digest
        if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) throw err
        setError((err as { message?: string })?.message ?? "Error al guardar")
      }
    })
  }

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      onInput={recheck}
      onChange={recheck}
      onClick={recheck}
      className={className}
    >
      {children}
      {error && <p className="text-sm text-red-400">⚠️ {error}</p>}
      <div className={footerClassName ?? "flex items-center gap-3 pt-1"}>
        {footerExtra}
        <button
          type="submit"
          disabled={!dirty || isPending}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
        >
          {isPending ? "Guardando…" : saveLabel}
        </button>
        <span className={`text-xs ${dirty ? "text-blue-300/80" : saved ? "text-emerald-400/80" : "text-gray-500"}`}>
          {isPending ? "" : dirty ? "Cambios sin guardar." : saved ? "✓ Guardado." : "No hay cambios por guardar."}
        </span>
      </div>
    </form>
  )
}
