import { createAdminClient } from "@/lib/supabase/admin"
import { requireRole, getSessionUser } from "@/lib/auth/role"
import { redirect, notFound } from "next/navigation"
import { CampaignTabs } from "@/components/campaign-tabs"
import { FIELDS, TABS, FIELD_BY_KEY, type ConfigField } from "@/lib/config-fields"
import { validateAccountConfig } from "@/lib/config-validation"
import { PRESETS } from "@/lib/config-presets"
import { FollowupSequenceEditor, type FollowupStep } from "@/components/followup-sequence-editor"
import { DirtyAwareForm } from "@/components/dirty-aware-form"

export const dynamic = "force-dynamic"

const inp = "w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"

// ── Parseo de formData según el tipo del campo ──────────────────────────────
function parseField(f: ConfigField, fd: FormData): any {
  if (f.type === "bool") return fd.get(f.key) === "true"
  if (f.type === "days") return (fd.getAll(f.key) as string[])
  const raw = fd.get(f.key)
  if (raw == null || String(raw).trim() === "") return null
  const s = String(raw).trim()
  if (f.type === "int") return Number.isFinite(Number(s)) ? parseInt(s, 10) : null
  if (f.type === "float") return Number.isFinite(Number(s)) ? Number(s) : null
  if (f.type === "list") return s.split(",").map(x => x.trim()).filter(Boolean)
  return s
}

