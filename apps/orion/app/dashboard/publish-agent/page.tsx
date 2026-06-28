import { createAdminClient } from "@/lib/supabase/admin"
import { requireRole } from "@/lib/auth/role"
import { revalidatePath } from "next/cache"
import Link from "next/link"
import { CopyTextButton } from "@/components/copy-text-button"

// ── Server Actions ───────────────────────────────────────────────────────────

async function createPublishAgent(formData: FormData): Promise<void> {
  "use server"
  const admin = createAdminClient() as any
  const name = (formData.get("name") as string)?.trim()
  const accountId = (formData.get("linkedin_account_id") as string) || null
  if (!name || !accountId) return
  await admin.from("publish_agents").insert({
    name,
    linkedin_account_id: accountId,
    is_active: false, // arranca apagado hasta configurar el contexto
  })
  revalidatePath("/dashboard/publish-agent")
}

// Aprueba: guarda el texto (editado o no) y pasa a 'approved' → listo para publicar.
async function approveGeneratedPost(formData: FormData): Promise<void> {
  "use server"
  const admin = createAdminClient() as any
  const id = formData.get("post_id") as string
  const edited = ((formData.get("edited_text") as string) || "").trim()
  if (!id) return
  await admin.from("generated_posts").update({
    status: "approved",
    edited_text: edited || null,
    approved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", id).eq("status", "pending_review")
  revalidatePath("/dashboard/publish-agent")
}

async function rejectGeneratedPost(formData: FormData): Promise<void> {
  "use server"
  const admin = createAdminClient() as any
  const id = formData.get("post_id") as string
  if (!id) return
  await admin.from("generated_posts").update({
    status: "rejected",
    reject_reason: "manual_reject",
    updated_at: new Date().toISOString(),
  }).eq("id", id).eq("status", "pending_review")
  revalidatePath("/dashboard/publish-agent")
}

// El admin publicó el post manualmente en LinkedIn (texto + imagen) → marcar publicado.
async function markPublished(formData: FormData): Promise<void> {
  "use server"
  const admin = createAdminClient() as any
  const id = formData.get("post_id") as string
  if (!id) return
  await admin.from("generated_posts").update({
    status: "published",
    published_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", id).eq("status", "approved")
  revalidatePath("/dashboard/publish-agent")
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function PublishAgentPage() {
  await requireRole("admin")
  const admin = createAdminClient() as any

  const [{ data: agents }, { data: accounts }, { data: pending }, { data: ready }] = await Promise.all([
    admin.from("publish_agents")
      .select("id, name, is_active, last_generated_at, linkedin_accounts(label)")
      .order("created_at", { ascending: false }),
    admin.from("linkedin_accounts").select("id, label").order("label"),
    admin.from("generated_posts")
      .select("id, draft_text, edited_text, image_url, image_prompt, source_news, created_at, publish_agents(name)")
      .eq("status", "pending_review")
      .order("created_at", { ascending: true })
      .limit(50),
    admin.from("generated_posts")
      .select("id, draft_text, edited_text, image_url, created_at, publish_agents(name)")
      .eq("status", "approved")
      .order("approved_at", { ascending: true })
      .limit(50),
  ])

  const inp = "w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
  const agentList = (agents ?? []) as any[]
  const reviewQueue = (pending ?? []) as any[]
  const readyQueue = (ready ?? []) as any[]

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-8">
      <header>
        <h1 className="text-xl font-bold text-gray-50 flex items-center gap-2">📣 Publicador diario</h1>
        <p className="text-sm text-gray-400 mt-1">
          El agente genera 1 borrador diario de post para tu perfil (sobre lo que ofreces). Tú lo
          revisas, editas y apruebas. Luego lo publicas: copias el texto (y adjuntas la imagen si la hay).
        </p>
      </header>

      {/* ── Agentes ──────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-200">Agentes de publicación</h2>
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900/60 text-gray-400 text-xs">
              <tr>
                <th className="text-left px-3 py-2">Nombre</th>
                <th className="text-left px-3 py-2">Cuenta</th>
                <th className="text-left px-3 py-2">Última generación</th>
                <th className="text-left px-3 py-2">Estado</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {agentList.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-4 text-gray-500 text-center">Sin agentes todavía. Crea uno abajo.</td></tr>
              )}
              {agentList.map((a) => (
                <tr key={a.id} className="hover:bg-gray-900/40">
                  <td className="px-3 py-2 text-gray-100">{a.name}</td>
                  <td className="px-3 py-2 text-gray-400">{a.linkedin_accounts?.label ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-500 text-xs">{a.last_generated_at ? new Date(a.last_generated_at).toLocaleString("es-MX") : "nunca"}</td>
                  <td className="px-3 py-2">
                    {a.is_active
                      ? <span className="text-green-400 text-xs">● Activo</span>
                      : <span className="text-gray-500 text-xs">○ Inactivo</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link href={`/dashboard/publish-agent/${a.id}/edit`} className="text-blue-400 hover:text-blue-300 text-xs">Configurar →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form action={createPublishAgent} className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-end bg-gray-900/40 border border-gray-800 rounded-lg p-3">
          <div className="flex-1">
            <label className="text-[11px] text-gray-500">Nombre del agente</label>
            <input name="name" required placeholder="Ej. Contenido SaaS / IA" className={inp} />
          </div>
          <div className="flex-1">
            <label className="text-[11px] text-gray-500">Cuenta LinkedIn (perfil donde publica)</label>
            <select name="linkedin_account_id" required className={inp}>
              <option value="">Selecciona…</option>
              {(accounts ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </div>
          <button type="submit" className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-white text-sm font-medium whitespace-nowrap">➕ Crear</button>
        </form>
      </section>

      {/* ── Por revisar ──────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-200">
          Por revisar
          <span className="ml-2 text-xs font-normal text-gray-500">{reviewQueue.length} borrador(es)</span>
        </h2>

        {reviewQueue.length === 0 && (
          <div className="text-gray-500 text-sm bg-gray-900/40 border border-gray-800 rounded-lg p-6 text-center">
            Nada por revisar. Cuando el agente genere el post del día, aparecerá aquí.
          </div>
        )}

        {reviewQueue.map((p) => (
          <form key={p.id} action={approveGeneratedPost} className="rounded-lg border border-gray-700 bg-gray-900/60 p-4 space-y-3">
            <input type="hidden" name="post_id" value={p.id} />
            <div className="flex items-start justify-between gap-3">
              <p className="text-[11px] text-gray-600">{p.publish_agents?.name ?? ""} · {new Date(p.created_at).toLocaleString("es-MX")}</p>
            </div>

            {p.image_url && (
              <img src={p.image_url} alt="imagen generada" className="max-h-56 rounded border border-gray-800" />
            )}

            <div>
              <label className="text-[11px] text-gray-500">Texto del post (editable)</label>
              <textarea name="edited_text" rows={8} defaultValue={p.edited_text ?? p.draft_text ?? ""} className={inp + " resize-y"} />
            </div>

            <div className="flex items-center gap-2 justify-end">
              <button type="submit" formAction={rejectGeneratedPost}
                className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-red-900/40 border border-gray-700 hover:border-red-700 rounded text-gray-300 hover:text-red-300">
                Rechazar
              </button>
              <button type="submit"
                className="px-4 py-1.5 text-xs font-semibold bg-green-600 hover:bg-green-500 rounded text-white">
                ✓ Aprobar
              </button>
            </div>
          </form>
        ))}
      </section>

      {/* ── Listos para publicar ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-200">
          Listos para publicar
          <span className="ml-2 text-xs font-normal text-gray-500">{readyQueue.length}</span>
        </h2>
        <p className="text-[11px] text-gray-600">
          Copia el texto y publícalo en tu LinkedIn (si hay imagen, descárgala y adjúntala). Luego marca como publicado.
        </p>

        {readyQueue.map((p) => {
          const text = p.edited_text ?? p.draft_text ?? ""
          return (
            <div key={p.id} className="rounded-lg border border-green-900/40 bg-green-950/10 p-4 space-y-3">
              <p className="text-[11px] text-gray-600">{p.publish_agents?.name ?? ""}</p>
              {p.image_url && (
                <div className="space-y-1">
                  <img src={p.image_url} alt="imagen" className="max-h-56 rounded border border-gray-800" />
                  <a href={p.image_url} download target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-xs">↓ Descargar imagen</a>
                </div>
              )}
              <p className="text-sm text-gray-200 bg-gray-950/60 border border-gray-800 rounded p-3 whitespace-pre-wrap">{text}</p>
              <div className="flex items-center gap-2 justify-end">
                <CopyTextButton text={text} />
                <a href="https://www.linkedin.com/feed/" target="_blank" rel="noopener noreferrer"
                  className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-200">Abrir LinkedIn ↗</a>
                <form action={markPublished}>
                  <input type="hidden" name="post_id" value={p.id} />
                  <button type="submit" className="px-4 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 rounded text-white">Marcar publicado</button>
                </form>
              </div>
            </div>
          )
        })}
      </section>
    </div>
  )
}
