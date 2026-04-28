"use client"

import { useState } from "react"

interface DeleteUserBtnProps {
  userId: string
  userEmail: string
  action: (formData: FormData) => Promise<void>
}

export function DeleteUserBtn({ userId, userEmail, action }: DeleteUserBtnProps) {
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="w-full py-2 bg-red-600/20 hover:bg-red-600/40 text-red-400 text-xs font-medium rounded-lg border border-red-500/30 transition-colors"
      >
        🗑 Eliminar usuario
      </button>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-red-400 font-medium">
        ¿Eliminar <span className="font-bold">{userEmail}</span>?<br />
        <span className="text-red-300/70">Esta acción no se puede deshacer.</span>
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="flex-1 py-1.5 text-xs rounded-lg border border-gray-600 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
        >
          Cancelar
        </button>
        <form action={action}>
          <input type="hidden" name="user_id" value={userId} />
          <button
            type="submit"
            className="px-3 py-1.5 text-xs rounded-lg bg-red-600 hover:bg-red-500 text-white font-medium transition-colors"
          >
            Sí, eliminar
          </button>
        </form>
      </div>
    </div>
  )
}