// ── Server action: guardar config ──────────────────────────────────────────
async function saveAccountConfig(formData: FormData) {
  "use server"
  const admin = createAdminClient() as any
  const user = await getSessionUser()
  const accountId = formData.get("account_id") as string
  const campaignId = (formData.get("campaign_id") as string) || null
  if (!accountId) throw new Error("falta account_id")

  const parsed: Record<string, any> = {}
  for (const f of FIELDS) parsed[f.key] = parseField(f, formData)

  // Validación (bounds numéricos + cross-field). Hard errors bloquean.
  const numeric: Record<string, any> = {}
  for (const f of FIELDS) if (f.type === "int" || f.type === "float") numeric[f.key] = parsed[f.key]
  const result = validateAccountConfig(numeric)
  if (!result.ok) {
    throw new Error("Config inválida → " + result.errors.map(e => `${e.label}: ${e.msg}`).join(" · "))
  }

  // Enrutar a cada store
  const campaignUpd: Record<string, any> = {}
  const accountUpd: Record<string, any> = {}
  const acWrites: { key: string; value: any }[] = []
  const acDeletes: string[] = []
  for (const f of FIELDS) {
    const v = parsed[f.key]
    if (f.store === "campaign") campaignUpd[f.key] = v
    else if (f.store === "account") accountUpd[f.key] = v
    else {
      if (v == null || (Array.isArray(v) && v.length === 0)) acDeletes.push(f.key)
      else acWrites.push({ key: f.key, value: v })
    }
  }

  if (campaignId && Object.keys(campaignUpd).length) {
    const { error } = await admin.from("campaigns").update(campaignUpd).eq("id", campaignId)
    if (error) throw new Error("campaigns: " + error.message)
  }

  // v0.8 FU dinámico: reemplazar la secuencia de seguimientos (tabla campaign_followups).
  // El editor envía followup_steps_json (siempre presente cuando hay campaña, porque
  // CampaignTabs mantiene todos los tabs en el DOM). Renumeramos 1..N por posición.
  const fuJson = formData.get("followup_steps_json")
  if (campaignId && typeof fuJson === "string" && fuJson.length > 0) {
    let parsed: any[] = []
    try { parsed = JSON.parse(fuJson) } catch { parsed = [] }
    const clean = parsed
      .filter((s: any) => (s?.message && String(s.message).trim()) || Number(s?.delay_value) > 0)
      .slice(0, 30)
      .map((s: any, i: number) => ({
        campaign_id:  campaignId,
        step:         i + 1,
        message:      s?.message && String(s.message).trim() ? String(s.message) : null,
        delay_value:  Number.isFinite(Number(s?.delay_value)) ? Number(s.delay_value) : 0,
        delay_unit:   s?.delay_unit === "days" ? "days" : "hours",
        jitter_hours: Number.isFinite(Number(s?.jitter_hours)) ? Number(s.jitter_hours) : 0,
        enabled:      s?.enabled !== false,
      }))
    await admin.from("campaign_followups").delete().eq("campaign_id", campaignId)
    if (clean.length) {
      const { error: fuErr } = await admin.from("campaign_followups").insert(clean)
      if (fuErr) throw new Error("campaign_followups: " + fuErr.message)
    }
    // Compat: espejar el paso 1 a las columnas legacy (monitor/next-actions las leen para el forecast de FU1)
    const s1 = clean.find(s => s.step === 1)
    await admin.from("campaigns").update({
      follow_up_message:     s1?.message ?? null,
      follow_up_delay_days:  s1 && s1.delay_unit === "days"  ? s1.delay_value : null,
      follow_up_delay_hours: s1 && s1.delay_unit === "hours" ? s1.delay_value : null,
    }).eq("id", campaignId)
    await admin.from("account_config_audit").insert({
      account_id: accountId, actor_id: user?.id ?? null, actor_email: user?.email ?? null,
      key: "followup_sequence", payload_after: { steps: clean.length }, source: "manual",
    })
  }

  // Template de mensaje (foldeado al Centro — upsert por template_id o campaign_id)
  if (campaignId && (formData.get("template_present") === "1")) {
    const templateId = (formData.get("template_id") as string) || null
    const tPayload: Record<string, any> = {
      campaign_id: campaignId,
      name: (formData.get("template_name") as string) || "Template principal",
      tone: (formData.get("template_tone") as string) || "casual",
      language: (formData.get("template_language") as string) || "es",
      max_chars: Number(formData.get("max_chars") || 150),
      qualification_rules: (formData.get("qualification_rules") as string) || null,
      message_rules: (formData.get("message_rules") as string) || null,
      opening_hint: (formData.get("opening_hint") as string) || null,
      example_good: (formData.get("example_good") as string) || null,
      example_bad: (formData.get("example_bad") as string) || null,
      is_active: true, updated_at: new Date().toISOString(),
    }
    if (templateId && templateId.length > 0) await admin.from("message_templates").update(tPayload).eq("id", templateId)
    else await admin.from("message_templates").insert(tPayload)
  }
  if (Object.keys(accountUpd).length) {
    const { error } = await admin.from("linkedin_accounts").update(accountUpd).eq("id", accountId)
    if (error) throw new Error("linkedin_accounts: " + error.message)
  }
  for (const w of acWrites) {
    const { data: prev } = await admin.from("account_config").select("value").eq("account_id", accountId).eq("key", w.key).maybeSingle()
    const before = prev?.value ?? null
    if (JSON.stringify(before) === JSON.stringify(w.value)) continue // sin cambio → no audit ruido
    await admin.from("account_config").upsert({
      account_id: accountId, key: w.key, value: w.value, locked: true, source: "manual",
      updated_by: user?.email ?? "admin", updated_at: new Date().toISOString(), previous_value: before,
    }, { onConflict: "account_id,key" })
    await admin.from("account_config_audit").insert({
      account_id: accountId, actor_id: user?.id ?? null, actor_email: user?.email ?? null,
      key: w.key, payload_before: before, payload_after: w.value, source: "manual",
    })
  }
  for (const k of acDeletes) {
    await admin.from("account_config").delete().eq("account_id", accountId).eq("key", k)
  }
  redirect(`/dashboard/accounts/${accountId}/config?saved=1`)
}

