"use client"

import { useState, ReactNode } from "react"

interface Tab {
  key:   string
  label: string
  icon:  string
}

interface Props {
  tabs:      Tab[]
  children:  ReactNode[]   // un nodo por tab, en el mismo orden
  defaultTab?: string
}

/**
 * Tabs interactivas para configuración de campañas.
 *
 * Por qué todas las sections quedan en el DOM (display:none la inactiva):
 *   - El form es server action (un solo submit con TODOS los campos).
 *   - Si removiéramos las sections inactivas del DOM, los inputs no existirían
 *     y se borrarían valores al cambiar de tab.
 *   - CSS hidden conserva los inputs en formData sin renderizarlos visualmente.
 *
 * Important: cada <button> usa type="button" para que NO submit el form.
 */
export function CampaignTabs({ tabs, children, defaultTab }: Props) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.key ?? "")
  const activeIdx = tabs.findIndex(t => t.key === active)

  return (
    <>
      {/* Tab bar — sticky para fácil navegación en pantallas largas */}
      <div className="sticky top-0 z-20 -mx-4 sm:-mx-8 px-4 sm:px-8 pt-2 pb-0 bg-gray-950/95 backdrop-blur border-b border-gray-800 mb-6">
        <div className="flex gap-1 overflow-x-auto scrollbar-hide">
          {tabs.map(t => {
            const isActive = t.key === active
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setActive(t.key)}
                className={
                  "flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium whitespace-nowrap " +
                  "border-b-2 transition-colors " +
                  (isActive
                    ? "border-blue-500 text-blue-300"
                    : "border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-700")
                }
              >
                <span className="text-base leading-none">{t.icon}</span>
                <span>{t.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Content — sections inactivas usan `hidden` (display:none) */}
      {tabs.map((t, i) => (
        <div key={t.key} className={i === activeIdx ? "" : "hidden"}>
          {children[i]}
        </div>
      ))}
    </>
  )
}
