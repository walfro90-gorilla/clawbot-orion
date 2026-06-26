import { createAdminClient } from "@/lib/supabase/admin"
import { requireRole } from "@/lib/auth/role"
import { revalidatePath } from "next/cache"
import Link from "next/link"

// ── Server Actions ─────────────────────────────────────────────────────────────

// Crea una post-campaña + su "shadow campaign" (campaña oculta is_shadow=true que
// el motor de FU/auto-reply procesa para los leads graduados). search/batch quedan
// pausados en el shadow: solo corre follow-ups + auto-reply. La config fina se edita
// luego en /dashboard/posts/campaigns/[id]/edit.
async function createPostCampaign(formData: FormData): Promise<void> {
  "use server"
  const admin = createAdminClient() as any
  const name = (formData.get("name") as string)?.trim()
  const accountId = (formData.get("linkedin_account_id") as string) || null
  if (!name || !accountId) return

  const { data: shadow, error: sErr } = await admin.from("campaigns").insert({
    name: `[Post] ${name}`,
    is_active: true,
    is_shadow: true,
    linkedin_account_id: accountId,
    gemini_system_prompt: "Eres un profesional cálido y genuino que da seguimiento en LinkedIn en español.",
    search_paused: true,
    batch_paused: true,
    follow_up_paused: false,
    auto_reply_mode: "manual",
  }).select("id").single()
  if (sErr) { console.error(`[createPostCampaign] shadow campaign failed: ${sErr.message}`); return }

  const { error: pErr } = await admin.from("post_campaigns").insert({
    name,
    linkedin_account_id: accountId,
    shadow_campaign_id: shadow.id,
    is_active: false, // arranca apagada hasta configurarla
    post_keywords: [],
  })
  if (pErr) console.error(`[createPostCampaign] post_campaign failed: ${pErr.message}`)
  revalidatePath("/dashboard/posts")
}