// ── Server action: aplicar preset (respeta locks) ──────────────────────────
async function applyPreset(formData: FormData) {
  "use server"
  const admin = createAdminClient() as any
  const user = await getSessionUser()
  const accountId = formData.get("account_id") as string
  const campaignId = (formData.get("campaign_id") as string) || null
  const presetKey = formData.get("preset") as string
  const preset = PRESETS[presetKey]
  if (!accountId || !preset) throw new Error("preset inválido")

  // keys ya fijadas (locked) → se respetan (no se sobreescriben)
  const { data: locked } = await admin.from("account_config").select("key").eq("account_id", accountId).eq("locked", true)
  const lockedSet = new Set((locked ?? []).map((r: any) => r.key))

  const campaignUpd: Record<string, any> = {}
  const accountUpd: Record<string, any> = {}
  for (const [key, value] of Object.entries(preset.values)) {
    if (lockedSet.has(key)) continue
    const f = FIELD_BY_KEY[key]
    if (!f) continue
    if (f.store === "campaign") campaignUpd[key] = value
    else if (f.store === "account") accountUpd[key] = value
    else {
      await admin.from("account_config").upsert({
        account_id: accountId, key, value, locked: true, source: `preset:${presetKey}`,
        updated_by: user?.email ?? "admin", updated_at: new Date().toISOString(),
      }, { onConflict: "account_id,key" })
    }
  }
  if (campaignId && Object.keys(campaignUpd).length) await admin.from("campaigns").update(campaignUpd).eq("id", campaignId)
  if (Object.keys(accountUpd).length) await admin.from("linkedin_accounts").update(accountUpd).eq("id", accountId)
  await admin.from("account_config_audit").insert({
    account_id: accountId, actor_id: user?.id ?? null, actor_email: user?.email ?? null,
    key: `preset:${presetKey}`, payload_after: preset.values, source: `preset:${presetKey}`,
    reason: `Preset ${preset.label} aplicado (respetando ${lockedSet.size} keys fijadas)`,
  })
  redirect(`/dashboard/accounts/${accountId}/config?preset=${presetKey}`)
}

// ── Server action: pausar/reanudar campaña ─────────────────────────────────
async function toggleCampaignPause(formData: FormData) {
  "use server"
  const admin = createAdminClient() as any
  const accountId = formData.get("account_id") as string
  const campaignId = formData.get("campaign_id") as string
  const paused = formData.get("paused") === "true"  // estado nuevo
  if (!campaignId) return
  await admin.from("campaigns").update({ batch_paused: paused, search_paused: paused, follow_up_paused: paused }).eq("id", campaignId)
  redirect(`/dashboard/accounts/${accountId}/config?campaign=${campaignId}`)
}

// ── Resolución de valor + origen para display ──────────────────────────────
function resolve(f: ConfigField, account: any, campaign: any, acMap: Record<string, any>, global: Record<string, any>) {
  if (f.store === "campaign") return { value: campaign?.[f.key], source: "Campaña" }
  if (f.store === "account") return { value: account?.[f.key], source: "Cuenta" }
  if (f.key in acMap) return { value: acMap[f.key], source: "Override 🔒" }
  if (f.key in global) return { value: global[f.key], source: "Global" }
  return { value: undefined, source: "Default" }
}

