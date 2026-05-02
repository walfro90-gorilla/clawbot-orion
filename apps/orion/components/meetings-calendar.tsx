"use client"

import { useState, useMemo } from "react"
import Link from "next/link"

export type MeetingItem = {
  id: string
  leadId: string
  leadName: string
  linkedinUrl: string | null
  campaignName: string | null
  scheduledAt: string        // ISO
  durationMin: number
  meetingUrl: string | null
  location: string | null
  status: string | null
}

// ── Google Calendar link ──────────────────────────────────────────────────────
function toGcalDate(iso: string) {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "").replace("Z", "Z")
}

function gcalLink(m: MeetingItem) {
  const start = new Date(m.scheduledAt)
  const end   = new Date(start.getTime() + m.durationMin * 60_000)
  const fmt   = (d: Date) => toGcalDate(d.toISOString())
  const params = new URLSearchParams({
    action:   "TEMPLATE",
    text:     `Reunión EBOOMS — ${m.leadName}`,
    dates:    `${fmt(start)}/${fmt(end)}`,
    details:  `Lead: ${m.linkedinUrl ?? "—"}\nCampaña: ${m.campaignName ?? "—"}`,
    location: m.meetingUrl ?? "",
  })
  return `https://calendar.google.com/calendar/render?${params}`
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function startOfWeek(d: Date) {
  const c = new Date(d); c.setHours(0, 0, 0, 0)
  const day = c.getDay(); c.setDate(c.getDate() - (day === 0 ? 6 : day - 1))
  return c
}
function addDays(d: Date, n: number) {
  const c = new Date(d); c.setDate(c.getDate() + n); return c
}
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" })
}
function fmtDate(d: Date) {
  return d.toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short", timeZone: "America/Mexico_City" })
}
function fmtLong(iso: string) {
  return new Date(iso).toLocaleString("es-MX", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City",
  })
}

