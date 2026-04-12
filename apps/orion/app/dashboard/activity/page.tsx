import { createClient } from "@/lib/supabase/server"
import Link from "next/link"

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; action?: string }>
}) {
  const sp = await searchParams
  const supabase = await createClient()
  const page = parseInt(sp.page ?? "1")
  const PAGE_SIZE = 100

  let query = supabase
    .from("activity_log")
    .select("*, leads(full_name, linkedin_url), linkedin_accounts(label, linkedin_profile_url)")
    .order("created_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)

  if (sp.action) query = query.eq("action", sp.action)

  const { data: logs } = await query

  const ACTIONS = ["batch_process", "batch_completed", "search_completed", "inbox_scrape_failed"]
  const resultColor: Record<string, string> = {
    success: "text-green-400",
    error:   "text-red-400",
    warning: "text-yellow-400",
  }
  const outcomeColor: Record<string, string> = {
    sent:         "text-blue-400",
    disqualified: "text-red-400",
    dry_run:      "text-gray-400",
    error:        "text-red-400",
    unknown:      "text-gray-500",
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Actividad</h1>
          <p className="text-gray-400 text-sm mt-0.5">Log completo de operaciones del worker</p>
        </div>
      </div>

      {/* Filters */}
      <form method="GET" className="flex gap-3">
        <select
          name="action"
          defaultValue={sp.action ?? ""}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Todas las acciones</option>
          {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <button type="submit" className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg">
          Filtrar
        </button>
        {sp.action && (
          <Link href="/dashboard/activity" className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg">
            Limpiar
          </Link>
        )}
      </form>

      {/* Log table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
              <th className="px-4 py-3 text-left font-medium">Fecha</th>
              <th className="px-4 py-3 text-left font-medium">Acción</th>
              <th className="px-4 py-3 text-left font-medium">Resultado</th>
              <th className="px-4 py-3 text-left font-medium">Lead</th>
              <th className="px-4 py-3 text-left font-medium">Cuenta</th>
              <th className="px-4 py-3 text-left font-medium">Detalle</th>
              <th className="px-4 py-3 text-right font-medium">ms</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {!logs || logs.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-gray-500">Sin actividad registrada.</td>
              </tr>
            ) : logs.map((log: any) => {
              const outcome = log.details?.outcome as string | undefined
              return (
                <tr key={log.id} className="hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-2.5 text-gray-400 text-xs whitespace-nowrap">
                    {new Date(log.created_at).toLocaleString("es-MX")}
                  </td>
                  <td className="px-4 py-2.5 text-white text-xs font-mono">{log.action}</td>
                  <td className="px-4 py-2.5 text-xs">
                    <span className={resultColor[log.result ?? ""] ?? "text-gray-400"}>{log.result}</span>
                    {outcome && (
                      <span className={`ml-2 ${outcomeColor[outcome] ?? "text-gray-400"}`}>· {outcome}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {log.leads ? (
                      <Link href={`/dashboard/leads/${log.lead_id}`} className="text-blue-400 hover:underline">
                        {log.leads.full_name}
                      </Link>
                    ) : <span className="text-gray-500">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-gray-400 text-xs">
                    {log.linkedin_accounts?.label ?? log.linkedin_accounts?.linkedin_profile_url?.replace("https://www.linkedin.com/in/","") ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs max-w-[200px]">
                    <div className="truncate">
                      {log.details ? JSON.stringify(log.details).slice(0, 80) : "—"}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs text-right">
                    {log.duration_ms ? `${(log.duration_ms / 1000).toFixed(1)}s` : "—"}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      </div>

      {/* Pagination */}
      <div className="flex gap-2">
        {page > 1 && (
          <Link href={`?page=${page - 1}&action=${sp.action ?? ""}`}
            className="px-4 py-2 bg-gray-800 text-white rounded-lg text-sm hover:bg-gray-700">
            ← Anterior
          </Link>
        )}
        {logs && logs.length === PAGE_SIZE && (
          <Link href={`?page=${page + 1}&action=${sp.action ?? ""}`}
            className="px-4 py-2 bg-gray-800 text-white rounded-lg text-sm hover:bg-gray-700">
            Siguiente →
          </Link>
        )}
      </div>
    </div>
  )
}