// Aprueba: guarda el comentario (editado o no) y pasa a 'approved'. El scheduler
// (tryPostCommentsForCampaign) lo despacha luego: publica el comentario + conecta.
async function approveOpportunity(formData: FormData): Promise<void> {
  "use server"
  const admin = createAdminClient() as any
  const id = formData.get("opportunity_id") as string
  const edited = ((formData.get("edited_comment") as string) || "").trim()
  if (!id) return
  await admin.from("post_opportunities").update({
    status: "approved",
    edited_comment: edited || null,
    approved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", id).eq("status", "pending_review")
  revalidatePath("/dashboard/posts")
}

async function rejectOpportunity(formData: FormData): Promise<void> {
  "use server"
  const admin = createAdminClient() as any
  const id = formData.get("opportunity_id") as string
  if (!id) return
  await admin.from("post_opportunities").update({
    status: "rejected",
    rejected_reason: "manual_reject",
    updated_at: new Date().toISOString(),
  }).eq("id", id).eq("status", "pending_review")
  revalidatePath("/dashboard/posts")
}

// ── Page ────────────────────────────────────────────────────────────────────────

export default async function PostsPage() {
  await requireRole("admin")
  const admin = createAdminClient() as any

  const [{ data: campaigns }, { data: accounts }, { data: opps }] = await Promise.all([
    admin.from("post_campaigns")
      .select("id, name, is_active, post_keywords, daily_comment_target, linkedin_accounts(label)")
      .order("created_at", { ascending: false }),
    admin.from("linkedin_accounts").select("id, label").order("label"),
    admin.from("post_opportunities")
      .select("id, post_text, post_permalink, author_name, author_headline, qualify_score, qualify_reason, draft_comment, created_at, post_campaigns(name)")
      .eq("status", "pending_review")
      .order("created_at", { ascending: true })
      .limit(50),
  ])

  const inp = "w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
  const reviewQueue = (opps ?? []) as any[]
  const postCampaigns = (campaigns ?? []) as any[]

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-8">
      <header>
        <h1 className="text-xl font-bold text-gray-50 flex items-center gap-2">📝 Post-Prospecting</h1>
        <p className="text-sm text-gray-400 mt-1">
          Busca posts donde alguien pide un servicio, comenta aportando valor, y conecta. El comentario
          es público (value-first, sin venta); el pitch va en la nota privada de conexión.
        </p>
      </header>

      {/* ── Post-campañas ───────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-200">Campañas de posts</h2>
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900/60 text-gray-400 text-xs">
              <tr>
                <th className="text-left px-3 py-2">Nombre</th>
                <th className="text-left px-3 py-2">Cuenta</th>
                <th className="text-left px-3 py-2">Keywords</th>
                <th className="text-left px-3 py-2">Cap/día</th>
                <th className="text-left px-3 py-2">Estado</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {postCampaigns.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-4 text-gray-500 text-center">Sin campañas de posts todavía.</td></tr>
              )}
              {postCampaigns.map((c) => (
                <tr key={c.id} className="hover:bg-gray-900/40">
                  <td className="px-3 py-2 text-gray-100">{c.name}</td>
                  <td className="px-3 py-2 text-gray-400">{c.linkedin_accounts?.label ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-500">{(c.post_keywords ?? []).length}</td>
                  <td className="px-3 py-2 text-gray-500">{c.daily_comment_target ?? 5}</td>
                  <td className="px-3 py-2">
                    {c.is_active
                      ? <span className="text-green-400 text-xs">● Activa</span>
                      : <span className="text-gray-500 text-xs">○ Inactiva</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link href={`/dashboard/posts/campaigns/${c.id}/edit`} className="text-blue-400 hover:text-blue-300 text-xs">Configurar →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Crear nueva post-campaña */}
        <form action={createPostCampaign} className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-end bg-gray-900/40 border border-gray-800 rounded-lg p-3">
          <div className="flex-1">
            <label className="text-[11px] text-gray-500">Nombre de la campaña</label>
            <input name="name" required placeholder="Ej. SaaS / Fullstack devs" className={inp} />
          </div>
          <div className="flex-1">
            <label className="text-[11px] text-gray-500">Cuenta LinkedIn</label>
            <select name="linkedin_account_id" required className={inp}>
              <option value="">Selecciona…</option>
              {(accounts ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </div>
          <button type="submit" className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-white text-sm font-medium whitespace-nowrap">➕ Crear</button>
        </form>
      </section>

      {/* ── Cola de revisión ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-200">
          Cola de revisión
          <span className="ml-2 text-xs font-normal text-gray-500">{reviewQueue.length} comentario(s) por aprobar</span>
        </h2>
        <p className="text-[11px] text-gray-600">
          Revisa el comentario que redactó la IA. Al aprobar, se publica y de inmediato se envía la
          invitación con tu nota de pitch privada. Verifica el autor antes de aprobar.
        </p>

        {reviewQueue.length === 0 && (
          <div className="text-gray-500 text-sm bg-gray-900/40 border border-gray-800 rounded-lg p-6 text-center">
            Nada por revisar. Cuando el agente encuentre y califique posts, aparecerán aquí.
          </div>
        )}

        {reviewQueue.map((o) => (
          <form key={o.id} action={approveOpportunity} className="rounded-lg border border-gray-700 bg-gray-900/60 p-4 space-y-3">
            <input type="hidden" name="opportunity_id" value={o.id} />

            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-100 truncate">{o.author_name ?? "(autor desconocido)"}</p>
                {o.author_headline && <p className="text-xs text-gray-500 truncate">{o.author_headline}</p>}
                <p className="text-[11px] text-gray-600 mt-0.5">
                  {o.post_campaigns?.name ?? ""} · score {o.qualify_score ?? "?"}/10
                </p>
              </div>
              {o.post_permalink && (
                <a href={o.post_permalink} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-xs whitespace-nowrap">Ver post ↗</a>
              )}
            </div>

            {o.qualify_reason && (
              <p className="text-[11px] text-amber-300/80 bg-amber-900/10 border border-amber-900/30 rounded px-2 py-1">
                🧠 {o.qualify_reason}
              </p>
            )}

            <div>
              <label className="text-[11px] text-gray-500">Post del autor</label>
              <p className="text-xs text-gray-400 bg-gray-950/60 border border-gray-800 rounded p-2 max-h-28 overflow-y-auto whitespace-pre-wrap">{o.post_text}</p>
            </div>

            <div>
              <label className="text-[11px] text-gray-500">Comentario (editable, value-first — sin venta)</label>
              <textarea name="edited_comment" rows={3} defaultValue={o.draft_comment ?? ""} className={inp + " resize-none"} />
            </div>

            <div className="flex items-center gap-2 justify-end">
              <button type="submit" formAction={rejectOpportunity}
                className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-red-900/40 border border-gray-700 hover:border-red-700 rounded text-gray-300 hover:text-red-300">
                Rechazar
              </button>
              <button type="submit"
                className="px-4 py-1.5 text-xs font-semibold bg-green-600 hover:bg-green-500 rounded text-white">
                ✓ Aprobar → comentar + conectar
              </button>
            </div>
          </form>
        ))}
      </section>
    </div>
  )
}
