import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { redirect, notFound } from "next/navigation"

// ── Server Actions ─────────────────────────────────────────────────────────────

async function saveCampaign(formData: FormData) {
  "use server"
  const supabase = createAdminClient()
  const id = formData.get("campaign_id") as string

  // Parse array fields (comma-separated)
  const parseList = (key: string): string[] =>
    (formData.get(key) as string || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)

  const accountId = (formData.get("linkedin_account_id") as string) || undefined

  await supabase.from("campaigns").update({
    name:                 formData.get("name") as string,
    target_audience:      (formData.get("target_audience") as string) || undefined,
    gemini_system_prompt: (formData.get("gemini_system_prompt") as string) || undefined,
    is_active:            formData.get("is_active") === "true",
    linkedin_account_id:  accountId,
    search_keywords:      parseList("search_keywords"),
    search_location:      formData.get("search_location") as string || null,
    search_count:         Number(formData.get("search_count") || 25),
    title_whitelist:      parseList("title_whitelist"),
    title_blacklist:      parseList("title_blacklist"),
  }).eq("id", id)

  redirect("/dashboard/campaigns")
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function CampaignEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data: c } = await supabase
    .from("campaigns")
    .select("*, linkedin_accounts(id, label, linkedin_profile_url)")
    .eq("id", id)
    .single()

  if (!c) notFound()

  const { data: accounts } = await supabase
    .from("linkedin_accounts")
    .select("id, label, linkedin_profile_url, status")
    .order("label")

  const toComma = (arr: string[] | null) => (arr ?? []).join(", ")

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Editar campaña</h1>
        <p className="text-gray-400 text-sm mt-0.5">{c.name}</p>
      </div>

      <form action={saveCampaign} className="space-y-8">
        <input type="hidden" name="campaign_id" value={c.id} />

        {/* ── General ─────────────────────────────────────────────── */}
        <Section title="General">
          <Field label="Nombre *">
            <input name="name" required defaultValue={c.name}
              className={input} />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Estado">
              <select name="is_active" defaultValue={String(c.is_active)} className={input}>
                <option value="true">Activa</option>
                <option value="false">Inactiva</option>
              </select>
            </Field>
            <Field label="Cuenta LinkedIn">
              <select name="linkedin_account_id" defaultValue={c.linkedin_account_id ?? ""} className={input}>
                <option value="">Sin cuenta</option>
                {(accounts ?? []).map(a => (
                  <option key={a.id} value={a.id}>
                    {a.label ?? a.linkedin_profile_url?.replace("https://www.linkedin.com/in/", "@") ?? a.id}
                    {a.status !== "active" ? ` (${a.status})` : ""}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Audiencia objetivo" hint="Descripción para Gemini de a quién va dirigida esta campaña">
            <textarea name="target_audience" rows={2} defaultValue={c.target_audience ?? ""}
              placeholder="Ej: Directores de Finanzas de empresas medianas en México" className={input} />
          </Field>

          <Field label="System prompt (mensaje IA)" hint="Instrucciones para Gemini al generar el mensaje de conexión">
            <textarea name="gemini_system_prompt" rows={4} defaultValue={c.gemini_system_prompt ?? ""}
              placeholder="Eres un consultor de negocios B2B..." className={input} />
          </Field>
        </Section>

        {/* ── Búsqueda ────────────────────────────────────────────── */}
        <Section title="Búsqueda en LinkedIn">
          <Field label="Keywords de búsqueda" hint="Separadas por coma. La primera se usa como query principal.">
            <input name="search_keywords" defaultValue={toComma(c.search_keywords)}
              placeholder="Director Finanzas, CFO, VP Finance" className={input} />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Ubicación" hint="Ej: Mexico City, Mexico">
              <input name="search_location" defaultValue={c.search_location ?? ""}
                placeholder="Mexico" className={input} />
            </Field>
            <Field label="Máx. leads por búsqueda">
              <input name="search_count" type="number" min="5" max="200"
                defaultValue={c.search_count ?? 25} className={input} />
            </Field>
          </div>
        </Section>

        {/* ── Targeting de puestos ────────────────────────────────── */}
        <Section title="Targeting de puestos" description="Filtra perfiles por su headline de LinkedIn antes de guardarlos como leads.">
          <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 text-xs text-blue-300 space-y-1">
            <p><span className="font-semibold">Whitelist</span> — Si tiene valores, <em>solo</em> se scrappean perfiles cuyo headline contenga al menos uno. Si está vacío, no filtra.</p>
            <p><span className="font-semibold">Blacklist</span> — Perfiles cuyo headline contenga alguno de estos términos se descartan siempre.</p>
            <p className="text-blue-400/60">La comparación es case-insensitive y busca substring (ej. "director" matchea "Director Comercial").</p>
          </div>

          <Field
            label="✅ Whitelist — Puestos que SÍ queremos"
            hint="Separados por coma. Vacío = no filtrar."
          >
            <input
              name="title_whitelist"
              defaultValue={toComma(c.title_whitelist)}
              placeholder="Director, CEO, CFO, VP, Gerente General, Chief"
              className={input}
            />
            <TagPreview value={toComma(c.title_whitelist)} color="green" />
          </Field>

          <Field
            label="🚫 Blacklist — Puestos que NO queremos"
            hint="Separados por coma."
          >
            <input
              name="title_blacklist"
              defaultValue={toComma(c.title_blacklist)}
              placeholder="Estudiante, Intern, Pasante, Assistant, Junior, Trainee"
              className={input}
            />
            <TagPreview value={toComma(c.title_blacklist)} color="red" />
          </Field>
        </Section>

        {/* ── Actions ─────────────────────────────────────────────── */}
        <div className="flex gap-3 pt-2">
          <button type="submit"
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm rounded-lg transition-colors">
            Guardar cambios
          </button>
          <a href="/dashboard/campaigns"
            className="px-6 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium text-sm rounded-lg transition-colors">
            Cancelar
          </a>
        </div>
      </form>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

const input = "w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"

function Section({ title, description, children }: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
      <div>
        <h2 className="text-white font-semibold">{title}</h2>
        {description && <p className="text-gray-500 text-xs mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  )
}

function Field({ label, hint, children }: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs text-gray-400 font-medium">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-600">{hint}</p>}
    </div>
  )
}

function TagPreview({ value, color }: { value: string; color: "green" | "red" }) {
  const tags = value.split(",").map(s => s.trim()).filter(Boolean)
  if (!tags.length) return null
  const cls = color === "green"
    ? "bg-green-500/10 text-green-400 border-green-500/30"
    : "bg-red-500/10 text-red-400 border-red-500/30"
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {tags.map(t => (
        <span key={t} className={`text-xs px-2 py-0.5 rounded-full border ${cls}`}>{t}</span>
      ))}
    </div>
  )
}
