"use client"

import { useState, useCallback } from "react"
import { RemoteBrowserModal }    from "./remote-browser-modal"

interface Props {
  accountId:    string
  accountLabel: string
}

export function CookieRefreshBtn({ accountId, accountLabel }: Props) {
  const [open, setOpen] = useState(false)

  const handleSuccess = useCallback(() => {
    // Reload page after a brief delay so the user sees the success screen
    setTimeout(() => window.location.reload(), 1_500)
  }, [])

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
          bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 hover:border-blue-500/50
          text-blue-400 hover:text-blue-300 transition-colors"
        title="Abrir browser remoto para renovar la cookie de LinkedIn"
      >
        <span>🔑</span>
        Renovar Cookie
      </button>

      {open && (
        <RemoteBrowserModal
          accountId={accountId}
          accountLabel={accountLabel}
          onClose={() => setOpen(false)}
          onSuccess={handleSuccess}
        />
      )}
    </>
  )
}
