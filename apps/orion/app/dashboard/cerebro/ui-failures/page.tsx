import { createAdminClient } from "@/lib/supabase/admin"
import { requireRole } from "@/lib/auth/role"
import { redirect } from "next/navigation"
import Link from "next/link"

// ── Server Actions ─────────────────────────────────────────────────────────────

async function labelFailure(formData: FormData) {
  "use server"
  const db = createAdminClient()
  const id = formData.get("id") as string
  const selector = (formData.get("labeled_selector") as string)?.trim() || null
  const notes    = (formData.get("labeled_notes") as string)?.trim() || null
  await db
    .from("ui_pattern_failures")
    .update({
      labeled_selector: selector,
      labeled_notes:    notes,
      labeled_at:       new Date().toISOString(),
      status:           "labeled",
      updated_at:       new Date().toISOString(),
    })
    .eq("id", id)
  redirect("/dashboard/cerebro/ui-failures")
}

async function ignoreFailure(formData: FormData) {
  "use server"
  const db = createAdminClient()
  const id = formData.get("id") as string
  await db
    .from("ui_pattern_failures")
    .update({ status: "ignored", updated_at: new Date().toISOString() })
    .eq("id", id)
  redirect("/dashboard/cerebro/ui-failures")
}

async function markResolved(formData: FormData) {
  "use server"
  const db = createAdminClient()
  const id = formData.get("id") as string
  const ver = (formData.get("resolved_in_version") as string)?.trim() || null
  await db
    .from("ui_pattern_failures")
    .update({
      status:              "resolved",
      resolved_in_version: ver,
      updated_at:          new Date().toISOString(),
    })
    .eq("id", id)
  redirect("/dashboard/cerebro/ui-failures")
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function UIFailuresPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  await requireRole("admin")
  const sp = await searchParams
  const filter = sp.status ?? "pending"

  const db = createAdminClient()
  let q = db
    .from("ui_pattern_failures")
    .select("id, action, error, reason, url, ext_version, screenshot_path, dom_snippet, status, labeled_selector, labeled_notes, occurrence_count, resolved_in_version, created_at, account_id, related_lead_id, ai_diagnosis, ai_analyzed_at")
    .order("created_at", { ascending: false })
    .limit(50)

  if (filter !== "all") q = q.eq("status", filter)
  const { data: rows } = await q

  // Sign URLs (1h expiry) para screenshots
  const signed: Record<string, string> = {}
  for (const r of rows ?? []) {
    if (r.screenshot_path) {
      const { data } = await db.storage
        .from("ui-failures")
        .createSignedUrl(r.screenshot_path, 3600)
      if (data?.signedUrl) signed[r.id] = data.signedUrl
    }
  }

  // Pull lead names + account labels para mostrar contexto
  const leadIds = [...new Set((rows ?? []).map(r => r.related_lead_id).filter(Boolean))] as string[]
  const accIds  = [...new Set((rows ?? []).map(r => r.account_id).filter(Boolean))] as string[]
  const [{ data: leads }, { data: accounts }] = await Promise.all([
    leadIds.length ? db.from("leads").select("id, full_name").in("id", leadIds) : Promise.resolve({ data: [] }),
    accIds.length  ? db.from("linkedin_accounts").select("id, label").in("id", accIds) : Promise.resolve({ data: [] }),
  ])
  const leadMap = new Map((leads ?? []).map(l => [l.id, l.full_name]))
  const accMap  = new Map((accounts ?? []).map(a => [a.id, a.label]))

  // Stats por status
  const { data: stats } = await db
    .from("ui_pattern_failures")
    .select("status")
  const counts: Record<string, number> = { pending: 0, labeled: 0, resolved: 0, ignored: 0, all: stats?.length ?? 0 }
  for (const s of stats ?? []) counts[s.status] = (counts[s.status] ?? 0) + 1

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">UI Pattern Failures</h1>
          <p className="text-sm text-gray-500 mt-1">
            Capturas de fallos de selectores DOM. Etiqueta el selector correcto para construir dataset de auto-healing.
          </p>
        </div>
        <Link href="/dashboard/cerebro" className="text-sm text-blue-600 hover:underline">← Cerebro</Link>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-6 text-sm">
        {(["pending", "labeled", "resolved", "ignored", "all"] as const).map(s => (
          <Link
            key={s}
            href={`/dashboard/cerebro/ui-failures?status=${s}`}
            className={`px-3 py-1.5 rounded-md border ${filter === s ? "bg-blue-600 text-white border-blue-600" : "bg-white border-gray-300 hover:bg-gray-50"}`}
          >
            {s} ({counts[s] ?? 0})
          </Link>
        ))}
      </div>

      {(!rows || rows.length === 0) && (
        <div className="bg-white rounded-lg border p-12 text-center text-gray-500">
          Sin fallos en status <strong>{filter}</strong>.
        </div>
      )}

      <div className="space-y-6">
        {(rows ?? []).map(r => {
          const leadName = r.related_lead_id ? leadMap.get(r.related_lead_id) : null
          const accLabel = r.account_id ? accMap.get(r.account_id) : null
          const screenshotUrl = signed[r.id]
          const ai = (r.ai_diagnosis ?? null) as null | {
            source?: "human_label" | "heuristic" | "gemini_vision"
            element_visible?: boolean
            location_description?: string
            likely_cause?: string
            suggested_css_selector?: string | null
            page_state?: string
            confidence?: number
            recommendation?: string
            raw?: string
            parse_error?: boolean
            error?: string
          }
          const aiSourceMeta: Record<string, { label: string; cls: string }> = {
            human_label:   { label: "👤 Etiqueta humana", cls: "bg-blue-200 text-blue-900" },
            heuristic:     { label: "⚙️ Heurística (código · $0)", cls: "bg-green-200 text-green-900" },
            gemini_vision: { label: "🖼️ Gemini Vision", cls: "bg-purple-200 text-purple-900" },
          }
          const srcMeta = ai?.source ? aiSourceMeta[ai.source] : null
          return (
            <div key={r.id} className="bg-white rounded-lg border shadow-sm overflow-hidden">
              <div className="p-4 border-b bg-gray-50 flex items-start justify-between">
                <div>
                  <div className="font-mono text-sm font-bold">
                    {r.action} → {r.error}
                    {r.reason && <span className="text-gray-500 text-xs ml-2">({r.reason})</span>}
                  </div>
                  <div className="text-xs text-gray-600 mt-1">
                    {accLabel && <span className="mr-3">cuenta: <strong>{accLabel}</strong></span>}
                    {leadName && <span className="mr-3">lead: <strong>{leadName}</strong></span>}
                    {r.ext_version && <span className="mr-3">v{r.ext_version}</span>}
                    {r.occurrence_count > 1 && <span className="text-orange-600 font-bold">×{r.occurrence_count}</span>}
                  </div>
                  {r.url && (
                    <div className="text-xs text-gray-500 mt-1 font-mono truncate max-w-2xl" title={r.url}>
                      {r.url}
                    </div>
                  )}
                </div>
                <span className="text-xs text-gray-400 whitespace-nowrap ml-4">
                  {new Date(r.created_at).toLocaleString("es-MX", { timeZone: "America/Mexico_City" })}
                </span>
              </div>

              {/* 🧠 Cerebro AI Vision — diagnóstico automático del screenshot */}
              {ai && (
                <div className="mx-4 mt-4 rounded-lg border border-purple-200 bg-purple-50 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs font-bold text-purple-800 flex items-center gap-1.5 flex-wrap">
                      🧠 Cerebro AI
                      {srcMeta && (
                        <span className={`px-1.5 py-0.5 rounded font-semibold ${srcMeta.cls}`}>
                          {srcMeta.label}
                        </span>
                      )}
                      {typeof ai.confidence === "number" && (
                        <span className="px-1.5 py-0.5 rounded bg-purple-200 text-purple-900 font-mono">
                          conf {Math.round(ai.confidence * 100)}%
                        </span>
                      )}
                    </div>
                    {r.ai_analyzed_at && (
                      <span className="text-[10px] text-purple-500">
                        {new Date(r.ai_analyzed_at).toLocaleString("es-MX", { timeZone: "America/Mexico_City" })}
                      </span>
                    )}
                  </div>

                  {ai.error ? (
                    <div className="text-xs text-red-600">Error analizando: {ai.error}</div>
                  ) : ai.parse_error ? (
                    <pre className="text-[10px] bg-white p-2 rounded border overflow-auto max-h-40 whitespace-pre-wrap">{ai.raw}</pre>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                      <div>
                        <span className="font-semibold text-purple-700">Elemento visible:</span>{" "}
                        {ai.element_visible === true ? (
                          <span className="text-green-700 font-semibold">Sí ✓</span>
                        ) : ai.element_visible === false ? (
                          <span className="text-red-700 font-semibold">No ✗</span>
                        ) : "—"}
                      </div>
                      <div>
                        <span className="font-semibold text-purple-700">Estado página:</span>{" "}
                        <code className="bg-white px-1 rounded">{ai.page_state ?? "—"}</code>
                      </div>
                      {ai.location_description && (
                        <div className="sm:col-span-2">
                          <span className="font-semibold text-purple-700">Ubicación:</span>{" "}
                          <span className="text-gray-700">{ai.location_description}</span>
                        </div>
                      )}
                      {ai.likely_cause && (
                        <div className="sm:col-span-2">
                          <span className="font-semibold text-purple-700">Causa probable:</span>{" "}
                          <span className="text-gray-700">{ai.likely_cause}</span>
                        </div>
                      )}
                      {ai.suggested_css_selector && (
                        <div className="sm:col-span-2">
                          <span className="font-semibold text-purple-700">Selector sugerido:</span>{" "}
                          <code className="bg-white px-1 py-0.5 rounded text-[11px] break-all">{ai.suggested_css_selector}</code>
                        </div>
                      )}
                      {ai.recommendation && (
                        <div className="sm:col-span-2 mt-1 p-2 bg-white rounded border border-purple-100">
                          <span className="font-semibold text-purple-700">💡 Recomendación:</span>{" "}
                          <span className="text-gray-800">{ai.recommendation}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
                {/* Screenshot */}
                <div>
                  <div className="text-xs font-semibold text-gray-600 mb-2">Screenshot</div>
                  {screenshotUrl ? (
                    <a href={screenshotUrl} target="_blank" rel="noopener noreferrer">
                      <img
                        src={screenshotUrl}
                        alt="screenshot"
                        className="border rounded max-w-full h-auto hover:opacity-80 transition"
                      />
                    </a>
                  ) : (
                    <div className="text-sm text-gray-400 italic">Sin screenshot</div>
                  )}
                </div>

                {/* DOM dump + form */}
                <div>
                  <div className="text-xs font-semibold text-gray-600 mb-2">DOM snippet</div>
                  <details className="mb-4">
                    <summary className="text-xs text-blue-600 cursor-pointer hover:underline">Ver JSON</summary>
                    <pre className="text-[10px] bg-gray-50 p-2 rounded mt-2 overflow-auto max-h-64 border">
                      {JSON.stringify(r.dom_snippet, null, 2)}
                    </pre>
                  </details>

                  {r.status === "pending" && (
                    <form action={labelFailure} className="space-y-2">
                      <input type="hidden" name="id" value={r.id} />
                      <div>
                        <label className="text-xs font-semibold text-gray-700">Selector correcto (CSS o XPath)</label>
                        <input
                          name="labeled_selector"
                          placeholder='.msg-form__send-btn   |   button[aria-label="Enviar"]'
                          className="mt-1 w-full text-xs px-2 py-1 border rounded font-mono"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-gray-700">Notas (opcional)</label>
                        <textarea
                          name="labeled_notes"
                          rows={2}
                          placeholder="Ej: en compose page Premium el send button está dentro de .msg-compose-form, no .msg-form"
                          className="mt-1 w-full text-xs px-2 py-1 border rounded"
                        />
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          className="px-3 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded hover:bg-blue-700"
                        >
                          ✓ Etiquetar
                        </button>
                        <button
                          type="submit"
                          formAction={ignoreFailure}
                          className="px-3 py-1.5 bg-gray-200 text-gray-700 text-xs font-semibold rounded hover:bg-gray-300"
                        >
                          Ignorar
                        </button>
                      </div>
                    </form>
                  )}

                  {r.status === "labeled" && (
                    <div className="space-y-2 text-xs">
                      <div>
                        <span className="font-semibold text-gray-700">Selector:</span>{" "}
                        <code className="bg-yellow-50 px-1 py-0.5 rounded">{r.labeled_selector || "—"}</code>
                      </div>
                      {r.labeled_notes && (
                        <div>
                          <span className="font-semibold text-gray-700">Notas:</span>{" "}
                          <span className="text-gray-600">{r.labeled_notes}</span>
                        </div>
                      )}
                      <form action={markResolved} className="flex items-center gap-2 mt-3">
                        <input type="hidden" name="id" value={r.id} />
                        <input
                          name="resolved_in_version"
                          placeholder="Versión que lo resolvió (ej: 0.6.18)"
                          className="flex-1 text-xs px-2 py-1 border rounded"
                        />
                        <button
                          type="submit"
                          className="px-3 py-1.5 bg-green-600 text-white text-xs font-semibold rounded hover:bg-green-700"
                        >
                          Marcar resuelto
                        </button>
                      </form>
                    </div>
                  )}

                  {r.status === "resolved" && (
                    <div className="text-xs text-green-700">
                      ✓ Resuelto en versión {r.resolved_in_version ?? "(sin especificar)"}
                    </div>
                  )}

                  {r.status === "ignored" && (
                    <div className="text-xs text-gray-500 italic">Marcado como ignorado.</div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
