"use client"
import { useState, useEffect } from "react"

interface TourStep {
  icon: string
  title: string
  description: string
  target?: string           // CSS selector of element to spotlight
  tooltipSide?: "right" | "bottom" | "center"
}

const BASE_STEPS: TourStep[] = [
  {
    icon: "👋",
    title: "Bienvenido a Orion",
    description:
      "Tu centro de control para la automatización de LinkedIn. En 2 minutos te mostramos todo lo que necesitas saber para empezar.",
    tooltipSide: "center",
  },
  {
    icon: "⚡",
    title: "Dashboard — Vista ejecutiva",
    description:
      "El punto de partida: KPIs clave (leads, invitaciones, respuestas, reuniones), embudo de conversión y estado de tus cuentas LinkedIn en tiempo real.",
    target: '[data-tour="sidebar"] a[href="/dashboard"]',
    tooltipSide: "right",
  },
  {
    icon: "👥",
    title: "Leads — Tus prospectos",
    description:
      "Lista completa de contactos con su etapa: Pendiente → Invitado → Conectado → Respondió → Reunión. Incluye alertas de días sin respuesta y secuencia de follow-ups.",
    target: '[data-tour="sidebar"] a[href="/dashboard/leads"]',
    tooltipSide: "right",
  },
  {
    icon: "💬",
    title: "Mensajes — Bandeja de respuestas",
    description:
      "Cuando un lead responde en LinkedIn, aparece aquí. La IA genera un borrador de respuesta que tú revisas y apruebas antes de enviar. Nada sale sin tu validación.",
    target: '[data-tour="sidebar"] a[href="/dashboard/conversations"]',
    tooltipSide: "right",
  },
  {
    icon: "📅",
    title: "Reuniones — Agenda confirmada",
    description:
      "Los leads que agendan una llamada a través de tu link de Cal.com se registran automáticamente aquí. Fecha, hora y link en un solo lugar.",
    target: '[data-tour="sidebar"] a[href="/dashboard/meetings"]',
    tooltipSide: "right",
  },
  {
    icon: "🎯",
    title: "Campañas — Control de automatizaciones",
    description:
      "Cada campaña tiene 4 automatizaciones pausables: Búsqueda, Envíos, Follow-ups e Inbox. El indicador de riesgo ayuda a proteger cuentas nuevas.",
    target: '[data-tour="sidebar"] a[href="/dashboard/campaigns"]',
    tooltipSide: "right",
  },
  {
    icon: "📋",
    title: "Actividad — Log completo",
    description:
      "Registro detallado de cada acción del worker: invitaciones, mensajes, errores y timestamps. Ideal para auditoría y para entender qué pasó con un lead.",
    target: '[data-tour="sidebar"] a[href="/dashboard/activity"]',
    tooltipSide: "right",
  },
]

const ADMIN_STEPS: TourStep[] = [
  {
    icon: "🔗",
    title: "Cuentas LinkedIn — Configuración",
    description:
      "Administra tus cuentas: cookie li_at, proxy, límite diario y temperatura de warmup (Fría → Tibia → Cálida → Caliente). La temperatura determina cuántas invitaciones se envían por día.",
    target: '[data-tour="sidebar"] a[href="/dashboard/accounts"]',
    tooltipSide: "right",
  },
  {
    icon: "🖥️",
    title: "Monitor — Estado del sistema",
    description:
      "Vista técnica del scheduler: qué jobs corrieron, último tick, errores en las últimas 24h y estado de cada campaña. Tu primera parada cuando algo no funciona.",
    target: '[data-tour="sidebar"] a[href="/dashboard/monitor"]',
    tooltipSide: "right",
  },
]

const FINAL_STEP: TourStep = {
  icon: "🚀",
  title: "¡Todo listo para empezar!",
  description:
    "Ya conoces Orion. Puedes volver a ver este tour desde el menú de usuario (abajo a la izquierda). Si tienes dudas, el Monitor y Actividad tienen toda la información técnica.",
  tooltipSide: "center",
}

function buildSteps(role: string): TourStep[] {
  const isAdmin = role === "god_admin" || role === "admin"
  return isAdmin
    ? [...BASE_STEPS, ...ADMIN_STEPS, FINAL_STEP]
    : [...BASE_STEPS, FINAL_STEP]
}

interface TargetRect {
  top: number
  left: number
  width: number
  height: number
}

const PAD = 7   // spotlight padding around the target element
const TOOLTIP_W = 360
const TOOLTIP_OFFSET = 16  // gap between spotlight edge and tooltip

