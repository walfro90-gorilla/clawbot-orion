import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { redirect } from "next/navigation"
import type { AccountToday } from "@clawbot/db-types"
import { ExtensionPanel }   from "@/components/extension-panel"
import { OnboardingActivatePanel } from "@/components/onboarding-activate-panel"

async function updateAccount(formData: FormData) {
  "use server"
  // Admin client: bypass RLS para updates (la cuenta puede tener user_id null si fue creada sin auth)
  const admin = createAdminClient()
  const id = formData.get("id") as string

  const assignedUserId = formData.get("assigned_user_id") as string | null

  const newWarmupStatus = formData.get("warmup_status") as string
  // warmup_started_at es proxy de EDAD de cuenta (lo lee la rampa effectiveWarmupCap).
  // Se estampa UNA sola vez (si está null); NUNCA se resetea al cambiar de temperatura —
  // resetearlo reiniciaría la rampa a día-0 y tankearía una cuenta madura a cap 3.
  const { data: existingWarmup } = await admin.from("linkedin_accounts").select("warmup_started_at").eq("id", id).single()

  const { error } = await admin.from("linkedin_accounts").update({
    label:                  formData.get("label") as string || null,
    linkedin_profile_url:   formData.get("linkedin_profile_url") as string || null,
    daily_connection_limit: parseInt(formData.get("daily_connection_limit") as string) || 20,
    status:                 formData.get("status") as string,
    proxy_url:              formData.get("proxy_url") as string || null,
    cal_com_url:            formData.get("cal_com_url") as string || null,
    reply_delay_min:        (formData.get("reply_delay_min") as string) ? parseInt(formData.get("reply_delay_min") as string) : null,
    reply_delay_max:        (formData.get("reply_delay_max") as string) ? parseInt(formData.get("reply_delay_max") as string) : null,
    inbox_gap_min:                parseInt(formData.get("inbox_gap_min") as string) || 60,
    inbox_paused:                 formData.get("inbox_paused") === "true",
    inbound_enabled:              formData.get("inbound_enabled") === "true",
    inbound_reply_mode:           (formData.get("inbound_reply_mode") as string) || "manual",
    inbound_decline_template:     (formData.get("inbound_decline_template") as string) || null,
    inbound_qualification_rules:  (formData.get("inbound_qualification_rules") as string) || null,
    user_id:                assignedUserId || null,
    warmup_status:          newWarmupStatus || "cold",
    search_mode:            (formData.get("search_mode") as string) || "free",
    // Solo inicializa si nunca se estampó; jamás resetea (ver nota arriba).
    ...(existingWarmup?.warmup_started_at ? {} : { warmup_started_at: new Date().toISOString() }),
  }).eq("id", id)

  if (error) console.error("[accounts] updateAccount error:", error.message)

  redirect("/dashboard/accounts")
}

async function createAccount(formData: FormData) {
  "use server"
  const { createClient } = await import("@/lib/supabase/server")
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  await supabase.from("linkedin_accounts").insert({
    label:                   formData.get("label") as string || null,
    linkedin_profile_url:    formData.get("linkedin_profile_url") as string || null,
    proxy_url:               formData.get("proxy_url") as string || null,
    li_at_cookie:            "",                  // Will be captured via "Renovar Cookie" button
    daily_connection_limit:  parseInt(formData.get("daily_connection_limit") as string) || 20,
    status:                  "rate_limited",      // Inactive until cookie is captured
    user_id:                 user!.id,
    // (3-ago) Cuenta NUEVA arranca en warmup frío con la rampa corriendo desde HOY.
    // Antes warmup_started_at solo se estampaba al primer EDIT: la rampa por edad
    // (effectiveWarmupCap) no corría y el cap real dependía de que alguien editara.
    // cold → cap efectivo 3-5/día los primeros días, suba lo que suba el form arriba.
    warmup_status:           "cold",
    warmup_started_at:       new Date().toISOString(),
  })

  redirect("/dashboard/accounts")
}

