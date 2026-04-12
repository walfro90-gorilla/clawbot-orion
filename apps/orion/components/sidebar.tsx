"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"

const NAV = [
  { href: "/dashboard",                   label: "Dashboard",  icon: "⚡", adminOnly: false },
  { href: "/dashboard/leads",             label: "Leads",      icon: "👥", adminOnly: false },
  { href: "/dashboard/conversations",     label: "Mensajes",   icon: "💬", adminOnly: false },
  { href: "/dashboard/campaigns",         label: "Campañas",   icon: "🎯", adminOnly: false },
  { href: "/dashboard/accounts",          label: "Cuentas LI", icon: "🔗", adminOnly: true  },
  { href: "/dashboard/activity",          label: "Actividad",  icon: "📋", adminOnly: false },
  { href: "/dashboard/monitor",           label: "Monitor",    icon: "🖥️", adminOnly: true  },
  { href: "/dashboard/users",             label: "Usuarios",   icon: "🛡️", adminOnly: true  },
]

const ROLE_BADGE: Record<string, { label: string; cls: string }> = {
  god_admin: { label: "God Admin", cls: "text-yellow-400" },
  admin:     { label: "Admin",     cls: "text-purple-400" },
  user:      { label: "User",      cls: "text-blue-400"   },
  viewer:    { label: "Viewer",    cls: "text-gray-400"   },
}

interface SidebarProps {
  email?: string
  role?: string
  alertCount?: number
  unreadCount?: number
}

export function Sidebar({ email, role, alertCount = 0, unreadCount = 0 }: SidebarProps) {
  const path          = usePathname()
  const [menuOpen,    setMenuOpen]    = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const initials  = email?.[0]?.toUpperCase() ?? "?"
  const roleBadge = ROLE_BADGE[role ?? "user"] ?? ROLE_BADGE.user
  const isAdmin   = role === "god_admin" || role === "admin"

  const visibleNav = NAV.filter(({ adminOnly }) => !adminOnly || isAdmin)

  function NavItem({ href, label, icon }: { href: string; label: string; icon: string }) {
    const active          = path === href || (href !== "/dashboard" && path.startsWith(href))
    const isMonitor       = href === "/dashboard/monitor"
    const isConversations = href === "/dashboard/conversations"
    return (
      <Link href={href} onClick={() => setSidebarOpen(false)}
        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
          active ? "bg-blue-600 text-white font-medium" : "text-gray-400 hover:text-white hover:bg-gray-800"
        }`}>
        <span>{icon}</span>
        {label}
        {isMonitor && alertCount > 0 && (
          <span className="ml-auto flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">
            {alertCount > 9 ? "9+" : alertCount}
          </span>
        )}
        {isConversations && unreadCount > 0 && (
          <span className="ml-auto flex items-center justify-center w-4 h-4 rounded-full bg-green-500 text-white text-[9px] font-bold">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </Link>
    )
  }

  function UserMenu() {
    return (
      <div className="px-3 py-3 border-t border-gray-800">
        <button onClick={() => setMenuOpen(o => !o)}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-800 transition-colors text-left">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white text-xs font-medium truncate">{email ?? "Usuario"}</p>
            <p className={`text-xs ${roleBadge.cls}`}>{roleBadge.label}</p>
          </div>
          <span className={`text-gray-500 text-xs transition-transform ${menuOpen ? "rotate-180" : ""}`}>▾</span>
        </button>

        {menuOpen && (
          <div className="mt-1 bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
            {isAdmin && (
              <>
                <Link href="/dashboard/users" onClick={() => { setMenuOpen(false); setSidebarOpen(false) }}
                  className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors">
                  <span>🛡️</span> Gestión de usuarios
                </Link>
                <Link href="/dashboard/monitor" onClick={() => { setMenuOpen(false); setSidebarOpen(false) }}
                  className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-white transition-colors">
                  <span>🖥️</span> Monitor
                </Link>
              </>
            )}
            <div className="border-t border-gray-700">
              <form action="/auth/signout" method="post">
                <button type="submit"
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-400 hover:bg-gray-700 hover:text-red-300 transition-colors">
                  <span>🚪</span> Cerrar sesión
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      {/* ── Mobile top bar ─────────────────────────────────────────────────────── */}
      <div className="sm:hidden fixed top-0 left-0 right-0 z-40 h-12 flex items-center px-4 bg-gray-900 border-b border-gray-800">
        <button onClick={() => setSidebarOpen(o => !o)}
          className="text-gray-400 hover:text-white p-1 rounded-lg" aria-label="Menú">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span className="ml-3 text-white font-bold text-sm">
          <span className="text-blue-400">Orion</span>
          <span className="text-gray-500 font-normal text-xs ml-1.5">by ClawBot</span>
        </span>
        {(alertCount + unreadCount) > 0 && (
          <span className="ml-auto flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold animate-pulse">
            {(alertCount + unreadCount) > 9 ? "9+" : alertCount + unreadCount}
          </span>
        )}
      </div>

      {/* ── Mobile overlay ─────────────────────────────────────────────────────── */}
      {sidebarOpen && (
        <div className="sm:hidden fixed inset-0 z-40 bg-black/60" onClick={() => setSidebarOpen(false)} />
      )}

      {/* ── Mobile drawer ──────────────────────────────────────────────────────── */}
      <aside className={`sm:hidden fixed top-0 left-0 z-50 h-full w-56 flex flex-col bg-gray-900 border-r border-gray-800 transform transition-transform duration-200 ${
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      }`}>
        <div className="h-12 flex items-center px-4 border-b border-gray-800">
          <span className="text-white font-bold text-sm"><span className="text-blue-400">Orion</span></span>
          <button onClick={() => setSidebarOpen(false)} className="ml-auto text-gray-400 hover:text-white p-1">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {visibleNav.map(item => <NavItem key={item.href} {...item} />)}
        </nav>
        <UserMenu />
      </aside>

      {/* ── Desktop sidebar ─────────────────────────────────────────────────────── */}
      <aside className="hidden sm:flex w-56 shrink-0 flex-col bg-gray-900 border-r border-gray-800 min-h-screen">
        {/* Logo */}
        <div className="h-14 flex items-center px-5 border-b border-gray-800">
          <span className="text-white font-bold tracking-tight">
            <span className="text-blue-400">Orion</span>
            <span className="text-gray-500 text-xs font-normal ml-2">by ClawBot</span>
          </span>
          {alertCount > 0 && (
            <span className="ml-auto flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold animate-pulse">
              {alertCount > 9 ? "9+" : alertCount}
            </span>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {visibleNav.map(item => <NavItem key={item.href} {...item} />)}
        </nav>

        <UserMenu />
      </aside>
    </>
  )
}
