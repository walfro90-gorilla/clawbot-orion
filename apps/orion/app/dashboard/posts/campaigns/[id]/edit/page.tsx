import { createAdminClient } from "@/lib/supabase/admin"
import { requireRole } from "@/lib/auth/role"
import { redirect, notFound } from "next/navigation"
import { FollowupSequenceEditor, type FollowupStep } from "@/components/followup-sequence-editor"

// ── Server Action ───────────────────────────────────────────────────────────────

async function savePostCampaign(formData: FormData): Promise<void> {
  "use server"
  const admin = createAdminClient() as any
  const id = formData.get("post_campaign_id") as string
  const shadowId = (formData.get("shadow_campaign_id") as string) || null
  if (!id) return

  const parseList = (key: string): string[] =>
    ((formData.get(key) as string) || "").split(/[,\n]/).map(s => s.trim()).filter(Boolean)

  const name = (formData.get("name") as string)?.trim() || "Post campaign"
  const geminiPrompt = (formData.get("gemini_system_prompt") as string) || null

  // ── post_campaigns
  const { error: pErr } = await admin.from("post_campaigns").update({
    name,
    is_active:             formData.get("is_active") === "true",
    post_search_paused:    formData.get("post_search_paused") === "true",
    post_keywords:         parseList("post_keywords"),
    post_recency:          (formData.get("post_recency") as string) || "past-week",
    service_description:   (formData.get("service_description") as string) || null,
    comment_rules:         (formData.get("comment_rules") as string) || null,
    pitch_note:            (formData.get("pitch_note") as string) || null,
    gemini_system_prompt:  geminiPrompt,
    qualify_min_score:     Number(formData.get("qualify_min_score") || 6),
    daily_comment_target:  Number(formData.get("daily_comment_target") || 5),
    min_comment_gap_min:   Number(formData.get("min_comment_gap_min") || 0),
    search_gap_hours:      Number(formData.get("search_gap_hours") || 12),
    min_pending_threshold: Number(formData.get("min_pending_threshold") || 8),
    schedule_start_hour:   Number(formData.get("schedule_start_hour") || 9),
    schedule_end_hour:     Number(formData.get("schedule_end_hour") || 19),
    schedule_days:         formData.getAll("schedule_days").length
      ? formData.getAll("schedule_days") as string[]
      : ["lunes","martes","miércoles","jueves","viernes"],
    updated_at:            new Date().toISOString(),
  }).eq("id", id)
  if (pErr) console.error(`[savePostCampaign] post_campaigns failed: ${pErr.message}`)

  // ── shadow campaign: voz/persona del FU + auto-reply + mantener activa/oculta
  if (shadowId) {
    const { error: sErr } = await admin.from("campaigns").update({
      name: `[Post] ${name}`,
      gemini_system_prompt: geminiPrompt || "Eres un profesional cálido que da seguimiento en LinkedIn en español.",
      auto_reply_mode: (formData.get("auto_reply_mode") as string) || "manual",
      is_active: true,
      is_shadow: true,
      search_paused: true,
      batch_paused: true,
    }).eq("id", shadowId)
    if (sErr) console.error(`[savePostCampaign] shadow campaign failed: ${sErr.message}`)

    // ── secuencia de FU del shadow (tabla campaign_followups) — replace rows
    const fuJson = formData.get("followup_steps_json")
    if (typeof fuJson === "string" && fuJson.length > 0) {
      let parsed: any[] = []
      try { parsed = JSON.parse(fuJson) } catch { parsed = [] }
      const clean = parsed
        .filter((s: any) => (s?.message && String(s.message).trim()) || Number(s?.delay_value) > 0)
        .slice(0, 20)
        .map((s: any, i: number) => ({
          campaign_id:  shadowId,
          step:         i + 1,
          message:      s?.message && String(s.message).trim() ? String(s.message) : null,
          delay_value:  Number.isFinite(Number(s?.delay_value)) ? Number(s.delay_value) : 0,
          delay_unit:   s?.delay_unit === "days" ? "days" : "hours",
          jitter_hours: Number.isFinite(Number(s?.jitter_hours)) ? Number(s.jitter_hours) : 0,
          enabled:      s?.enabled !== false,
        }))
      await admin.from("campaign_followups").delete().eq("campaign_id", shadowId)
      if (clean.length) {
        const { error: fuErr } = await admin.from("campaign_followups").insert(clean)
        if (fuErr) console.error(`[savePostCampaign] campaign_followups failed: ${fuErr.message}`)
      }
    }
  }

  redirect("/dashboard/posts")
}

