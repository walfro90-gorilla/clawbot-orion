import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/auth/role"
import { redirect } from "next/navigation"

// ── Server Action ──────────────────────────────────────────────────────────────

async function createCampaign(formData: FormData) {
  "use server"
  const admin = createAdminClient()

  const parseList = (key: string): string[] =>
    (formData.get(key) as string || "")
      .split(",").map(s => s.trim()).filter(Boolean)

  const { data: campaign, error } = await admin.from("campaigns").insert({
    name:                  formData.get("name") as string,
    target_audience:       (formData.get("target_audience") as string) || null,
    gemini_system_prompt:  (formData.get("gemini_system_prompt") as string) || "",
    is_active:             formData.get("is_active") === "true",
    linkedin_account_id:   (formData.get("linkedin_account_id") as string) || null,
    search_keywords:       parseList("search_keywords"),
    search_location:       (formData.get("search_location") as string) || null,
    search_count:          Number(formData.get("search_count") || 25),
    title_whitelist:       parseList("title_whitelist"),
    title_blacklist:       parseList("title_blacklist"),
    batch_paused:          false,
    search_paused:         false,
    daily_invite_target:   Number(formData.get("daily_invite_target") || 8),
    min_batch_gap_min:     Number(formData.get("min_batch_gap_min") || 120),
    min_pending_threshold: Number(formData.get("min_pending_threshold") || 15),
    schedule_start_hour:   Number(formData.get("schedule_start_hour") || 9),
    schedule_end_hour:     Number(formData.get("schedule_end_hour") || 19),
    search_gap_hours:      Number(formData.get("search_gap_hours") || 20),
  }).select("id").single()

  if (error || !campaign) {
    console.error("Create campaign error:", error?.message)
    return
  }

  // ── Create message template
  await admin.from("message_templates").insert({
    campaign_id:         campaign.id,
    name:                (formData.get("template_name") as string) || "Template principal",
    tone:                (formData.get("tone") as string) || "casual",
    language:            (formData.get("language") as string) || "es",
    max_chars:           Number(formData.get("max_chars") || 150),
    qualification_rules: (formData.get("qualification_rules") as string) || null,
    message_rules:       (formData.get("message_rules") as string) || null,
    opening_hint:        (formData.get("opening_hint") as string) || null,
    example_good:        (formData.get("example_good") as string) || null,
    example_bad:         (formData.get("example_bad") as string) || null,
    is_active:           true,
  })

  redirect("/dashboard/campaigns")
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function NewCampaignPage() {
  const admin = createAdminClient()
  const me = await getSessionUser()

  const { data: accounts } = await admin
    .from("linkedin_accounts")
    .select("id, label, linkedin_profile_url, status")
    .order("label")

  // For restricted users pre-select their linked account
  const defaultAccount = (me?.role === "user" || me?.role === "viewer")
    ? me?.linkedin_account_id ?? ""
    : ""

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Nueva campaña</h1>
        <p className="text-gray-400 text-sm mt-0.5">Configura todos los parámetros de la campaña y el template de mensaje IA.</p>
      </div>

      <form action={createCampaign} className="space-y-6">

        {/* ── GENERAL ─────────────────────────────────────────────────── */}
        <Section title="General" icon="⚙️">
          <Field label="Nombre *">
            <input name="name" required placeholder="Ej: Directores Finanzas LATAM Q2" className={inp} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Estado">
              <select name="is_active" defaultValue="true" className={inp}>
                <option value="true">Activa</option>
                <option value="false">Inactiva</option>
              </select>
            </Field>
            <Field label="Cuenta LinkedIn *">
              <select name="linkedin_account_id" defaultValue={defaultAccount} className={inp}>
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
          <Field label="Audiencia objetivo" hint="Descripción breve para Gemini de a quién va dirigida esta campaña.">
            <textarea name="target_audience" rows={2}
              placeholder="Ej: Directores de Finanzas de empresas medianas en México" className={inp} />
          </Field>
        </Section>

        {/* ── SCHEDULER ───────────────────────────────────────────────── */}
        <Section title="Scheduler" icon="🕐" description="Controla cuándo y con qué cadencia se envían invitaciones y se buscan leads.">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <Field label="Invitaciones / día" hint="Límite diario de invites por campaña.">
              <input name="daily_invite_target" type="number" min="1" max="20" defaultValue={8} className={inp} />
            </Field>
            <Field label="Gap entre batches (min)" hint="Mínimo de minutos entre un batch y el siguiente.">
              <input name="min_batch_gap_min" type="number" min="30" max="480" defaultValue={120} className={inp} />
            </Field>
            <Field label="Umbral mínimo en cola" hint="Si hay menos leads que este umbral, se dispara un nuevo search.">
              <input name="min_pending_threshold" type="number" min="5" max="100" defaultValue={15} className={inp} />
            </Field>
            <Field label="Hora de inicio (24h)" hint="Hora local México a partir de la cual el scheduler se activa.">
              <input name="schedule_start_hour" type="number" min="0" max="23" defaultValue={9} className={inp} />
            </Field>
            <Field label="Hora de fin (24h)" hint="Hora local México a partir de la cual el scheduler se detiene.">
              <input name="schedule_end_hour" type="number" min="0" max="23" defaultValue={19} className={inp} />
            </Field>
            <Field label="Gap entre búsquedas (horas)" hint="Horas mínimas entre un search y el siguiente.">
              <input name="search_gap_hours" type="number" min="1" max="168" defaultValue={20} className={inp} />
            </Field>
          </div>
        </Section>

        {/* ── BÚSQUEDA ────────────────────────────────────────────────── */}
        <Section title="Búsqueda en LinkedIn" icon="🔍" description="Parámetros para el scraper de perfiles.">
          <Field label="Keywords de búsqueda" hint="Separadas por coma. La primera se usa como query principal en LinkedIn.">
            <input name="search_keywords" placeholder="Director Finanzas, CFO, VP Finance" className={inp} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Ubicación" hint="Ej: Mexico City, Mexico">
              <input name="search_location" placeholder="Mexico" className={inp} />
            </Field>
            <Field label="Máx. leads por búsqueda">
              <input name="search_count" type="number" min="5" max="200" defaultValue={25} className={inp} />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="✅ Whitelist — Cargos que SÍ queremos"
              hint="Vacío = no filtrar. Busca substring en el headline.">
              <input name="title_whitelist"
                placeholder="Director, CEO, CFO, VP, Gerente General" className={inp} />
            </Field>
            <Field label="🚫 Blacklist — Cargos que NO queremos"
              hint="Se descartan si el headline contiene alguno.">
              <input name="title_blacklist"
                placeholder="Estudiante, Intern, Pasante, Junior" className={inp} />
            </Field>
          </div>
        </Section>

        {/* ── TEMPLATE DE MENSAJE IA ──────────────────────────────────── */}
        <Section title="Template de mensaje IA" icon="🤖"
          description="Instrucciones que recibe Gemini para calificar leads y generar el mensaje de conexión personalizado.">

          <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 text-xs text-blue-300 space-y-1.5">
            <p>Gemini recibe el perfil del lead (<code className="bg-blue-500/10 px-1 rounded">nombre, headline, about, headlineCompany</code>) junto con estas reglas para generar el mensaje.</p>
            <p><code className="bg-blue-500/10 px-1 rounded">headlineCompany</code> = empresa extraída del headline por regex. Úsala para personalizar — nunca uses el cargo como nombre de empresa.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Field label="Nombre del template">
              <input name="template_name" defaultValue="Template principal" className={inp} />
            </Field>
            <Field label="Tono">
              <select name="tone" defaultValue="casual" className={inp}>
                <option value="casual">Casual</option>
                <option value="formal">Formal</option>
                <option value="friendly">Amigable</option>
                <option value="direct">Directo</option>
              </select>
            </Field>
            <Field label="Idioma">
              <select name="language" defaultValue="es" className={inp}>
                <option value="es">Español</option>
                <option value="en">Inglés</option>
                <option value="pt">Portugués</option>
              </select>
            </Field>
          </div>

          <Field label="Límite de caracteres" hint="LinkedIn permite máx. 300 caracteres en notas de invitación. Recomendado: 150.">
            <input name="max_chars" type="number" min="50" max="300" defaultValue={150} className={inp} />
          </Field>

          <Field label="Reglas de calificación"
            hint="Cuándo descalificar un lead. Gemini devuelve qualified: false si se cumple alguna condición.">
            <textarea name="qualification_rules" rows={3}
              placeholder="Descalifica SOLO si: perfil memorial, persona fallecida, cuenta bot/empresa disfrazada, o los tres campos headline+about+currentPosition son null simultáneamente."
              className={inp} />
          </Field>

          <Field label="Reglas de mensaje"
            hint="Instrucciones de personalización. Usa headlineCompany para mencionar la empresa del lead.">
            <textarea name="message_rules" rows={5}
              placeholder={`Redacta UN mensaje de conexión en español. Prioridad:
1. Si hay headlineCompany: menciona algo específico de la empresa.
2. Tono casual, sin lenguaje corporativo.
3. Termina con una pregunta corta y abierta.
LÍMITE ABSOLUTO: 150 caracteres — cuenta uno por uno, recorta si supera.
NUNCA uses el cargo/título como si fuera el nombre de una empresa.`}
              className={inp} />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Hint de apertura"
              hint="Cómo debe empezar el mensaje.">
              <textarea name="opening_hint" rows={2}
                placeholder="Empieza con su nombre de pila. Menciona su empresa o rol en la primera oración."
                className={inp} />
            </Field>
            <Field label="System prompt adicional"
              hint="Contexto del emisor del mensaje.">
              <textarea name="gemini_system_prompt" rows={2}
                placeholder="Eres un consultor de negocios B2B especializado en..."
                className={inp} />
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="✅ Ejemplo BUENO" hint="Gemini lo usa como referencia del tono ideal.">
              <textarea name="example_good" rows={3}
                placeholder="Hola Santiago, veo tu trabajo en Villacero. ¿Qué es lo más desafiante en finanzas ahora?"
                className={inp} />
            </Field>
            <Field label="🚫 Ejemplo MALO" hint="Qué debe evitar Gemini.">
              <textarea name="example_bad" rows={3}
                placeholder="Espero que estés bien. Me gustaría conectar contigo para explorar sinergias profesionales."
                className={inp} />
            </Field>
          </div>
        </Section>

        {/* ── ACTIONS ─────────────────────────────────────────────────── */}
        <div className="flex gap-3 pt-2">
          <button type="submit"
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm rounded-lg transition-colors">
            Crear campaña
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

// ── Sub-components ──────────────────────────────────────────────────────────────

const inp = "w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"

function Section({ title, icon, description, children }: {
  title: string; icon?: string; description?: string; children: React.ReactNode
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
      <div>
        <h2 className="text-white font-semibold">{icon && <span className="mr-2">{icon}</span>}{title}</h2>
        {description && <p className="text-gray-500 text-xs mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-xs text-gray-400 font-medium">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-600">{hint}</p>}
    </div>
  )
}
