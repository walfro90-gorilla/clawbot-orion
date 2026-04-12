"use client"

import { useTransition } from "react"

interface Props {
  campaignId: string
  campaignName: string
  deleteAction: (formData: FormData) => Promise<void>
}

export default function DeleteCampaignBtn({ campaignId, campaignName, deleteAction }: Props) {
  const [isPending, startTransition] = useTransition()

  function handleDelete() {
    if (!confirm(`¿Eliminar la campaña "${campaignName}"?\n\nEsta acción no se puede deshacer. Se eliminarán también todos sus templates de mensajes.`)) return

    startTransition(async () => {
      const fd = new FormData()
      fd.set("campaign_id", campaignId)
      await deleteAction(fd)
    })
  }

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={isPending}
      className="px-3 py-1.5 text-xs bg-red-600/15 hover:bg-red-600/30 text-red-400 border border-red-500/30 rounded-lg transition-colors disabled:opacity-50"
    >
      {isPending ? "Eliminando..." : "🗑 Eliminar campaña"}
    </button>
  )
}
