import { createAdminClient } from "@/lib/supabase/admin"
import { redirect, notFound } from "next/navigation"
import DeleteCampaignBtn from "@/components/delete-campaign-btn"

// ── Server Actions ─────────────────────────────────────────────────────────────

async function saveCampaign(formData: FormData) {
  "use server"
  const admin = createAdminClient()
  const id = formData.get("campaign_id") as string

  const parseList = (key: string): string[] =>
    (formData.get(key) as string || "")
      .split(",").map(s => s.trim()).filter(Boolean)

  // ── Campaign row
  await admin.from("campaigns").update({
    name:                  formData.get("name") as string,
    target_audience:       (formData.get("target_audience") as string) || null,
    is_active:             formData.get("is_active") === "true",
    linkedin_account_id:   (formData.get("linkedin_account_id") as string) || null,
    search_keywords:       parseList("search_keywords"),
    search_location:       (formData.get("search_location") as string) || null,
    search_count:          Number(formData.get("search_count") || 25),
    title_whitelist:       parseList("title_whitelist"),
    title_blacklist:       parseList("title_blacklist"),
    batch_paused:          formData.get("batch_paused") === "true",
    search_paused:         formData.get("search_paused") === "true",
    follow_up_paused:      formData.get("follow_up_paused") === "true",
    daily_invite_target:   Number(formData.get("daily_invite_target") || 8),
    min_batch_gap_min:     Number(formData.get("min_batch_gap_min") || 120),
    min_pending_threshold: Number(formData.get("min_pending_threshold") || 15),
    schedule_start_hour:   Number(formData.get("schedule_start_hour") || 9),
    schedule_end_hour:     Number(formData.get("schedule_end_hour") || 19),
    schedule_days:         formData.getAll("schedule_days").length
      ? formData.getAll("schedule_days") as string[]
      : ["lunes","martes","miércoles","jueves","viernes"],
    search_gap_hours:          Number(formData.get("search_gap_hours") || 20),
    search_2nd_degree_only:    formData.get("search_2nd_degree_only") === "true",
    follow_up_message:           (formData.get("follow_up_message") as string) || null,
    follow_up_step2_message:     (formData.get("follow_up_step2_message") as string) || null,
    follow_up_step2_delay_hours: Number(formData.get("follow_up_step2_delay_hours") || 15),
    follow_up_step3_message:     (formData.get("follow_up_step3_message") as string) || null,
    follow_up_step3_delay_hours: Number(formData.get("follow_up_step3_delay_hours") || 28),
    follow_up_step4_message:     (formData.get("follow_up_step4_message") as string) || null,
    follow_up_step4_delay_hours: Number(formData.get("follow_up_step4_delay_hours") || 96),
    follow_up_step5_message:     (formData.get("follow_up_step5_message") as string) || null,
    follow_up_step5_delay_hours: Number(formData.get("follow_up_step5_delay_hours") || 84),
    auto_dead_after_days:        Number(formData.get("auto_dead_after_days") || 21),
    fm1_example_reply:           (formData.get("fm1_example_reply") as string) || null,
    fm2_example_reply:           (formData.get("fm2_example_reply") as string) || null,
    fm3_example_reply:           (formData.get("fm3_example_reply") as string) || null,
    auto_reply_mode:            (formData.get("auto_reply_mode") as string) || "manual",
    auto_reply_delay_min:       Number(formData.get("auto_reply_delay_min") || 45),
    auto_reply_delay_max:       Number(formData.get("auto_reply_delay_max") || 90),
    ai_tone:                    (formData.get("ai_tone") as string) || "casual",
    ai_sender_persona:          (formData.get("ai_sender_persona") as string) || null,
    ai_company_context:         (formData.get("ai_company_context") as string) || null,
    ai_example_messages:        (formData.get("ai_example_messages") as string) || null,
  }).eq("id", id)

  // ── Message template — upsert by campaign_id
  const templateId = formData.get("template_id") as string | null
  const templatePayload = {
    campaign_id:          id,
    name:                 (formData.get("template_name") as string) || "Template principal",
    tone:                 (formData.get("tone") as string) || "casual",
    language:             (formData.get("language") as string) || "es",
    max_chars:            Number(formData.get("max_chars") || 150),
    qualification_rules:  (formData.get("qualification_rules") as string) || null,
    message_rules:        (formData.get("message_rules") as string) || null,
    opening_hint:         (formData.get("opening_hint") as string) || null,
    example_good:         (formData.get("example_good") as string) || null,
    example_bad:          (formData.get("example_bad") as string) || null,
    is_active:            true,
    updated_at:           new Date().toISOString(),
  }

  if (templateId) {
    await admin.from("message_templates").update(templatePayload).eq("id", templateId)
  } else {
    await admin.from("message_templates").insert(templatePayload)
  }

  redirect("/dashboard/campaigns")
}

