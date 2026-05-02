"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

const TURN_LABELS: Record<number, string> = {
  0: "Rapport",
  1: "Profundizar",
  2: "Profundizar 2",
  3: "Cierre",
}

const OUTCOME_STYLE: Record<string, string> = {
  manual:         "bg-gray-700/50 text-gray-400 border-gray-600",
  replied:        "bg-green-500/15 text-green-400 border-green-500/30",
  meeting_booked: "bg-blue-500/15 text-blue-400 border-blue-500/30",
}

interface PlaybookEntry {
  id: string
  title: string
  situation: string | null
  tags: string[] | null
  applies_to_turns: number[] | null
  outcome: string
  outcome_count: number
  is_active: boolean
}

interface Props {
  entry: PlaybookEntry
  isAdmin: boolean
}

export function CerebroPlaybookRow({ entry, isAdmin }: Props) {
  const router = useRouter()
  const [isActive, setIsActive] = useState(entry.is_active)
  const [toggling, setToggling] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function handleToggle() {
    if (!isAdmin || toggling) return
    setToggling(true)
    const next = !isActive
    setIsActive(next) // optimistic

    try {
      const res = await fetch(`/api/cerebro/playbook/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: next }),
      })
      if (!res.ok) {
        setIsActive(!next) // revert
        console.error("Toggle failed")
      } else {
        router.refresh()
      }
    } catch {
      setIsActive(!next)
    } finally {
      setToggling(false)
    }
  }

  async function handleDelete() {
    if (!isAdmin) return
    if (!confirm(`¿Eliminar el ejemplo "${entry.title}"?\n\nEsta acción no se puede deshacer.`)) return
    setDeleting(true)

    try {
      const res = await fetch(`/api/cerebro/playbook/${entry.id}`, { method: "DELETE" })
      if (!res.ok) {
        console.error("Delete failed")
        setDeleting(false)
      } else {
        router.refresh()
      }
    } catch {
      setDeleting(false)
    }
  }

  const tags = entry.tags ?? []
  const turns = entry.applies_to_turns ?? []
  const outcomeCls = OUTCOME_STYLE[entry.outcome] ?? OUTCOME_STYLE.manual

  return (
    <tr className="hover:bg-gray-800/40 transition-colors">
      {/* Título */}
      <td className="px-4 py-3">
        <p className="text-gray-50 text-sm font-medium">{entry.title}</p>
      </td>

      {/* Situación */}
      <td className="px-4 py-3 max-w-xs">
        {entry.situation ? (
          <p className="text-gray-400 text-xs line-clamp-2">{entry.situation}</p>
        ) : (
          <span className="text-gray-700 text-xs">—</span>
        )}
      </td>

      {/* Tags */}
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {tags.length > 0 ? tags.map(tag => (
            <span key={tag} className="px-1.5 py-0.5 bg-gray-800 border border-gray-700 rounded text-gray-400 text-[10px]">
              {tag}
            </span>
          )) : <span className="text-gray-700 text-xs">—</span>}
        </div>
      </td>

      {/* Turnos */}
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {turns.map(t => (
            <span key={t} className="px-1.5 py-0.5 bg-blue-600/10 border border-blue-500/20 rounded text-blue-400 text-[10px]">
              {t}·{TURN_LABELS[t] ?? t}
            </span>
          ))}
        </div>
      </td>

      {/* Outcome */}
      <td className="px-4 py-3">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs ${outcomeCls}`}>
          {entry.outcome}
          {entry.outcome_count > 0 && (
            <span className="font-bold text-[10px]">·{entry.outcome_count}</span>
          )}
        </span>
      </td>

      {/* Activo toggle */}
      <td className="px-4 py-3">
        {isAdmin ? (
          <button
            onClick={handleToggle}
            disabled={toggling}
            title={isActive ? "Desactivar" : "Activar"}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50 ${
              isActive ? "bg-green-600" : "bg-gray-700"
            }`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              isActive ? "translate-x-4" : "translate-x-0.5"
            }`} />
          </button>
        ) : (
          <span className={`w-2 h-2 rounded-full inline-block ${isActive ? "bg-green-400" : "bg-gray-600"}`} />
        )}
      </td>

      {/* Acciones */}
      <td className="px-4 py-3">
        {isAdmin && (
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="bg-red-900/40 hover:bg-red-800/40 text-red-400 rounded-lg px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
          >
            {deleting ? "..." : "Eliminar"}
          </button>
        )}
      </td>
    </tr>
  )
}