// ── Page ────────────────────────────────────────────────────────────────────────

export default async function PostCampaignEditPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("admin")
  const { id } = await params
  const admin = createAdminClient() as any

  const { data: pc } = await admin.from("post_campaigns").select("*").eq("id", id).maybeSingle()
  if (!pc) notFound()

  const [{ data: shadow }, { data: fuRows }] = await Promise.all([
    pc.shadow_campaign_id
      ? admin.from("campaigns").select("id, auto_reply_mode").eq("id", pc.shadow_campaign_id).maybeSingle()
      : Promise.resolve({ data: null }),
    pc.shadow_campaign_id
      ? admin.from("campaign_followups").select("step, message, delay_value, delay_unit, jitter_hours, enabled").eq("campaign_id", pc.shadow_campaign_id).order("step")
      : Promise.resolve({ data: [] }),
  ])

  const initialSteps: FollowupStep[] = ((fuRows ?? []) as any[]).map((r) => ({
    message: r.message ?? "",
    delay_value: r.delay_value ?? 24,
    delay_unit: (r.delay_unit === "days" ? "days" : "hours") as "hours" | "days",
    jitter_hours: r.jitter_hours ?? 0,
    enabled: r.enabled !== false,
  }))

  const inp = "w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
  const lbl = "text-[11px] text-gray-500"
  const DAYS = ["lunes","martes","miércoles","jueves","viernes","sábado","domingo"]
  const activeDays: string[] = pc.schedule_days ?? ["lunes","martes","miércoles","jueves","viernes"]

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <form action={savePostCampaign} className="space-y-6">
        <input type="hidden" name="post_campaign_id" value={pc.id} />
        <input type="hidden" name="shadow_campaign_id" value={pc.shadow_campaign_id ?? ""} />

        <header className="flex items-center justify-between">
          <h1 className="text-lg font-bold text-gray-50">📝 Configurar campaña de posts</h1>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" name="is_active" value="true" defaultChecked={pc.is_active} className="accent-green-500" />
            Activa
          </label>
        </header>

        {/* Identidad + targeting */}
        <section className="space-y-3 bg-gray-900/40 border border-gray-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-gray-200">Targeting</h2>
          <div>
            <label className={lbl}>Nombre</label>
            <input name="name" defaultValue={pc.name} className={inp} />
          </div>
          <div>
            <label className={lbl}>Keywords / frases a buscar (separadas por coma o salto de línea)</label>
            <textarea name="post_keywords" rows={3} defaultValue={(pc.post_keywords ?? []).join(", ")}
              placeholder="busco desarrollador fullstack, recomiendan agencia para SaaS, necesito ayuda con mi MVP"
              className={inp + " resize-none"} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={lbl}>Recencia de posts</label>
              <select name="post_recency" defaultValue={pc.post_recency ?? "past-week"} className={inp}>
                <option value="past-24h">Últimas 24h</option>
                <option value="past-week">Última semana</option>
                <option value="past-month">Último mes</option>
              </select>
            </div>
            <div>
              <label className={lbl}>Score mínimo IA (0-10)</label>
              <input type="number" min={0} max={10} name="qualify_min_score" defaultValue={pc.qualify_min_score ?? 6} className={inp} />
            </div>
          </div>
        </section>

        {/* IA: servicio + reglas de comentario + pitch */}
        <section className="space-y-3 bg-gray-900/40 border border-gray-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-gray-200">IA — servicio, comentario y pitch</h2>
          <div>
            <label className={lbl}>¿Qué vendemos? (para calificar el post y redactar el comentario)</label>
            <textarea name="service_description" rows={2} defaultValue={pc.service_description ?? ""}
              placeholder="Desarrollo de SaaS a medida: MVPs en semanas, stack moderno, equipo senior LatAm." className={inp + " resize-none"} />
          </div>
          <div>
            <label className={lbl}>Reglas del comentario público (value-first, NUNCA vende)</label>
            <textarea name="comment_rules" rows={2} defaultValue={pc.comment_rules ?? ""}
              placeholder="Aporta una consideración técnica concreta sobre lo que pide. Tono colega. Sin links ni mención de la empresa." className={inp + " resize-none"} />
          </div>
          <div>
            <label className={lbl}>🔒 Nota de pitch PRIVADA (va en la invitación de conexión, aquí SÍ te presentas)</label>
            <textarea name="pitch_note" rows={2} defaultValue={pc.pitch_note ?? ""}
              placeholder="Hola {nombre}, vi tu post sobre tu SaaS. Construimos MVPs así seguido; si quieres te comparto cómo lo abordaríamos." className={inp + " resize-none"} />
          </div>
          <div>
            <label className={lbl}>Persona / voz (system prompt para comentario y follow-ups)</label>
            <textarea name="gemini_system_prompt" rows={2} defaultValue={pc.gemini_system_prompt ?? ""}
              placeholder="Eres un CTO con experiencia construyendo SaaS, cálido y directo, en español." className={inp + " resize-none"} />
          </div>
        </section>

        {/* Cadencia / caps */}
        <section className="space-y-3 bg-gray-900/40 border border-gray-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-gray-200">Cadencia y límites</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className={lbl} title="Comentarios públicos por día (bajo = más seguro)">Comentarios/día</label>
              <input type="number" min={1} name="daily_comment_target" defaultValue={pc.daily_comment_target ?? 5} className={inp} />
            </div>
            <div>
              <label className={lbl} title="0 = dinámico (reparte el cap en la ventana)">Gap min (0=auto)</label>
              <input type="number" min={0} name="min_comment_gap_min" defaultValue={pc.min_comment_gap_min ?? 0} className={inp} />
            </div>
            <div>
              <label className={lbl}>Gap búsqueda (h)</label>
              <input type="number" min={1} name="search_gap_hours" defaultValue={pc.search_gap_hours ?? 12} className={inp} />
            </div>
            <div>
              <label className={lbl}>Cola mínima</label>
              <input type="number" min={1} name="min_pending_threshold" defaultValue={pc.min_pending_threshold ?? 8} className={inp} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={lbl}>Hora inicio</label>
              <input type="number" min={0} max={23} name="schedule_start_hour" defaultValue={pc.schedule_start_hour ?? 9} className={inp} />
            </div>
            <div>
              <label className={lbl}>Hora fin</label>
              <input type="number" min={0} max={23} name="schedule_end_hour" defaultValue={pc.schedule_end_hour ?? 19} className={inp} />
            </div>
          </div>
          <div>
            <label className={lbl}>Días activos</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {DAYS.map(d => (
                <label key={d} className="flex items-center gap-1.5 text-xs text-gray-400 bg-gray-800/60 border border-gray-700 rounded px-2 py-1 cursor-pointer">
                  <input type="checkbox" name="schedule_days" value={d} defaultChecked={activeDays.includes(d)} className="accent-blue-500" />
                  {d}
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-400">
            <input type="checkbox" name="post_search_paused" value="true" defaultChecked={pc.post_search_paused} className="accent-amber-500" />
            Pausar búsqueda de posts (mantiene la cola y los comentarios aprobados corriendo)
          </label>
        </section>

        {/* Follow-ups (shadow campaign) + auto-reply */}
        <section className="space-y-3 bg-gray-900/40 border border-gray-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-gray-200">Seguimientos tras conectar</h2>
          <p className="text-[11px] text-gray-600 -mt-1">
            Cuando el autor acepta la conexión, el lead entra al motor de follow-ups con esta secuencia
            (es la misma maquinaria que las campañas normales). El primer mensaje reconoce que vienen de su post.
          </p>
          <div>
            <label className={lbl}>Modo de auto-respuesta cuando responden</label>
            <select name="auto_reply_mode" defaultValue={shadow?.auto_reply_mode ?? "manual"} className={inp + " max-w-xs"}>
              <option value="manual">Manual (solo borrador)</option>
              <option value="semi_auto">Semi-automático</option>
              <option value="auto">Automático</option>
            </select>
          </div>
          {pc.shadow_campaign_id
            ? <FollowupSequenceEditor initialSteps={initialSteps} />
            : <p className="text-xs text-amber-400">Esta campaña no tiene shadow campaign — recréala desde la lista de posts.</p>}
        </section>

        <div className="flex justify-end gap-2">
          <a href="/dashboard/posts" className="px-4 py-2 text-sm bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-300">Cancelar</a>
          <button type="submit" className="px-5 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-500 rounded-lg text-white">Guardar</button>
        </div>
      </form>
    </div>
  )
}