function FieldInput({ f, value }: { f: ConfigField; value: any }) {
  const name = f.key
  if (f.type === "bool")
    return <select name={name} defaultValue={String(!!value)} className={inp}><option value="true">Sí</option><option value="false">No</option></select>
  if (f.type === "enum")
    return <select name={name} defaultValue={value ?? f.options?.[0]?.value} className={inp}>{f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
  if (f.type === "days") {
    const sel: string[] = Array.isArray(value) ? value : []
    return <div className="flex flex-wrap gap-1.5">{f.options?.map(o => (
      <label key={o.value} className="flex items-center gap-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-300 cursor-pointer">
        <input type="checkbox" name={name} value={o.value} defaultChecked={sel.includes(o.value)} className="accent-blue-500" />{o.label}
      </label>))}</div>
  }
  if (f.type === "textarea")
    return <textarea name={name} defaultValue={value ?? ""} rows={3} className={inp} />
  if (f.type === "list")
    return <input name={name} defaultValue={Array.isArray(value) ? value.join(", ") : (value ?? "")} className={inp} placeholder="coma, separado" />
  // int / float / text
  return <input name={name} type={f.type === "text" ? "text" : "number"} step={f.type === "float" ? "0.05" : "1"}
    defaultValue={value ?? ""} className={inp} />
}

export default async function AccountConfigPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  await requireRole("god_admin")
  const { id } = await params
  const sp = await searchParams
  const admin = createAdminClient() as any

  const { data: account } = await admin.from("linkedin_accounts").select("*").eq("id", id).maybeSingle()
  if (!account) notFound()
  // Todas las campañas de la cuenta (campañas anidadas) + selección por ?campaign=
  const { data: campaigns } = await admin.from("campaigns").select("*").eq("linkedin_account_id", id).order("is_active", { ascending: false }).order("created_at", { ascending: false })
  const selectedCampaignId = sp.campaign || (campaigns ?? []).find((c: any) => c.is_active)?.id || (campaigns ?? [])[0]?.id || null
  const campaign = (campaigns ?? []).find((c: any) => c.id === selectedCampaignId) ?? null
  // Template de mensaje del campaign seleccionado (foldeado al Centro — tabla message_templates)
  let template: any = null
  if (campaign) {
    const { data: tmpls } = await admin.from("message_templates").select("*").eq("campaign_id", campaign.id).eq("is_active", true).limit(1)
    template = (tmpls ?? [])[0] ?? null
  }
  // v0.8 FU dinámico: secuencia de seguimientos (1..20) desde campaign_followups
  let fuSteps: FollowupStep[] = []
  if (campaign) {
    const { data: fuRows } = await admin
      .from("campaign_followups")
      .select("step, message, delay_value, delay_unit, jitter_hours, enabled")
      .eq("campaign_id", campaign.id)
      .order("step", { ascending: true })
    fuSteps = (fuRows ?? []).map((r: any) => ({
      message:      r.message ?? "",
      delay_value:  Number(r.delay_value ?? 0),
      delay_unit:   r.delay_unit === "days" ? "days" : "hours",
      jitter_hours: Number(r.jitter_hours ?? 0),
      enabled:      r.enabled !== false,
    }))
  }
  const { data: acRows } = await admin.from("account_config").select("key, value, locked, source, updated_at").eq("account_id", id)
  const acMap: Record<string, any> = {}
  for (const r of acRows ?? []) acMap[r.key] = r.value
  const { data: gRows } = await admin.from("runtime_config").select("key, value")
  const global: Record<string, any> = {}
  for (const r of gRows ?? []) global[r.key] = r.value
  const { data: audit } = await admin.from("account_config_audit").select("key, actor_email, source, created_at, payload_after").eq("account_id", id).order("created_at", { ascending: false }).limit(8)

  const tabChildren = TABS.map(tab => (
    <div key={tab.key} className="space-y-4">
      <div className="grid md:grid-cols-2 gap-4">
        {FIELDS.filter(f => f.tab === tab.key).map(f => {
          const { value, source } = resolve(f, account, campaign, acMap, global)
          const srcColor = source.startsWith("Override") ? "text-amber-400 bg-amber-500/10" : source === "Global" ? "text-sky-400 bg-sky-500/10" : source === "Default" ? "text-gray-500 bg-gray-700/30" : "text-gray-400 bg-gray-700/30"
          const full = f.type === "textarea" || f.type === "days" || f.type === "list"
          return (
            <div key={f.key} className={full ? "md:col-span-2" : ""}>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-gray-300">{f.label}{f.autoTuned && <span className="ml-1 text-purple-400" title="Auto-tuneado por el sistema; tu valor lo fija (lock)">🧬</span>}</label>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${srcColor}`}>{source}</span>
              </div>
              <FieldInput f={f} value={value} />
              {f.hint && <p className="text-[11px] text-gray-600 mt-0.5">{f.hint}</p>}
            </div>
          )
        })}
      </div>
      {tab.key === "seguimientos" && campaign && (
        <div className="mt-2 pt-4 border-t border-gray-800">
          <FollowupSequenceEditor initialSteps={fuSteps} />
        </div>
      )}
      {tab.key === "ia" && campaign && (
        <div className="mt-2 pt-4 border-t border-gray-800 space-y-3">
          <input type="hidden" name="template_present" value="1" />
          {template?.id && <input type="hidden" name="template_id" value={template.id} />}
          <h3 className="text-sm font-semibold text-gray-200">📝 Template de mensaje (reglas de generación IA)</h3>
          <div className="grid md:grid-cols-2 gap-4">
            <div><label className="text-xs text-gray-300">Nombre del template</label><input name="template_name" defaultValue={template?.name ?? "Template principal"} className={inp} /></div>
            <div><label className="text-xs text-gray-300">Máx. caracteres</label><input name="max_chars" type="number" defaultValue={template?.max_chars ?? 150} className={inp} /></div>
            <div><label className="text-xs text-gray-300">Tono del template</label><select name="template_tone" defaultValue={template?.tone ?? "casual"} className={inp}><option value="casual">Casual</option><option value="professional">Profesional</option><option value="executive">Ejecutivo</option><option value="technical">Técnico</option></select></div>
            <div><label className="text-xs text-gray-300">Idioma</label><input name="template_language" defaultValue={template?.language ?? "es"} className={inp} /></div>
            <div className="md:col-span-2"><label className="text-xs text-gray-300">Reglas de calificación</label><textarea name="qualification_rules" rows={2} defaultValue={template?.qualification_rules ?? ""} className={inp} /></div>
            <div className="md:col-span-2"><label className="text-xs text-gray-300">Reglas del mensaje</label><textarea name="message_rules" rows={2} defaultValue={template?.message_rules ?? ""} className={inp} /></div>
            <div className="md:col-span-2"><label className="text-xs text-gray-300">Hint de apertura</label><input name="opening_hint" defaultValue={template?.opening_hint ?? ""} className={inp} /></div>
            <div><label className="text-xs text-gray-300">Ejemplo bueno ✅</label><textarea name="example_good" rows={2} defaultValue={template?.example_good ?? ""} className={inp} /></div>
            <div><label className="text-xs text-gray-300">Ejemplo malo ❌</label><textarea name="example_bad" rows={2} defaultValue={template?.example_bad ?? ""} className={inp} /></div>
          </div>
        </div>
      )}
    </div>
  ))

  return (
    <div className="p-8 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-50">Centro de Control · {account.label}</h1>
          <p className="text-gray-400 text-sm mt-0.5">Configuración consolidada del agente IA para esta cuenta (god_admin)</p>
        </div>
        <a href="/dashboard/accounts" className="text-sm text-gray-400 hover:text-gray-200">← Cuentas</a>
      </div>

      {sp.saved && <div className="px-4 py-2.5 bg-emerald-500/10 border border-emerald-500/40 rounded-lg text-sm text-emerald-300">✅ Configuración guardada.</div>}
      {sp.preset && <div className="px-4 py-2.5 bg-emerald-500/10 border border-emerald-500/40 rounded-lg text-sm text-emerald-300">✅ Preset <strong>{PRESETS[sp.preset]?.label}</strong> aplicado (respetando keys fijadas).</div>}
      {!campaign && <div className="px-4 py-2.5 bg-amber-500/10 border border-amber-500/40 rounded-lg text-sm text-amber-300">⚠️ Esta cuenta no tiene campaña activa — los campos de campaña (búsqueda/FU/IA) no se guardarán hasta que cree una.</div>}

      {/* Presets */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-gray-200 mb-1">🎚️ Presets anti-ban</h2>
        <p className="text-xs text-gray-500 mb-3">Aplica un bundle seguro con 1 click. Respeta los campos ya fijados (🔒).</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {Object.entries(PRESETS).map(([key, p]) => (
            <form key={key} action={applyPreset}>
              <input type="hidden" name="account_id" value={account.id} />
              <input type="hidden" name="campaign_id" value={campaign?.id ?? ""} />
              <input type="hidden" name="preset" value={key} />
              <button type="submit" className="w-full text-left p-3 bg-gray-800/50 hover:bg-gray-800 border border-gray-700 hover:border-emerald-700 rounded-lg transition-colors">
                <div className="text-sm font-semibold text-gray-100">{p.emoji} {p.label}</div>
                <div className="text-[11px] text-gray-500 mt-0.5">{p.desc}</div>
              </button>
            </form>
          ))}
        </div>
      </div>

      {/* Selector de campañas (campañas anidadas dentro de la cuenta) */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-200">🎯 Campañas de esta cuenta</h2>
          <a href="/dashboard/campaigns/new" className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-white font-medium">➕ Nueva campaña</a>
        </div>
        {(campaigns ?? []).length === 0 ? (
          <p className="text-xs text-gray-500">Sin campañas. Crea una para configurar búsqueda / seguimientos / IA.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {(campaigns ?? []).map((c: any) => {
              const sel = c.id === campaign?.id
              const paused = c.batch_paused && c.search_paused && c.follow_up_paused
              return (
                <a key={c.id} href={`/dashboard/accounts/${account.id}/config?campaign=${c.id}`}
                  className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${sel ? "bg-blue-600/20 border-blue-500 text-blue-200" : "bg-gray-800/50 border-gray-700 text-gray-400 hover:text-gray-200"}`}>
                  {c.is_active ? "🟢" : "⚪"} {c.name ?? "Sin nombre"}{paused ? " ⏸️" : ""}
                </a>
              )
            })}
          </div>
        )}
        {campaign && (
          <div className="mt-3 flex items-center gap-3">
            <span className="text-xs text-gray-500">Editando abajo: <strong className="text-gray-300">{campaign.name}</strong></span>
            <form action={toggleCampaignPause} className="inline">
              <input type="hidden" name="account_id" value={account.id} />
              <input type="hidden" name="campaign_id" value={campaign.id} />
              <input type="hidden" name="paused" value={String(!(campaign.batch_paused && campaign.search_paused && campaign.follow_up_paused))} />
              <button type="submit" className="text-xs px-2.5 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-300">
                {(campaign.batch_paused && campaign.search_paused && campaign.follow_up_paused) ? "▶️ Reanudar campaña" : "⏸️ Pausar campaña"}
              </button>
            </form>
            <a href={`/dashboard/campaigns/${campaign.id}/edit`} className="text-xs px-2.5 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-400 hover:text-gray-200">🗑️ Eliminar / reasignar</a>
          </div>
        )}
      </div>

      {/* Form principal: 🧱 Operación + Anti-ban = CUENTA · 🔍 Búsqueda + 💬 Seguimientos + 🧠 IA = CAMPAÑA seleccionada */}
      <DirtyAwareForm
        action={saveAccountConfig}
        footerClassName="sticky bottom-0 mt-6 -mx-8 px-8 py-3 bg-gray-950/90 backdrop-blur border-t border-gray-800 flex items-center gap-3"
        footerExtra={<p className="text-xs text-gray-500 mr-auto">Vaciar un campo de &quot;Anti-ban avanzado&quot; lo revierte al valor global (reactiva auto-learning).</p>}
      >
        <input type="hidden" name="account_id" value={account.id} />
        <input type="hidden" name="campaign_id" value={campaign?.id ?? ""} />
        <CampaignTabs tabs={TABS.map(t => ({ key: t.key, label: t.label, icon: "" }))} defaultTab="operacion">
          {tabChildren}
        </CampaignTabs>
      </DirtyAwareForm>

      {/* Auditoría */}
      {audit && audit.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-gray-200 mb-3">📜 Últimos cambios</h2>
          <div className="space-y-1.5">
            {audit.map((a: any, i: number) => (
              <div key={i} className="flex items-center gap-3 text-xs text-gray-400">
                <span className="text-gray-600 w-32 shrink-0">{new Date(a.created_at).toLocaleString("es-MX", { timeZone: "America/Mexico_City", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                <span className="text-gray-300 font-mono">{a.key}</span>
                <span className="text-gray-600">por {a.actor_email ?? "?"}</span>
                {a.source?.startsWith("preset") && <span className="text-emerald-400/70">({a.source})</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