// ── Meeting card ──────────────────────────────────────────────────────────────
function MeetingCard({ m, compact = false }: { m: MeetingItem; compact?: boolean }) {
  const now    = new Date()
  const start  = new Date(m.scheduledAt)
  const isPast = start < now
  const isNow  = start <= now && new Date(start.getTime() + m.durationMin * 60_000) > now

  return (
    <div className={`group rounded-lg border text-xs transition-all ${
      isNow  ? "bg-green-500/20 border-green-500/50 shadow-sm shadow-green-500/10" :
      isPast ? "bg-gray-800/50 border-gray-700/50" :
               "bg-blue-500/10 border-blue-500/30 hover:border-blue-400/50"
    } ${compact ? "p-2" : "p-3"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {isNow && <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-green-400 mb-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" /> EN CURSO
          </span>}
          <Link href={`/dashboard/conversations/${m.leadId}`}
            className="font-semibold text-gray-50 hover:text-blue-400 transition-colors truncate block">
            {m.leadName}
          </Link>
          {!compact && <p className="text-gray-400 mt-0.5 truncate">{m.campaignName ?? "—"}</p>}
          <p className="text-gray-400 mt-0.5">{fmtTime(m.scheduledAt)} · {m.durationMin} min</p>
        </div>
        <div className={`shrink-0 w-2 h-2 rounded-full mt-1 ${
          isPast ? "bg-gray-500" : isNow ? "bg-green-400 animate-pulse" : "bg-blue-400"
        }`} />
      </div>
      {!compact && (
        <div className="flex items-center gap-2 mt-2">
          {m.meetingUrl && (
            <a href={m.meetingUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors">
              🎥 Unirse
            </a>
          )}
          <a href={gcalLink(m)} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 text-gray-400 hover:text-gray-200 transition-colors ml-auto">
            📅 Google Cal
          </a>
        </div>
      )}
    </div>
  )
}

// ── Week view ─────────────────────────────────────────────────────────────────
function WeekView({ meetings, weekStart }: { meetings: MeetingItem[]; weekStart: Date }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const today = new Date()
  const HOURS = Array.from({ length: 13 }, (_, i) => i + 7) // 7am–7pm

  function meetingsForDay(day: Date) {
    return meetings.filter(m => sameDay(new Date(m.scheduledAt), day))
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[700px]">
        {/* Day headers */}
        <div className="grid grid-cols-[48px_repeat(7,1fr)] gap-px bg-gray-800 rounded-t-xl overflow-hidden">
          <div className="bg-gray-900" />
          {days.map(d => {
            const isToday = sameDay(d, today)
            return (
              <div key={d.toISOString()} className={`bg-gray-900 px-2 py-2 text-center ${isToday ? "bg-blue-600/10" : ""}`}>
                <p className="text-[10px] text-gray-500 uppercase tracking-wide">{
                  d.toLocaleDateString("es-MX", { weekday: "short" })
                }</p>
                <p className={`text-sm font-bold ${isToday ? "text-blue-400" : "text-gray-200"}`}>
                  {d.getDate()}
                </p>
              </div>
            )
          })}
        </div>

        {/* Time grid */}
        <div className="bg-gray-900 border border-gray-800 border-t-0 rounded-b-xl overflow-hidden">
          {HOURS.map(h => (
            <div key={h} className="grid grid-cols-[48px_repeat(7,1fr)] gap-px border-t border-gray-800/60">
              <div className="py-2 pr-2 text-right">
                <span className="text-[10px] text-gray-600">{h}:00</span>
              </div>
              {days.map(d => {
                const dayMeetings = meetingsForDay(d).filter(m => {
                  const mh = new Date(m.scheduledAt).getHours()
                  return mh === h
                })
                const isToday = sameDay(d, today)
                return (
                  <div key={d.toISOString()} className={`min-h-[52px] p-0.5 ${isToday ? "bg-blue-600/5" : ""}`}>
                    {dayMeetings.map(m => (
                      <MeetingCard key={m.id} m={m} compact />
                    ))}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── List view ─────────────────────────────────────────────────────────────────
function ListView({ upcoming, past }: { upcoming: MeetingItem[]; past: MeetingItem[] }) {
  return (
    <div className="space-y-6">
      {upcoming.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Próximas reuniones</p>
          {upcoming.map(m => (
            <div key={m.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link href={`/dashboard/conversations/${m.leadId}`}
                    className="font-semibold text-gray-50 hover:text-blue-400 transition-colors">
                    {m.leadName}
                  </Link>
                  {m.linkedinUrl && (
                    <a href={m.linkedinUrl} target="_blank" rel="noopener noreferrer"
                      className="text-[10px] text-gray-500 hover:text-blue-400">
                      LinkedIn ↗
                    </a>
                  )}
                </div>
                <p className="text-sm text-gray-400 mt-0.5">{m.campaignName ?? "—"}</p>
                <p className="text-xs text-blue-300 mt-1">{fmtLong(m.scheduledAt)} · {m.durationMin} min</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {m.meetingUrl && (
                  <a href={m.meetingUrl} target="_blank" rel="noopener noreferrer"
                    className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors font-medium">
                    🎥 Unirse
                  </a>
                )}
                <a href={gcalLink(m)} target="_blank" rel="noopener noreferrer"
                  className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white px-3 py-1.5 rounded-lg transition-colors border border-gray-700">
                  📅 Google Cal
                </a>
                <Link href={`/dashboard/conversations/${m.leadId}`}
                  className="text-xs text-gray-500 hover:text-blue-400 transition-colors px-2 py-1.5">
                  Ver hilo →
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      {past.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Reuniones pasadas</p>
          {past.map(m => (
            <div key={m.id} className="bg-gray-900 border border-gray-800/50 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-4 opacity-70">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Link href={`/dashboard/conversations/${m.leadId}`}
                    className="font-medium text-gray-300 hover:text-blue-400 transition-colors">
                    {m.leadName}
                  </Link>
                </div>
                <p className="text-sm text-gray-500 mt-0.5">{m.campaignName ?? "—"}</p>
                <p className="text-xs text-gray-500 mt-1">{fmtLong(m.scheduledAt)} · {m.durationMin} min</p>
              </div>
              <Link href={`/dashboard/conversations/${m.leadId}`}
                className="text-xs text-gray-600 hover:text-blue-400 transition-colors shrink-0">
                Ver hilo →
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main exported component ───────────────────────────────────────────────────
export function MeetingsCalendar({ meetings }: { meetings: MeetingItem[] }) {
  const [view, setView]         = useState<"week" | "list">("list")
  const [weekOffset, setWeekOffset] = useState(0)

  const now       = new Date()
  const weekStart = useMemo(() => {
    const base = startOfWeek(now)
    return addDays(base, weekOffset * 7)
  }, [weekOffset])

  const weekEnd = addDays(weekStart, 6)

  const weekMeetings = useMemo(() =>
    meetings.filter(m => {
      const d = new Date(m.scheduledAt)
      return d >= weekStart && d <= addDays(weekEnd, 1)
    }), [meetings, weekStart])

  const upcoming = meetings.filter(m => new Date(m.scheduledAt) >= now)
  const past     = meetings.filter(m => new Date(m.scheduledAt) < now)

  const weekLabel = `${fmtDate(weekStart)} — ${fmtDate(weekEnd)}`

  if (meetings.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-16 text-center">
        <p className="text-5xl mb-4">📅</p>
        <p className="text-gray-50 font-semibold text-lg">Sin reuniones agendadas</p>
        <p className="text-gray-400 text-sm mt-2 max-w-sm mx-auto">
          Las reuniones aparecerán aquí cuando un lead agende a través del link de Cal.com.
          El sistema las detecta automáticamente vía webhook.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1">
          <button onClick={() => setView("list")}
            className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
              view === "list" ? "bg-blue-600 text-white" : "text-gray-400 hover:text-gray-200"
            }`}>
            ☰ Lista
          </button>
          <button onClick={() => setView("week")}
            className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
              view === "week" ? "bg-blue-600 text-white" : "text-gray-400 hover:text-gray-200"
            }`}>
            📅 Semana
          </button>
        </div>

        {view === "week" && (
          <div className="flex items-center gap-2">
            <button onClick={() => setWeekOffset(o => o - 1)}
              className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors text-sm">
              ‹
            </button>
            <span className="text-xs text-gray-400 min-w-[200px] text-center">{weekLabel}</span>
            <button onClick={() => setWeekOffset(o => o + 1)}
              className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors text-sm">
              ›
            </button>
            {weekOffset !== 0 && (
              <button onClick={() => setWeekOffset(0)}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors ml-1">
                Hoy
              </button>
            )}
          </div>
        )}

        <div className="flex items-center gap-1 text-xs text-gray-500">
          <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" /> Próxima
          <span className="w-2 h-2 rounded-full bg-green-400 inline-block ml-2" /> En curso
          <span className="w-2 h-2 rounded-full bg-gray-500 inline-block ml-2" /> Pasada
        </div>
      </div>

      {view === "week"
        ? <WeekView meetings={weekMeetings} weekStart={weekStart} />
        : <ListView upcoming={upcoming} past={past} />
      }
    </div>
  )
}