export function GuidedTour({ show, role }: { show: boolean; role: string }) {
  const steps = buildSteps(role)
  const [visible, setVisible] = useState(show)
  const [current, setCurrent] = useState(0)
  const [loading, setLoading] = useState(false)
  const [rect, setRect] = useState<TargetRect | null>(null)

  const step = steps[current]

  // Measure the target element whenever step changes
  useEffect(() => {
    if (!step.target) {
      setRect(null)
      return
    }
    const measure = () => {
      const el = document.querySelector(step.target!)
      if (!el) { setRect(null); return }
      const r = el.getBoundingClientRect()
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
    }
    measure()
    // Scroll target into view gently
    const el = document.querySelector(step.target)
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" })

    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [current, step.target])

  if (!visible) return null

  const isFirst = current === 0
  const isLast = current === steps.length - 1

  async function completeTour() {
    setLoading(true)
    try { await fetch("/api/tour/complete", { method: "POST" }) } catch { /* non-critical */ }
    setVisible(false)
  }

  // Spotlight coords (with padding)
  const spot = rect
    ? {
        top:    rect.top    - PAD,
        left:   rect.left   - PAD,
        width:  rect.width  + PAD * 2,
        height: rect.height + PAD * 2,
      }
    : null

  // Tooltip vertical position: centered on spotlight, clamped to viewport
  const tooltipTop = spot
    ? Math.min(
        Math.max(spot.top + spot.height / 2 - 130, 12),
        window.innerHeight - 280
      )
    : 0

  const tooltipLeft = spot ? spot.left + spot.width + TOOLTIP_OFFSET : 0

  const Nav = (
    <div className="flex items-center justify-between mt-6">
      <button
        onClick={completeTour}
        disabled={loading}
        className="text-xs text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-40"
      >
        Saltar tour
      </button>
      <div className="flex items-center gap-3">
        {!isFirst && (
          <button
            onClick={() => setCurrent(c => c - 1)}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors rounded-lg hover:bg-white/10"
          >
            Anterior
          </button>
        )}
        {isLast ? (
          <button
            onClick={completeTour}
            disabled={loading}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60"
          >
            {loading ? "Guardando…" : "Comenzar →"}
          </button>
        ) : (
          <button
            onClick={() => setCurrent(c => c + 1)}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            Siguiente →
          </button>
        )}
      </div>
    </div>
  )

  const Progress = (
    <div className="flex gap-1.5 justify-center mb-5">
      {steps.map((_, i) => (
        <div
          key={i}
          className={`rounded-full transition-all duration-300 ${
            i === current
              ? "w-4 h-2 bg-blue-500"
              : i < current
              ? "w-2 h-2 bg-blue-500/40"
              : "w-2 h-2 bg-gray-700"
          }`}
        />
      ))}
    </div>
  )

  // ── CENTERED MODAL (no target) ───────────────────────────────────────────────
  if (!spot || step.tooltipSide === "center") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" />
        <div className="relative bg-gray-900 border border-gray-700 rounded-2xl p-8 max-w-lg w-full mx-4 shadow-2xl">
          {Progress}
          <div className="text-center text-5xl mb-5">{step.icon}</div>
          <div className="text-center space-y-3">
            <h2 className="text-xl font-bold text-white">{step.title}</h2>
            <p className="text-gray-400 text-sm leading-relaxed">{step.description}</p>
            <p className="text-gray-600 text-xs pt-1">{current + 1} de {steps.length}</p>
          </div>
          {Nav}
        </div>
      </div>
    )
  }

  // ── SPOTLIGHT MODE ───────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 pointer-events-none">

      {/* ── 4-quadrant dark overlay ── */}
      {/* Top */}
      <div
        className="absolute bg-black/75 pointer-events-auto"
        style={{ top: 0, left: 0, right: 0, height: spot.top }}
      />
      {/* Bottom */}
      <div
        className="absolute bg-black/75 pointer-events-auto"
        style={{ top: spot.top + spot.height, left: 0, right: 0, bottom: 0 }}
      />
      {/* Left */}
      <div
        className="absolute bg-black/75 pointer-events-auto"
        style={{ top: spot.top, left: 0, width: spot.left, height: spot.height }}
      />
      {/* Right of spotlight (up to tooltip start) */}
      <div
        className="absolute bg-black/75 pointer-events-auto"
        style={{
          top: spot.top,
          left: spot.left + spot.width,
          right: 0,
          height: spot.height,
        }}
      />

      {/* ── Spotlight border glow ── */}
      <div
        className="absolute rounded-xl pointer-events-none"
        style={{
          top:    spot.top,
          left:   spot.left,
          width:  spot.width,
          height: spot.height,
          boxShadow: "0 0 0 2px #3b82f6, 0 0 20px 4px rgba(59,130,246,0.35)",
        }}
      />

      {/* ── Tooltip card ── */}
      <div
        className="absolute pointer-events-auto"
        style={{
          top:   tooltipTop,
          left:  tooltipLeft,
          width: TOOLTIP_W,
        }}
      >
        {/* Arrow connector */}
        <div
          className="absolute -left-2 top-1/2 -translate-y-1/2 w-0 h-0"
          style={{
            borderTop:    "8px solid transparent",
            borderBottom: "8px solid transparent",
            borderRight:  "8px solid rgb(55 65 81)", // gray-700
          }}
        />

        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 shadow-2xl">
          {Progress}
          <div className="text-3xl mb-3">{step.icon}</div>
          <h2 className="text-base font-bold text-white mb-2">{step.title}</h2>
          <p className="text-gray-400 text-sm leading-relaxed">{step.description}</p>
          <p className="text-gray-600 text-xs mt-3">{current + 1} de {steps.length}</p>
          {Nav}
        </div>
      </div>
    </div>
  )
}