async function deleteCampaign(formData: FormData) {
  "use server"
  const admin = createAdminClient()
  const id = formData.get("campaign_id") as string
  await admin.from("message_templates").delete().eq("campaign_id", id)
  await admin.from("campaigns").delete().eq("id", id)
  redirect("/dashboard/campaigns")
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function CampaignEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const admin = createAdminClient()

  const [{ data: c }, { data: accounts }, { data: templates }] = await Promise.all([
    admin.from("campaigns").select("*").eq("id", id).single(),
    admin.from("linkedin_accounts").select("id, label, linkedin_profile_url, status, proxy_country_code, proxy_country_name, proxy_ip, proxy_checked_at").order("label"),
    admin.from("message_templates").select("*").eq("campaign_id", id).eq("is_active", true).limit(1),
  ])

  if (!c) notFound()

  const t = templates?.[0] ?? null
  const toComma = (arr: string[] | null) => (arr ?? []).join(", ")

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-50">Editar campaña</h1>
          <p className="text-gray-400 text-sm mt-0.5">{c.name}</p>
        </div>
        {/* Delete */}
        <DeleteCampaignBtn
          campaignId={c.id}
          campaignName={c.name}
          deleteAction={deleteCampaign}
        />
      </div>

      <form action={saveCampaign} className="space-y-6">
        <input type="hidden" name="campaign_id" value={c.id} />
        {t && <input type="hidden" name="template_id" value={t.id} />}

        {/* ── GENERAL ─────────────────────────────────────────────────── */}
        <Section title="General" icon="⚙️">
          <Field label="Nombre *">
            <input name="name" required defaultValue={c.name} className={inp} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Estado">
              <select name="is_active" defaultValue={String(c.is_active)} className={inp}>
                <option value="true">Activa</option>
                <option value="false">Inactiva</option>
              </select>
            </Field>
            <Field label="Cuenta LinkedIn">
              <select name="linkedin_account_id" defaultValue={c.linkedin_account_id ?? ""} className={inp}>
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
            <textarea name="target_audience" rows={2} defaultValue={c.target_audience ?? ""}
              placeholder="Ej: Directores de Finanzas de empresas medianas en México" className={inp} />
          </Field>
        </Section>

        {/* ── SCHEDULER ───────────────────────────────────────────────── */}
        <Section title="Scheduler" icon="🕐" description="Controla cuándo y con qué cadencia se envían invitaciones y se buscan leads.">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <Field label="Invitaciones / día" hint="Límite diario de invites por campaña.">
              <input name="daily_invite_target" type="number" min="1" max="20"
                defaultValue={c.daily_invite_target ?? 8} className={inp} />
            </Field>
            <Field label="Gap entre batches (min)" hint="Mínimo de minutos entre un batch y el siguiente.">
              <input name="min_batch_gap_min" type="number" min="30" max="480"
                defaultValue={c.min_batch_gap_min ?? 120} className={inp} />
            </Field>
            <Field label="Umbral mínimo en cola" hint="Si hay menos leads pendientes que este umbral, se dispara un nuevo search.">
              <input name="min_pending_threshold" type="number" min="5" max="100"
                defaultValue={c.min_pending_threshold ?? 15} className={inp} />
            </Field>
            <Field label="Hora de inicio (24h)" hint="Hora del día a partir de la cual se activa el scheduler (hora México).">
              <input name="schedule_start_hour" type="number" min="0" max="23"
                defaultValue={c.schedule_start_hour ?? 9} className={inp} />
            </Field>
            <Field label="Hora de fin (24h)" hint="Hora del día a partir de la cual el scheduler se detiene.">
              <input name="schedule_end_hour" type="number" min="0" max="23"
                defaultValue={c.schedule_end_hour ?? 19} className={inp} />
            </Field>
            <Field label="Días activos" hint="Días de la semana en que corren búsqueda e invitaciones (hora México).">
              {(() => {
                const allDays = [
                  { value: "lunes",     label: "L" },
                  { value: "martes",    label: "M" },
                  { value: "miércoles", label: "X" },
                  { value: "jueves",    label: "J" },
                  { value: "viernes",   label: "V" },
                  { value: "sábado",    label: "S" },
                  { value: "domingo",   label: "D" },
                ]
                const activeDays: string[] = (c as any).schedule_days ?? ["lunes","martes","miércoles","jueves","viernes"]
                return (
                  <div className="flex gap-2 flex-wrap">
                    {allDays.map(({ value, label }) => (
                      <label key={value} className="cursor-pointer">
                        <input
                          type="checkbox"
                          name="schedule_days"
                          value={value}
                          defaultChecked={activeDays.includes(value)}
                          className="sr-only peer"
                        />
                        <span className="flex items-center justify-center w-9 h-9 rounded-lg border text-xs font-bold transition-colors peer-checked:bg-blue-600 peer-checked:border-blue-600 peer-checked:text-gray-50 border-gray-600 text-gray-400 hover:border-gray-400">
                          {label}
                        </span>
                      </label>
                    ))}
                  </div>
                )
              })()}
            </Field>
            <Field label="Gap entre búsquedas (horas)" hint="Horas mínimas entre un search y el siguiente.">
              <input name="search_gap_hours" type="number" min="1" max="168"
                defaultValue={c.search_gap_hours ?? 20} className={inp} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-6 pt-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="hidden" name="batch_paused" value="false" />
              <input name="batch_paused" type="checkbox" value="true"
                defaultChecked={c.batch_paused}
                className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-yellow-500 focus:ring-yellow-500" />
              <span className="text-sm text-gray-300">⏸ Pausar envío de invitaciones</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="hidden" name="search_paused" value="false" />
              <input name="search_paused" type="checkbox" value="true"
                defaultChecked={c.search_paused}
                className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-yellow-500 focus:ring-yellow-500" />
              <span className="text-sm text-gray-300">⏸ Pausar búsqueda de leads</span>
            </label>
          </div>
        </Section>

        {/* ── FOLLOW-UP ───────────────────────────────────────────────── */}
        <Section title="Seguimiento automático" icon="💬"
          description="Hasta 5 pasos de seguimiento automáticos. Cada paso se envía solo una vez por lead; si el lead responde en cualquier momento sale de la secuencia. Déjalo vacío para desactivarlo.">
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4 text-xs text-amber-300 space-y-1">
            <p>FU1 se envía en el siguiente tick (~30 min) tras aceptar la conexión. FU2-5 respetan el delay en horas configurado desde el envío del paso anterior.</p>
          </div>

          {/* Step 1 */}
          <div className="space-y-3">
            <p className="text-gray-400 text-xs font-semibold uppercase tracking-wide">Seguimiento 1 — tras conectar</p>
            <Field label="Mensaje de seguimiento 1"
              hint="Se envía en el primer tick después de que el lead acepta la conexión. Usa [Nombre] para personalizar.">
              <textarea name="follow_up_message" rows={3}
                defaultValue={c.follow_up_message ?? ""}
                placeholder="Hola [Nombre], gracias por conectar. ¿Tienes 15 min esta semana para conversar?"
                className={inp} />
            </Field>
          </div>

          {/* Step 2 */}
          <div className="space-y-3 pt-2 border-t border-gray-800">
            <p className="text-gray-400 text-xs font-semibold uppercase tracking-wide">Seguimiento 2 — {(c as any).follow_up_step2_delay_hours ?? 15}h después del FU1 — opcional</p>
            <Field label="Mensaje de seguimiento 2"
              hint="Se envía si no hubo respuesta tras el delay configurado. Déjalo vacío para desactivar.">
              <textarea name="follow_up_step2_message" rows={3}
                defaultValue={(c as any).follow_up_step2_message ?? ""}
                placeholder="Hola de nuevo [Nombre]. Sé que estás ocupado — ¿te viene bien 15 min esta semana?"
                className={inp} />
            </Field>
            <Field label="Horas de espera desde FU1" hint="Default: 15h">
              <input name="follow_up_step2_delay_hours" type="number" min="6" max="240"
                defaultValue={(c as any).follow_up_step2_delay_hours ?? 15} className={inp} />
            </Field>
          </div>

          {/* Step 3 */}
          <div className="space-y-3 pt-2 border-t border-gray-800">
            <p className="text-gray-400 text-xs font-semibold uppercase tracking-wide">Seguimiento 3 — {(c as any).follow_up_step3_delay_hours ?? 28}h después del FU2 — opcional</p>
            <Field label="Mensaje de seguimiento 3"
              hint="Déjalo vacío para desactivar.">
              <textarea name="follow_up_step3_message" rows={3}
                defaultValue={(c as any).follow_up_step3_message ?? ""}
                placeholder="[Nombre], ¿pudiste ver mi mensaje anterior? Solo quiero asegurarme de que llegó."
                className={inp} />
            </Field>
            <Field label="Horas de espera desde FU2" hint="Default: 28h">
              <input name="follow_up_step3_delay_hours" type="number" min="12" max="480"
                defaultValue={(c as any).follow_up_step3_delay_hours ?? 28} className={inp} />
            </Field>
          </div>

          {/* Step 4 */}
          <div className="space-y-3 pt-2 border-t border-gray-800">
            <p className="text-gray-400 text-xs font-semibold uppercase tracking-wide">Seguimiento 4 — {(c as any).follow_up_step4_delay_hours ?? 96}h después del FU3 — opcional</p>
            <Field label="Mensaje de seguimiento 4"
              hint="Déjalo vacío para desactivar. Recomendado: cambio de ángulo (nuevo argumento o caso de éxito).">
              <textarea name="follow_up_step4_message" rows={3}
                defaultValue={(c as any).follow_up_step4_message ?? ""}
                placeholder="[Nombre], le ayudamos a [empresa similar] a conseguir X en 30 días. ¿Aplica en tu caso?"
                className={inp} />
            </Field>
            <Field label="Horas de espera desde FU3" hint="Default: 96h (~4 días)">
              <input name="follow_up_step4_delay_hours" type="number" min="24" max="720"
                defaultValue={(c as any).follow_up_step4_delay_hours ?? 96} className={inp} />
            </Field>
          </div>

          {/* Step 5 — Closing */}
          <div className="space-y-3 pt-2 border-t border-gray-800">
            <p className="text-gray-400 text-xs font-semibold uppercase tracking-wide">Cierre (FU5) — {(c as any).follow_up_step5_delay_hours ?? 84}h después del FU4 — opcional</p>
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3 text-xs text-amber-300">
              Último intento. Tono de bajo compromiso — sin presión. Después de este paso, el lead puede marcarse como dead automáticamente.
            </div>
            <Field label="Mensaje de cierre"
              hint="Breve y sin presión. Déjalo vacío para desactivar.">
              <textarea name="follow_up_step5_message" rows={3}
                defaultValue={(c as any).follow_up_step5_message ?? ""}
                placeholder="[Nombre], entiendo que no es el momento. Queda la puerta abierta — si en algún momento tiene sentido conversar, aquí estaré."
                className={inp} />
            </Field>
            <Field label="Horas de espera desde FU4" hint="Default: 84h (~3.5 días)">
              <input name="follow_up_step5_delay_hours" type="number" min="24" max="720"
                defaultValue={(c as any).follow_up_step5_delay_hours ?? 84} className={inp} />
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Días hasta marcar como Perdido" hint="Días tras el último follow-up sin respuesta para auto-marcar como dead. Default: 21.">
              <input name="auto_dead_after_days" type="number" min="7" max="90"
                defaultValue={(c as any).auto_dead_after_days ?? 21} className={inp} />
            </Field>
          </div>

          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="hidden" name="follow_up_paused" value="false" />
              <input name="follow_up_paused" type="checkbox" value="true"
                defaultChecked={c.follow_up_paused ?? false}
                className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-yellow-500 focus:ring-yellow-500" />
              <span className="text-sm text-gray-300">⏸ Pausar todos los seguimientos</span>
            </label>
          </div>

          {/* ── Flujo de Mensajes FM1 / FM2 / FM3 ───────────────────────── */}
          <div className="space-y-4 pt-2 border-t border-gray-800">
            <div>
              <p className="text-gray-300 text-xs font-semibold uppercase tracking-wide">💬 Flujo de Mensajes — FM1 / FM2 / FM3</p>
              <p className="text-gray-500 text-xs mt-1">
                Cuando un contacto responde (a la conexión o a cualquier FU), Gemini lleva la conversación en hasta 3 turnos para agendar una reunión vía Cal.com.
                Proporciona un ejemplo de respuesta para cada turno para calibrar el tono y la longitud exacta que quieres.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-1 text-xs text-gray-500 bg-gray-800/40 rounded-xl p-3 border border-gray-700">
              <div className="flex gap-2 items-start">
                <span className="text-blue-400 font-bold shrink-0">FM1</span>
                <span>Turno 0 — <strong className="text-gray-300">Rapport.</strong> Reconoce su mensaje, menciona 1 dato de su perfil, haz UNA pregunta abierta. Sin mencionar el producto ni Cal.com.</span>
              </div>
              <div className="flex gap-2 items-start mt-1">
                <span className="text-yellow-400 font-bold shrink-0">FM2</span>
                <span>Turnos 1-2 — <strong className="text-gray-300">Profundizar.</strong> Responde directo a lo que dijo, muestra valor con contexto EBOOMS. Si hay interés claro → ofrece llamada de 20 min.</span>
              </div>
              <div className="flex gap-2 items-start mt-1">
                <span className="text-green-400 font-bold shrink-0">FM3</span>
                <span>Turno 3+ — <strong className="text-gray-300">Cierre.</strong> Propone la sesión de 20 min directamente con el link de Cal.com. Si rechaza, acepta con gracia y deja la puerta abierta.</span>
              </div>
            </div>

            <Field
              label="🔵 FM1 — Ejemplo de respuesta de rapport (turno 0)"
              hint="Cómo debe sonar la PRIMERA respuesta cuando alguien contesta. Calibra longitud y tono. Vacío = Gemini usa su criterio.">
              <textarea name="fm1_example_reply" rows={3}
                defaultValue={(c as any).fm1_example_reply ?? ""}
                placeholder={`Ej: "Qué bueno que lo mencionas, [Nombre]. Vi que llevas el área comercial en [Empresa] — justo ese contexto me parece interesante. ¿Cómo está funcionando la generación de nuevos clientes para ustedes este año?"`}
                className={`${inp} resize-none`} />
            </Field>

            <Field
              label="🟡 FM2 — Ejemplo de respuesta de profundidad (turnos 1-2)"
              hint="Cómo mostrar valor sin vender directamente. Responde a lo que dijo el lead, conecta con EBOOMS.">
              <textarea name="fm2_example_reply" rows={3}
                defaultValue={(c as any).fm2_example_reply ?? ""}
                placeholder={`Ej: "Tiene sentido lo que mencionas. Justo ese es el problema que más escucho en empresas de tu tamaño — los equipos comerciales dedican menos del 30% a atraer negocio nuevo. ¿Cuántos vendedores tienen activos prospectando hoy?"`}
                className={`${inp} resize-none`} />
            </Field>

            <Field
              label="🟢 FM3 — Ejemplo de respuesta de cierre con Cal.com (turno 3+)"
              hint="Cómo proponer la reunión de 20 min de forma natural. Gemini incluirá automáticamente el link de Cal.com configurado en la cuenta.">
              <textarea name="fm3_example_reply" rows={3}
                defaultValue={(c as any).fm3_example_reply ?? ""}
                placeholder={`Ej: "Creo que vale la pena que lo veamos en una llamada rápida — 20 minutos. Aquí puedes elegir el horario que mejor te quede: [CAL_URL]. ¿Te parece?"`}
                className={`${inp} resize-none`} />
            </Field>
          </div>

          {/* Auto-respuesta IA */}
          <div className="space-y-3 pt-2 border-t border-gray-800">
            <p className="text-gray-400 text-xs font-semibold uppercase tracking-wide">Auto-respuesta IA</p>
            <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-3 text-xs text-blue-300">
              Cuando un lead responde, Gemini genera un borrador contextualizado con su perfil e historial.
              En modo Semi-auto o Automático, se envía tras el retraso configurado sin necesidad de aprobación.
              Puedes cancelar cualquier envío desde <strong>/conversaciones</strong> antes de que ocurra.
            </div>
            <Field label="Modo de respuesta automática">
              <select name="auto_reply_mode" defaultValue={(c as any).auto_reply_mode ?? "manual"} className={inp}>
                <option value="manual">Manual — siempre requiere aprobación humana</option>
                <option value="semi_auto">Semi-automático — countdown + cancelación (testing)</option>
                <option value="auto">Automático — envío sin intervención (producción)</option>
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Retraso mínimo (min)" hint="Recomendado: ≥30 min para parecer humano.">
                <input name="auto_reply_delay_min" type="number" min="5" max="480"
                  defaultValue={(c as any).auto_reply_delay_min ?? 45} className={inp} />
              </Field>
              <Field label="Retraso máximo (min)" hint="Randomización anti-ban — se elige un tiempo aleatorio entre mín y máx.">
                <input name="auto_reply_delay_max" type="number" min="10" max="720"
                  defaultValue={(c as any).auto_reply_delay_max ?? 90} className={inp} />
              </Field>
            </div>
          </div>
        </Section>



        {/* ── PERSONALIZACIÓN IA ──────────────────────────────────────── */}
        <Section title="Personalización IA" icon="🧠" description="Define la voz del vendedor y el contexto de tu empresa. La IA escribirá exactamente con ese estilo.">
          <Field label="Tono de comunicación" hint="Define el registro general de todos los mensajes de esta campaña.">
            <select name="ai_tone" defaultValue={(c as any).ai_tone ?? "casual"} className={inp}>
              <option value="casual">💬 Casual y amigable — como entre colegas</option>
              <option value="professional">🤝 Profesional — claro y confiable</option>
              <option value="executive">⚡ Ejecutivo — directo, sin relleno, C-level a C-level</option>
              <option value="technical">🔧 Técnico — preciso, terminología del sector</option>
            </select>
          </Field>

          <Field
            label="Perfil del vendedor (tu voz)"
            hint="Cuéntale a la IA quién eres. Cuanto más detalle, más auténtica suena la voz. Incluye: nombre, cargo, años de experiencia, estilo de comunicación, frases que usas, lo que NO dices."
          >
            <textarea name="ai_sender_persona" rows={5}
              defaultValue={(c as any).ai_sender_persona ?? ""}
              placeholder={`Ejemplo: Me llamo Joshua, soy cofundador de EBOOMS. Tengo 6 años en ventas B2B. Soy directo pero con humor. Me gusta ir al grano sin sonar vendedor. Nunca digo "espero que estés bien" ni "te escribo porque vi tu perfil". Uso frases cortas. Hago preguntas de una sola cosa a la vez. Si el lead no responde a la pregunta, la reformulo diferente.`}
              className={`${inp} resize-none`} />
          </Field>

          <Field
            label="Contexto de tu empresa"
            hint="Qué vendes, a quién, qué problema resuelves, tu propuesta de valor, preguntas frecuentes y cómo responderlas. Si lo dejas vacío, se usa el contexto genérico de EBOOMS."
          >
            <textarea name="ai_company_context" rows={8}
              defaultValue={(c as any).ai_company_context ?? ""}
              placeholder={`Ejemplo:
EMPRESA: EBOOMS — automatización de prospección B2B en LinkedIn.
PROBLEMA QUE RESUELVES: Los equipos comerciales dedican menos del 30% de su tiempo a atraer negocio nuevo. ORION lo hace en piloto automático.
PROPUESTA DE VALOR: 100 conexiones con decisores en el primer mes. 2-3 citas calificadas. Sin permanencia.
CLIENTE IDEAL: Directores comerciales o CEO de empresas de servicios B2B con ticket alto.
OBJETIVO EN LINKEDIN: Solo conseguir una reunión de 20 min. No vender en el chat.
FAQ:
- ¿Cuánto cuesta? → No dar precio; mostrar ROI en la reunión.
- ¿Garantizan resultados? → Garantizamos el sistema funcionando; resultados dependen de la propuesta de valor.`}
              className={`${inp} resize-none font-mono text-xs`} />
          </Field>

          <Field
            label="Mensajes de ejemplo (calibración de estilo)"
            hint="Pega 2-3 mensajes reales que hayas enviado y que representen bien tu estilo. La IA los usará como referencia exacta de longitud, tono y estructura. Separa cada mensaje con una línea en blanco."
          >
            <textarea name="ai_example_messages" rows={6}
              defaultValue={(c as any).ai_example_messages ?? ""}
              placeholder={`Ejemplo 1:
Hola Ana, vi que llevas el área comercial en Grupo XYZ. ¿Cómo está funcionando la generación de leads B2B para ustedes este año?

Ejemplo 2:
Qué bien que lo mencionas. Justo ese es el problema que más escucho en empresas de tu tamaño. ¿Cuántos vendedores tienen activos prospectando en LinkedIn hoy?`}
              className={`${inp} resize-none`} />
          </Field>
        </Section>

        {/* ── BÚSQUEDA ────────────────────────────────────────────────── */}
        <Section title="Búsqueda en LinkedIn" icon="🔍" description="Parámetros para el scraper de perfiles.">

          {/* Proxy vs location warning */}
          {(() => {
            const linkedAccount = accounts?.find(a => a.id === c.linkedin_account_id) as any
            const proxyCountry  = linkedAccount?.proxy_country_name ?? null
            const proxyCode     = linkedAccount?.proxy_country_code ?? null
            const proxyIp       = linkedAccount?.proxy_ip ?? null
            const location      = c.search_location ?? ""
            const proxyChecked  = linkedAccount?.proxy_checked_at ?? null

            // Detect if location mentions a country different from proxy country
            const locationLower = location.toLowerCase()
            const proxyLower    = (proxyCountry ?? "").toLowerCase()
            const countryMismatch = proxyCode && location &&
              !locationLower.includes(proxyLower.split(" ")[0]) &&
              !locationLower.includes(proxyCode.toLowerCase())

            return (
              <div className="space-y-2 mb-2">
                {/* Proxy info banner */}
                <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm ${
                  proxyIp
                    ? "bg-gray-800/60 border-gray-700"
                    : "bg-red-500/10 border-red-500/30"
                }`}>
                  <span className="text-lg shrink-0 mt-0.5">
                    {proxyIp ? "🌐" : "⚠️"}
                  </span>
                  <div className="flex-1 min-w-0">
                    {proxyIp ? (
                      <>
                        <p className="text-gray-200 text-xs font-medium">
                          Proxy activo — {proxyCountry ?? proxyCode} {proxyCode && `(${proxyCode})`}
                        </p>
                        <p className="text-gray-500 text-xs mt-0.5 font-mono">{proxyIp}{linkedAccount?.proxy_city ? ` · ${linkedAccount.proxy_city}` : ""}</p>
                        {proxyChecked && (
                          <p className="text-gray-600 text-xs mt-0.5">
                            Verificado: {new Date(proxyChecked).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-red-400 text-xs">
                        Proxy no verificado — ve a <strong>Cuentas LI</strong> y haz click en "Verificar proxy" para ver el país real de tu IP.
                      </p>
                    )}
                  </div>
                </div>

                {/* Country mismatch warning */}
                {countryMismatch && (
                  <div className="flex items-start gap-3 px-4 py-3 bg-yellow-500/10 border border-yellow-500/30 rounded-xl text-sm">
                    <span className="text-lg shrink-0 mt-0.5">🚨</span>
                    <div>
                      <p className="text-yellow-400 font-semibold text-xs">Riesgo de ban — mismatch de país</p>
                      <p className="text-yellow-400/80 text-xs mt-0.5">
                        Tu proxy está en <strong>{proxyCountry}</strong> pero la ubicación de búsqueda es <strong>"{location}"</strong>.
                        Un humano usando LinkedIn desde {proxyCountry} normalmente no busca perfiles de otra región de forma masiva.
                        Usa un proxy del país donde quieres buscar, o verifica manualmente esa región antes de automatizar.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )
          })()}

          <Field label="Keywords de búsqueda" hint="Separadas por coma. La primera se usa como query principal en LinkedIn.">
            <input name="search_keywords" defaultValue={toComma(c.search_keywords)}
              placeholder="Director Finanzas, CFO, VP Finance" className={inp} />
            <TagPreview value={toComma(c.search_keywords)} color="blue" />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Ubicación" hint="Ej: Mexico City, Mexico">
              <input name="search_location" defaultValue={c.search_location ?? ""}
                placeholder="Mexico" className={inp} />
            </Field>
            <Field label="Máx. leads por búsqueda">
              <input name="search_count" type="number" min="5" max="200"
                defaultValue={c.search_count ?? 25} className={inp} />
            </Field>
          </div>

          <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 text-xs text-blue-300 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-semibold text-blue-200">Solo conexiones de 2do grado</p>
                <p className="mt-0.5 text-blue-300/80">Personas con las que tienes contactos mutuos. Tienen ~40% más tasa de aceptación que contactos de 3er grado porque LinkedIn muestra una conexión en común como señal de confianza.</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer shrink-0">
                <input type="hidden" name="search_2nd_degree_only" value="false" />
                <input name="search_2nd_degree_only" type="checkbox" value="true"
                  defaultChecked={(c as any).search_2nd_degree_only !== false}
                  className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500" />
                <span className="text-blue-200 font-medium">Activado</span>
              </label>
            </div>
            <p className="text-blue-300/60">Desactivar solo si necesitas más volumen y el 2do grado se agota. Con cuentas frías, 2do grado siempre es mejor.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="✅ Whitelist — Cargos que SÍ queremos"
              hint="Vacío = no filtrar. Busca substring en el headline.">
              <input name="title_whitelist" defaultValue={toComma(c.title_whitelist)}
                placeholder="Director, CEO, CFO, VP, Gerente General" className={inp} />
              <TagPreview value={toComma(c.title_whitelist)} color="green" />
            </Field>
            <Field label="🚫 Blacklist — Cargos que NO queremos"
              hint="Se descartan si el headline contiene alguno.">
              <input name="title_blacklist" defaultValue={toComma(c.title_blacklist)}
                placeholder="Estudiante, Intern, Pasante, Junior" className={inp} />
              <TagPreview value={toComma(c.title_blacklist)} color="red" />
            </Field>
          </div>
        </Section>

        {/* ── TEMPLATE DE MENSAJE IA ──────────────────────────────────── */}
        <Section title="Template de mensaje IA" icon="🤖"
          description="Instrucciones que recibe Gemini para calificar leads y generar el mensaje de conexión personalizado.">

          <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 text-xs text-blue-300 space-y-1.5">
            <p>Gemini recibe el perfil del lead (<code className="bg-blue-500/10 px-1 rounded">nombre, headline, about, headlineCompany</code>) junto con estas reglas para generar un mensaje de ≤{t?.max_chars ?? 150} caracteres.</p>
            <p><code className="bg-blue-500/10 px-1 rounded">headlineCompany</code> = empresa extraída del headline por regex. Úsala como referencia de empresa — nunca uses el título del cargo como nombre de empresa.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Field label="Nombre del template">
              <input name="template_name" defaultValue={t?.name ?? "Template principal"} className={inp} />
            </Field>
            <Field label="Tono">
              <select name="tone" defaultValue={t?.tone ?? "casual"} className={inp}>
                <option value="casual">Casual</option>
                <option value="formal">Formal</option>
                <option value="friendly">Amigable</option>
                <option value="direct">Directo</option>
              </select>
            </Field>
            <Field label="Idioma">
              <select name="language" defaultValue={t?.language ?? "es"} className={inp}>
                <option value="es">Español</option>
                <option value="en">Inglés</option>
                <option value="pt">Portugués</option>
              </select>
            </Field>
          </div>

          <Field label="Límite de caracteres" hint="LinkedIn permite máx. 300 caracteres en notas de invitación. Recomendado: 150.">
            <input name="max_chars" type="number" min="50" max="300"
              defaultValue={t?.max_chars ?? 150} className={inp} />
          </Field>

          <Field label="Reglas de calificación"
            hint="Cuándo descalificar un lead. Gemini devuelve qualified: false si se cumple alguna de estas condiciones.">
            <textarea name="qualification_rules" rows={3}
              defaultValue={t?.qualification_rules ?? ""}
              placeholder="Descalifica SOLO si: perfil memorial, persona fallecida, cuenta bot/empresa disfrazada, o los tres campos headline+about+currentPosition son null simultáneamente."
              className={inp} />
          </Field>

          <Field label="Reglas de mensaje"
            hint="Instrucciones de personalización. Usa headlineCompany para mencionar la empresa. Prioriza señales concretas del perfil.">
            <textarea name="message_rules" rows={5}
              defaultValue={t?.message_rules ?? ""}
              placeholder={`Redacta UN mensaje de conexión en español. Prioridad:
1. Si hay headlineCompany: menciona algo específico de la empresa.
2. Tono casual, sin lenguaje corporativo.
3. Termina con una pregunta corta y abierta.
LÍMITE ABSOLUTO: {max_chars} caracteres — cuenta uno por uno, recorta si supera.
NUNCA uses el cargo/título como si fuera el nombre de una empresa.`}
              className={inp} />
          </Field>

          <Field label="Hint de apertura"
            hint="Cómo debe empezar el mensaje. Gemini respeta esto como punto de partida.">
            <textarea name="opening_hint" rows={2}
              defaultValue={t?.opening_hint ?? ""}
              placeholder="Empieza con su nombre de pila. Menciona su empresa o rol actual en la primera oración."
              className={inp} />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="✅ Ejemplo de mensaje BUENO"
              hint="Gemini lo usa como referencia del tono y formato ideal.">
              <textarea name="example_good" rows={3}
                defaultValue={t?.example_good ?? ""}
                placeholder="Hola Santiago, veo tu trabajo en Villacero. ¿Qué es lo más desafiante en finanzas ahora?"
                className={inp} />
            </Field>
            <Field label="🚫 Ejemplo de mensaje MALO"
              hint="Qué debe evitar Gemini a toda costa.">
              <textarea name="example_bad" rows={3}
                defaultValue={t?.example_bad ?? ""}
                placeholder="Espero que estés bien. Me gustaría conectar contigo para explorar sinergias profesionales."
                className={inp} />
            </Field>
          </div>
        </Section>

        {/* ── ACTIONS ─────────────────────────────────────────────────── */}
        <div className="flex gap-3 pt-2">
          <button type="submit"
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white  font-semibold text-sm rounded-lg transition-colors">
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

// ── Sub-components ──────────────────────────────────────────────────────────────

const inp = "w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"

function Section({ title, icon, description, children }: {
  title: string; icon?: string; description?: string; children: React.ReactNode
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
      <div>
        <h2 className="text-gray-50 font-semibold">{icon && <span className="mr-2">{icon}</span>}{title}</h2>
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

function TagPreview({ value, color }: { value: string; color: "green" | "red" | "blue" }) {
  const tags = value.split(",").map(s => s.trim()).filter(Boolean)
  if (!tags.length) return null
  const cls = {
    green: "bg-green-500/10 text-green-400 border-green-500/30",
    red:   "bg-red-500/10 text-red-400 border-red-500/30",
    blue:  "bg-blue-500/10 text-blue-400 border-blue-500/30",
  }[color]
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {tags.map(t => (
        <span key={t} className={`text-xs px-2 py-0.5 rounded-full border ${cls}`}>{t}</span>
      ))}
    </div>
  )
}