export default async function AccountsPage() {
  const admin = createAdminClient()
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { data: profile } = await admin
    .from("profiles")
    .select("role, linkedin_account_id")
    .eq("id", user!.id)
    .single()
  const isAdmin     = profile?.role === "god_admin" || profile?.role === "admin"
  const myAccountId = profile?.linkedin_account_id ?? null

  // ── Visibility model ───────────────────────────────────────────────────────
  // - admin / god_admin → all accounts
  // - user / viewer     → only their own (profile.linkedin_account_id)
  //
  // We always read with the admin client for fields that v_account_today doesn't
  // expose (proxy_url, warmup, etc.). The visibility filter is enforced in app
  // code below — never trusted to RLS alone, since an account can have user_id=null
  // but still belong to a user via profiles.linkedin_account_id.
  let accountIdFilter: string[] | null = null
  if (!isAdmin) {
    accountIdFilter = myAccountId ? [myAccountId] : []
  }

  let viewQuery = admin.from("v_account_today").select("*")
  if (accountIdFilter !== null) viewQuery = viewQuery.in("account_id", accountIdFilter)
  const { data } = await viewQuery

  const visibleIds = (data ?? []).map((a: any) => a.account_id).filter(Boolean) as string[]
  const { data: rawAccounts } = visibleIds.length
    ? await admin
        .from("linkedin_accounts")
        .select("*")
        .in("id", visibleIds)
        .order("created_at")
    : { data: [] }

  // All profiles for user assignment dropdown (admin only)
  const { data: profiles } = isAdmin
    ? await admin.from("profiles").select("id, email, role").order("email")
    : { data: [] }

  const accounts = data as AccountToday[] ?? []

  const statusColors: Record<string, string> = {
    active:       "bg-green-500/15 text-green-400 border-green-500/30",
    rate_limited: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    banned:       "bg-red-500/15 text-red-400 border-red-500/30",
    disconnected: "bg-gray-500/15 text-gray-400 border-gray-500/30",
  }


  const warmupMeta: Record<string, { icon: string; label: string; cap: string; color: string; bg: string; border: string }> = {
    cold:    { icon: "❄️", label: "Fría",     cap: "máx 5/día",  color: "text-blue-400",   bg: "bg-blue-500/10",   border: "border-blue-500/30" },
    warming: { icon: "🌡️", label: "Tibia",    cap: "máx 12/día", color: "text-yellow-400", bg: "bg-yellow-500/10", border: "border-yellow-500/30" },
    warm:    { icon: "☀️", label: "Cálida",   cap: "máx 20/día", color: "text-orange-400", bg: "bg-orange-500/10", border: "border-orange-500/30" },
    hot:     { icon: "🔥", label: "Caliente", cap: "máx 25/día", color: "text-red-400",    bg: "bg-red-500/10",    border: "border-red-500/30" },
  }

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-50">Cuentas LinkedIn</h1>
        <p className="text-gray-400 text-sm mt-0.5">{accounts.length} cuentas configuradas</p>
      </div>

      {/* Account cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        {accounts.map((a) => {
          const raw = rawAccounts?.find((r: any) => r.id === a.account_id)
          const pct = a.daily_connection_limit
            ? Math.min(Math.round(((a.invites_sent_today ?? 0) + (a.messages_sent_today ?? 0)) / a.daily_connection_limit * 100), 100)
            : 0
          const assignedProfile = profiles?.find((p: any) => p.id === raw?.user_id)
          const ws = warmupMeta[(raw as any)?.warmup_status ?? "cold"] ?? warmupMeta.cold
          const warmupDays = (raw as any)?.warmup_started_at
            ? Math.floor((Date.now() - new Date((raw as any).warmup_started_at).getTime()) / 86400000)
            : null
          return (
            <div key={a.account_id} className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-gray-50 font-semibold">{a.label ?? "Sin etiqueta"}</p>
                  <a href={`/dashboard/accounts/${a.account_id}/config`} className="inline-block text-xs text-blue-400 hover:text-blue-300 mt-0.5">⚙️ Centro de control</a>
                  <p className="text-gray-500 text-xs mt-0.5 truncate max-w-[240px]">
                    {a.linkedin_profile_url ?? "Sin URL"}
                  </p>
                  <p className="text-gray-600 text-xs mt-0.5">
                    {assignedProfile
                      ? <span className="text-blue-400/80">👤 {assignedProfile.email}</span>
                      : <span className="text-gray-600">Sin usuario asignado</span>
                    }
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <span className={`text-xs px-2 py-1 rounded-full border font-medium ${statusColors[a.status ?? ""] ?? statusColors.disconnected}`}>
                    {a.status}
                  </span>
                  <span className={`text-xs px-2 py-1 rounded-full border font-medium ${ws.bg} ${ws.color} ${ws.border}`}>
                    {ws.icon} {ws.label}
                  </span>
                </div>
              </div>

              {/* Usage bar */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-gray-400">
                  <span>{(a.invites_sent_today ?? 0) + (a.messages_sent_today ?? 0)} enviados hoy</span>
                  <span>Límite: {a.daily_connection_limit}/día</span>
                </div>
                <div className="w-full bg-gray-800 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all ${pct >= 90 ? "bg-red-500" : pct >= 60 ? "bg-yellow-500" : "bg-blue-500"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs text-center pt-1">
                  <div className="bg-gray-800/50 rounded px-2 py-1">
                    <div className="text-gray-50 font-medium">{a.invites_sent_today ?? 0}</div>
                    <div className="text-gray-500">Invitaciones</div>
                  </div>
                  <div className="bg-gray-800/50 rounded px-2 py-1">
                    <div className="text-gray-50 font-medium">{a.messages_sent_today ?? 0}</div>
                    <div className="text-gray-500">Mensajes</div>
                  </div>
                  <div className="bg-gray-800/50 rounded px-2 py-1">
                    <div className="text-gray-50 font-medium">{a.errors_today ?? 0}</div>
                    <div className="text-gray-500">Errores</div>
                  </div>
                </div>

                {/* Warmup info */}
                <div className={`rounded-lg px-3 py-2 ${ws.bg} border ${ws.border} flex items-center justify-between`}>
                  <div>
                    <span className={`text-xs font-semibold ${ws.color}`}>{ws.icon} {ws.label} — {ws.cap}</span>
                    {warmupDays !== null && (
                      <span className="text-gray-500 text-xs ml-2">({warmupDays}d en este estado)</span>
                    )}
                  </div>
                  <div className="text-gray-600 text-xs">
                    {(raw as any)?.warmup_status === "cold" && "Calentamiento manual recomendado"}
                    {(raw as any)?.warmup_status === "warming" && "Aumentar 1-2/día cada semana"}
                    {(raw as any)?.warmup_status === "warm" && "Operación normal"}
                    {(raw as any)?.warmup_status === "hot" && "Cuenta veterana"}
                  </div>
                </div>
              </div>


              {/* Extension panel — Sub-Fase 2.6 */}
              <ExtensionPanel
                accountId={a.account_id ?? ""}
                accountLabel={a.label ?? "cuenta"}
                initialApiKey={(raw as any)?.extension_api_key ?? null}
                downloadBaseUrl="http://209.50.63.149/download"
              />

              {/* Activación de onboarding — solo mientras la cuenta no esté activa */}
              {a.status !== "active" && a.account_id && (
                <OnboardingActivatePanel accountId={a.account_id} />
              )}

              {/* Edit form */}
              <details className="group">
                <summary className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer list-none">
                  ✏️ Editar cuenta
                </summary>
                <form action={updateAccount} className="mt-3 space-y-3">
                  <input type="hidden" name="id" value={a.account_id ?? ""} />
                  <Field name="label" label="Etiqueta" defaultValue={raw?.label ?? ""} placeholder="Mi cuenta principal" />
                  <Field name="linkedin_profile_url" label="URL de perfil" defaultValue={raw?.linkedin_profile_url ?? ""} placeholder="https://linkedin.com/in/..." />
                  <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2.5 text-xs text-gray-400">
                    🔑 La cookie de LinkedIn se renueva con el botón <span className="text-blue-400 font-medium">Renovar Cookie</span> arriba.
                    El browser corre en el VPS con el proxy correcto, así LinkedIn emite la cookie ligada a esa IP.
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs text-gray-400 font-medium">Límite diario de conexiones (sin nota)</label>
                    <input type="number" name="daily_connection_limit" min="1" max="30"
                      defaultValue={raw?.daily_connection_limit ?? ""}
                      placeholder={`default por temperatura: ${
                        (raw as any)?.warmup_status === "cold"    ? "5" :
                        (raw as any)?.warmup_status === "warming" ? "12" :
                        (raw as any)?.warmup_status === "hot"     ? "25" : "20"
                      }`}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <p className="text-xs text-gray-600">
                      Vacío = usa cap automático por temperatura ({ws.icon} {ws.label}).
                      Recomendado sin nota: ❄️ 5 · 🌡️ 12 · ☀️ 20 · 🔥 25/día.
                      Máximo seguro absoluto: 20/día (= 100/semana, límite oficial LinkedIn).
                    </p>
                  </div>
                  <Field name="proxy_url" label="Proxy URL (opcional)" defaultValue={raw?.proxy_url ?? ""} placeholder="http://user:pass@host:port" />
                  <Field name="cal_com_url" label="Link de Cal.com" defaultValue={(raw as any)?.cal_com_url ?? ""} placeholder="https://cal.com/josh" />
                  {/* ── Velocidad de respuesta IA ───────────────────────── */}
                  <div className="pt-2 border-t border-gray-700 space-y-2">
                    <div>
                      <p className="text-xs text-gray-400 font-medium mb-0.5">Delay de auto-respuesta IA</p>
                      <p className="text-xs text-gray-600 leading-snug">
                        Vacío = automático por temperatura ({ws.icon} {ws.label}:{" "}
                        {(raw as any)?.warmup_status === "cold"    ? "60-90 min" :
                         (raw as any)?.warmup_status === "warming" ? "25-45 min" :
                         (raw as any)?.warmup_status === "hot"     ? "1-5 min"   : "8-20 min"}).
                        Rellena solo si quieres un override manual.
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Field name="reply_delay_min" label="Mín (minutos)" defaultValue={(raw as any)?.reply_delay_min ?? ""} placeholder="ej: 1" type="number" />
                      <Field name="reply_delay_max" label="Máx (minutos)" defaultValue={(raw as any)?.reply_delay_max ?? ""} placeholder="ej: 3" type="number" />
                    </div>
                  </div>
                  {/* ── Inbox ───────────────────────────────────────────── */}
                  <div className="pt-2 border-t border-gray-700 space-y-2">
                    <p className="text-xs text-gray-400 font-medium">Inbox</p>
                    <Field name="inbox_gap_min" label="Gap entre chequeos de inbox (min)" defaultValue={String((raw as any)?.inbox_gap_min ?? 60)} placeholder="60" type="number" />
                    <p className="text-xs text-gray-600">Mínimo de minutos entre un chequeo de inbox y el siguiente para esta cuenta. Default: 60.</p>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="hidden" name="inbox_paused" value="false" />
                      <input name="inbox_paused" type="checkbox" value="true"
                        defaultChecked={(raw as any)?.inbox_paused ?? false}
                        className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-yellow-500 focus:ring-yellow-500" />
                      <span className="text-sm text-gray-300">⏸ Pausar inbox de esta cuenta</span>
                    </label>
                  </div>

                  {/* ── Mensajes entrantes (Inbound) ─────────────────────── */}
                  <div className="pt-2 border-t border-gray-700 space-y-3">
                    <div>
                      <p className="text-xs text-gray-400 font-medium">📥 Mensajes entrantes</p>
                      <p className="text-xs text-gray-600 mt-0.5">Cuando alguien nos escribe directamente sin que lo hayamos contactado, Gemini lo clasifica y responde automáticamente.</p>
                    </div>

                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="hidden" name="inbound_enabled" value="false" />
                      <input name="inbound_enabled" type="checkbox" value="true"
                        defaultChecked={(raw as any)?.inbound_enabled !== false}
                        className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500" />
                      <span className="text-sm text-gray-300">Activar clasificación de mensajes entrantes</span>
                    </label>

                    <div className="space-y-1">
                      <label className="block text-xs text-gray-400">Modo de respuesta a compradores</label>
                      <select name="inbound_reply_mode" defaultValue={(raw as any)?.inbound_reply_mode ?? "manual"}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option value="manual">Manual — aparece en bandeja para aprobación</option>
                        <option value="semi_auto">Semi-auto — countdown + cancelación</option>
                        <option value="auto">Automático — envía solo tras delay</option>
                      </select>
                      <p className="text-xs text-gray-600">Aplica a leads clasificados como comprador potencial.</p>
                    </div>

                    <div className="space-y-1">
                      <label className="block text-xs text-gray-400">Rechazo para vendedores / recruiters</label>
                      <textarea name="inbound_decline_template" rows={3}
                        defaultValue={(raw as any)?.inbound_decline_template ?? ""}
                        placeholder={`Hola [Nombre], gracias por contactarme. Por ahora no estamos buscando ese tipo de servicio, pero lo tendré en mente. ¡Éxito!`}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                      />
                      <p className="text-xs text-gray-600">Usa <code className="bg-gray-700 px-1 rounded">[Nombre]</code> para personalizar. Vacío = Gemini genera el rechazo automáticamente.</p>
                    </div>

                    <div className="space-y-1">
                      <label className="block text-xs text-gray-400">Reglas de calificación personalizadas (opcional)</label>
                      <textarea name="inbound_qualification_rules" rows={3}
                        defaultValue={(raw as any)?.inbound_qualification_rules ?? ""}
                        placeholder="Deja vacío para usar las reglas por defecto de Gemini. Puedes sobreescribirlas aquí si necesitas criterios específicos para esta cuenta."
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                      />
                      <p className="text-xs text-gray-600">Override del prompt de clasificación de Gemini. Vacío = reglas por defecto.</p>
                    </div>
                  </div>
                  {isAdmin && profiles && profiles.length > 0 && (
                    <div className="space-y-1">
                      <label className="block text-xs text-gray-400">Usuario asignado</label>
                      <select name="assigned_user_id" defaultValue={raw?.user_id ?? ""}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option value="">— Sin asignar —</option>
                        {profiles.map((p: any) => (
                          <option key={p.id} value={p.id}>
                            {p.email} ({p.role})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="space-y-1">
                    <label className="block text-xs text-gray-400">Estado de conexión</label>
                    <select name="status" defaultValue={raw?.status ?? "active"}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="active">active</option>
                      <option value="disconnected">disconnected</option>
                      <option value="rate_limited">rate_limited</option>
                      <option value="banned">banned</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs text-gray-400">Temperatura de cuenta (warmup)</label>
                    <select name="warmup_status" defaultValue={(raw as any)?.warmup_status ?? "cold"}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="cold">❄️ Fría — nueva / sin historial (default: 5/día)</option>
                      <option value="warming">🌡️ Tibia — calentando 1-4 semanas (default: 12/día)</option>
                      <option value="warm">☀️ Cálida — activa 1-3 meses (default: 20/día)</option>
                      <option value="hot">🔥 Caliente — veterana 3+ meses (default: 25/día)</option>
                    </select>
                    <p className="text-gray-600 text-xs">El scheduler respeta este cap independiente del límite de campaña.</p>
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs text-gray-400">Modo de búsqueda / prospección</label>
                    <select name="search_mode" defaultValue={(raw as any)?.search_mode ?? "free"}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="free">🔎 Free — buscador estándar (pool limitado por LinkedIn)</option>
                      <option value="sales_navigator">🧭 Sales Navigator — pool ampliado (solo cuentas Pro)</option>
                    </select>
                    <p className="text-gray-600 text-xs">
                      Marca <b>Sales Navigator</b> solo en cuentas que <b>realmente</b> tengan la suscripción.
                      No cambia el cap de invitaciones (anti-ban) — amplía la prospección.
                      ⚙️ El buscador SalesNav se activa en una fase posterior; por ahora esto solo designa la cuenta.
                    </p>
                  </div>
                  <button type="submit" className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white  text-sm font-medium rounded-lg transition-colors">
                    Guardar cambios
                  </button>
                </form>
              </details>
            </div>
          )
        })}
      </div>

      {/* Add new account — admins only */}
      {isAdmin && (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-6">
          <h2 className="text-gray-50 font-semibold mb-4">+ Agregar cuenta LinkedIn</h2>
          <form action={createAccount} className="space-y-3 max-w-lg">
            <Field name="label" label="Etiqueta" placeholder="Ej: Cuenta Jorge" />
            <Field name="linkedin_profile_url" label="URL de perfil LinkedIn" placeholder="https://linkedin.com/in/..." />
            <Field name="daily_connection_limit" label="Límite diario de invitaciones" defaultValue="20" type="number" />
            <Field name="proxy_url" label="Proxy URL (opcional)" placeholder="http://user:pass@host:port" />
            <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2.5 text-xs text-gray-400">
              🔑 Después de crear la cuenta, usa el botón <span className="text-blue-400 font-medium">Renovar Cookie</span> para iniciar sesión en LinkedIn desde el VPS.
            </div>
            <button type="submit" className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white  text-sm font-semibold rounded-lg transition-colors">
              Agregar cuenta
            </button>
          </form>
        </div>
      )}

      {/* No-account hint for users without an assigned LinkedIn account */}
      {!isAdmin && !myAccountId && (
        <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-xl p-6 text-center">
          <p className="text-yellow-400 text-sm font-medium">No tienes una cuenta de LinkedIn asignada.</p>
          <p className="text-gray-500 text-xs mt-1">Pide a un administrador que te asigne una cuenta.</p>
        </div>
      )}
    </div>
  )
}

function Field({ name, label, defaultValue, placeholder, type = "text" }: {
  name: string; label: string; defaultValue?: string; placeholder?: string; type?: string
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs text-gray-400">{label}</label>
      <input
        type={type} name={name} defaultValue={defaultValue} placeholder={placeholder}
        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  )
}
