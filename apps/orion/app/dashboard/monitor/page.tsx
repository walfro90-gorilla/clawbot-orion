import { createAdminClient } from "@/lib/supabase/admin"
import { requireRole } from "@/lib/auth/role"
import { redirect } from "next/navigation"
import { RunNowBtn } from "@/components/run-now-btn"

// ── Server Actions ─────────────────────────────────────────────────────────────

async function toggleCampaignJob(formData: FormData) {
  "use server"
  const db      = createAdminClient()
  const id      = formData.get("campaign_id") as string
  const field   = formData.get("field") as string
  const current = formData.get("current") === "true"
  if (field === "batch_paused") {
    await db.from("campaigns").update({ batch_paused: !current }).eq("id", id)
  } else if (field === "search_paused") {
    await db.from("campaigns").update({ search_paused: !current }).eq("id", id)
  }
  redirect("/dashboard/monitor")
}

async function toggleInbox(formData: FormData) {
  "use server"
  const db = createAdminClient()
  const id      = formData.get("account_id") as string
  const current = formData.get("current") === "true"
  await db.from("linkedin_accounts").update({ inbox_paused: !current }).eq("id", id)
  redirect("/dashboard/monitor")
}

async function toggleFollowup(formData: FormData) {
  "use server"
  const db      = createAdminClient()
  const id      = formData.get("campaign_id") as string
  const current = formData.get("current") === "true"
  await db.from("campaigns").update({ follow_up_paused: !current }).eq("id", id)
  redirect("/dashboard/monitor")
}

async function saveSearchConfig(formData: FormData) {
  "use server"
  const db = createAdminClient()
  const id = formData.get("campaign_id") as string
  await db.from("campaigns").update({
    search_gap_hours:    Number(formData.get("search_gap_hours")),
    min_pending_threshold: Number(formData.get("min_pending_threshold")),
    schedule_start_hour: Number(formData.get("schedule_start_hour")),
    schedule_end_hour:   Number(formData.get("schedule_end_hour")),
  }).eq("id", id)
  redirect("/dashboard/monitor")
}

async function saveBatchConfig(formData: FormData) {
  "use server"
  const db = createAdminClient()
  const id = formData.get("campaign_id") as string
  await db.from("campaigns").update({
    daily_invite_target: Number(formData.get("daily_invite_target")),
    min_batch_gap_min:   Number(formData.get("min_batch_gap_min")),
    schedule_start_hour: Number(formData.get("schedule_start_hour")),
    schedule_end_hour:   Number(formData.get("schedule_end_hour")),
  }).eq("id", id)
  redirect("/dashboard/monitor")
}

async function saveInboxConfig(formData: FormData) {
  "use server"
  const db = createAdminClient()
  const id = formData.get("account_id") as string
  await db.from("linkedin_accounts").update({
    inbox_gap_min: Number(formData.get("inbox_gap_min")),
  }).eq("id", id)
  redirect("/dashboard/monitor")
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function MonitorPage() {
  await requireRole("admin")
  const db = createAdminClient()

  // Datos en paralelo
  const [
    { data: campaigns },
    { data: accounts },
    { data: logs },
    { data: activeAlerts },
  ] = await Promise.all([
    db.from("campaigns").select(`
      id, name, is_active, batch_paused, search_paused, follow_up_paused,
      daily_invite_target, min_batch_gap_min, min_pending_threshold,
      search_gap_hours, schedule_start_hour, schedule_end_hour,
      last_searched_at, last_batch_at, last_followup_at,
      follow_up_message, follow_up_delay_days, linkedin_account_id
    `).order("name"),

    db.from("linkedin_accounts").select(
      "id, label, linkedin_profile_url, status, inbox_paused, inbox_gap_min, last_inbox_check_at"
    ).order("label"),

    db.from("scheduler_log").select(
      "id, job_type, status, skip_reason, leads_sent, leads_found, duration_ms, campaign_id, account_id, created_at, details"
    ).order("created_at", { ascending: false }).limit(100),

    db.from("account_alerts").select(
      "id, alert_type, severity, message, details, auto_paused, resolved_at, resolved_by, created_at, linkedin_account_id, campaign_id"
    ).order("created_at", { ascending: false }).limit(50),
  ])

  // Alertas críticas + pipeline data
  const [
    { count: leadsFailed },
    { count: leadsStale },
    { count: accountsBanned },
    { count: accountsRateLimited },
    { count: repliesNew },
    { count: errorsToday },
    { count: leadsPending },
    { data: pipelineRows },
    { data: followupEligible },
  ] = await Promise.all([
    db.from("leads").select("id", { count: "exact", head: true }).eq("status", "failed"),
    db.from("leads").select("id", { count: "exact", head: true }).eq("status", "invite_sent").lt("sent_at", new Date(Date.now() - 7*24*60*60*1000).toISOString()),
    db.from("linkedin_accounts").select("id", { count: "exact", head: true }).eq("status", "banned"),
    db.from("linkedin_accounts").select("id", { count: "exact", head: true }).eq("status", "rate_limited"),
    db.from("leads").select("id", { count: "exact", head: true }).eq("status", "replied").gt("replied_at", new Date(Date.now() - 24*60*60*1000).toISOString()),
    db.from("scheduler_log").select("id", { count: "exact", head: true }).eq("status", "error").gt("created_at", new Date(Date.now() - 24*60*60*1000).toISOString()),
    db.from("leads").select("id", { count: "exact", head: true }).eq("status", "pending"),
    // Pipeline: use aggregated view — avoids loading all rows into JS
    db.from("v_campaign_stats").select("campaign_id, in_queue, invited, connected, replied, meetings"),
    // Follow-up eligible: connected leads old enough, no follow_up_sent event yet
    db.from("leads")
      .select("id, campaign_id, full_name, sent_at, campaigns!inner(follow_up_delay_days, follow_up_message)")
      .eq("status", "connected")
      .not("campaigns.follow_up_message", "is", null)
      .lte("sent_at", new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()) // at least 3 days, campaigns filter at runtime
      .limit(200),
  ])

  const campMap = Object.fromEntries((campaigns ?? []).map(c => [c.id, c]))
  const accMap  = Object.fromEntries((accounts  ?? []).map(a => [a.id, a]))

  const now = Date.now()
  const minAgo = (iso: string | null) => iso ? Math.round((now - new Date(iso).getTime()) / 60000) : null

  // ── Scheduler heartbeat check ──────────────────────────────────────────────
  const lastTick    = logs?.find(l => l.job_type === "tick")
  const lastTickAt  = lastTick?.created_at ? new Date(lastTick.created_at).getTime() : null
  const tickAgeMins = lastTickAt ? Math.round((now - lastTickAt) / 60000) : null

  // Business hours México City (9–19h Mon–Fri)
  const mxHour = parseInt(new Intl.DateTimeFormat("es-MX", {
    hour: "numeric", hour12: false, timeZone: "America/Mexico_City",
  }).format(new Date()))
  const mxDay = new Intl.DateTimeFormat("es-MX", {
    weekday: "long", timeZone: "America/Mexico_City",
  }).format(new Date()).toLowerCase()
  const isBusinessHours = ["lunes","martes","miércoles","jueves","viernes"].some(d => mxDay.includes(d))
    && mxHour >= 9 && mxHour < 19

  // Alert if scheduler hasn't ticked in 2+ hours during business hours
  const schedulerDead = isBusinessHours && (tickAgeMins === null || tickAgeMins > 120)
  const schedulerWarn = !schedulerDead && isBusinessHours && tickAgeMins !== null && tickAgeMins > 60

  // Health score (include scheduler status)
  const criticalCount = (accountsBanned ?? 0) + (errorsToday ?? 0) + (accountsRateLimited ?? 0) + (schedulerDead ? 1 : 0)
  const health = criticalCount === 0 ? "ok" : criticalCount <= 2 ? "warning" : "critical"

  // Pipeline: pre-aggregated from view — no JS fan-out
  const pipeline: Record<string, { pending: number; invite_sent: number; connected: number; replied: number }> = {}
  for (const row of pipelineRows ?? []) {
    if (!row.campaign_id) continue
    pipeline[row.campaign_id] = {
      pending:     row.in_queue    ?? 0,
      invite_sent: row.invited     ?? 0,
      connected:   row.connected   ?? 0,
      replied:     row.replied     ?? 0,
    }
  }

  // Follow-up eligible: filter by campaign's actual delay_days
  const followupByCampaign: Record<string, number> = {}
  for (const lead of followupEligible ?? []) {
    const cid = lead.campaign_id
    if (!cid) continue
    const camp = lead.campaigns as any
    const delayDays = camp?.follow_up_delay_days ?? 3
    const cutoff = new Date(Date.now() - delayDays * 24 * 60 * 60 * 1000)
    if (new Date(lead.sent_at ?? 0) <= cutoff) {
      followupByCampaign[cid] = (followupByCampaign[cid] ?? 0) + 1
    }
  }

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Monitor del Sistema</h1>
          <p className="text-gray-400 text-sm mt-0.5">Estado en tiempo real de todos los jobs y alertas críticas</p>
        </div>
        <div className={`flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-medium ${
          health === "ok"       ? "bg-green-500/10 border-green-500/30 text-green-400" :
          health === "warning"  ? "bg-yellow-500/10 border-yellow-500/30 text-yellow-400" :
                                  "bg-red-500/10 border-red-500/30 text-red-400"
        }`}>
          <span className={`w-2 h-2 rounded-full animate-pulse ${
            health === "ok" ? "bg-green-400" : health === "warning" ? "bg-yellow-400" : "bg-red-400"
          }`} />
          {health === "ok" ? "Sistema saludable" : health === "warning" ? "Alertas activas" : "Crítico"}
        </div>
      </div>

      {/* ── Scheduler heartbeat banner ──────────────────────────────────────── */}
      {schedulerDead && (
        <div className="flex items-start gap-3 px-5 py-4 bg-red-500/10 border border-red-500/40 rounded-xl text-sm">
          <span className="text-red-400 text-lg shrink-0 mt-0.5">🔴</span>
          <div>
            <p className="text-red-400 font-semibold">
              Scheduler sin actividad — {tickAgeMins !== null ? `último tick hace ${tickAgeMins} min` : "nunca registrado"}
            </p>
            <p className="text-red-400/70 text-xs mt-0.5">
              El scheduler debería tickear cada 20–40 min en horario laboral. Reinicia con <code className="bg-red-900/30 px-1 rounded">pm2 restart prometheus-scheduler</code> si el problema persiste.
            </p>
          </div>
        </div>
      )}
      {schedulerWarn && (
        <div className="flex items-start gap-3 px-5 py-4 bg-yellow-500/10 border border-yellow-500/30 rounded-xl text-sm">
          <span className="text-yellow-400 text-lg shrink-0 mt-0.5">🟡</span>
          <div>
            <p className="text-yellow-400 font-semibold">
              Scheduler lento — último tick hace {tickAgeMins} min
            </p>
            <p className="text-yellow-400/70 text-xs mt-0.5">
              Lo normal es 20–40 min. Puede ser un tick largo (inbox pesado). Si supera 2h se mostrará como crítico.
            </p>
          </div>
        </div>
      )}
      {!schedulerDead && !schedulerWarn && lastTickAt && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-green-500/5 border border-green-500/20 rounded-xl text-xs text-green-400/80">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse shrink-0" />
          Scheduler activo — último tick hace {tickAgeMins} min
          {!isBusinessHours && <span className="text-gray-500 ml-1">(fuera de horario — solo inbox)</span>}
        </div>
      )}

      {/* ── Alertas críticas ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {[
          { label: "Cuentas baneadas",    value: accountsBanned        ?? 0, danger: true,  icon: "🚫" },
          { label: "Rate limited",        value: accountsRateLimited   ?? 0, danger: true,  icon: "⚠️" },
          { label: "Errores hoy",         value: errorsToday           ?? 0, danger: true,  icon: "💥" },
          { label: "Leads fallidos",      value: leadsFailed           ?? 0, danger: true,  icon: "❌" },
          { label: "Inv. estancadas +7d", value: leadsStale            ?? 0, danger: true,  icon: "🕰" },
          { label: "Replies nuevos 24h",  value: repliesNew            ?? 0, danger: false, icon: "💬" },
          { label: "Leads en cola",       value: leadsPending          ?? 0, danger: false, icon: "📋" },
        ].map(({ label, value, danger, icon }) => (
          <div key={label} className={`rounded-xl p-4 border text-center ${
            danger && value > 0
              ? "bg-red-500/10 border-red-500/30"
              : "bg-gray-900 border-gray-800"
          }`}>
            <div className="text-xl mb-1">{icon}</div>
            <div className={`text-2xl font-bold ${danger && value > 0 ? "text-red-400" : "text-white"}`}>
              {value}
            </div>
            <div className="text-gray-500 text-xs mt-0.5 leading-tight">{label}</div>
          </div>
        ))}
      </div>

      {/* ── Pipeline de Leads ─────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-white font-semibold mb-3">Pipeline de Leads por Campaña</h2>
        <div className="space-y-3">
          {(campaigns ?? []).map(c => {
            const p = pipeline[c.id] ?? { pending: 0, invite_sent: 0, connected: 0, replied: 0 }
            const total = p.pending + p.invite_sent + p.connected + p.replied
            const fuEligible = followupByCampaign[c.id] ?? 0
            const acc = accounts?.find(a => a.id === c.linkedin_account_id)
            const lastFollowup = minAgo(c.last_followup_at ?? null)

            const stages = [
              { key: "pending",      label: "En cola",    color: "text-gray-300",   bg: "bg-gray-500",    value: p.pending },
              { key: "invite_sent",  label: "Inv. enviada",color: "text-blue-400",  bg: "bg-blue-500",    value: p.invite_sent },
              { key: "connected",    label: "Conectado",   color: "text-green-400", bg: "bg-green-500",   value: p.connected },
              { key: "replied",      label: "Respondió",   color: "text-orange-400",bg: "bg-orange-500",  value: p.replied },
            ]

            return (
              <div key={c.id} className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${c.is_active ? "bg-green-400" : "bg-gray-600"}`} />
                    <span className="text-white font-medium text-sm">{c.name}</span>
                    {acc && (
                      <span className="text-xs text-gray-500">· {acc.label}</span>
                    )}
                  </div>
                  <span className="text-xs text-gray-500">{total} leads total</span>
                </div>

                {/* Funnel bars */}
                <div className="grid grid-cols-5 gap-2">
                  {stages.map(({ key, label, color, bg, value }) => {
                    const pct = total > 0 ? Math.round(value / total * 100) : 0
                    return (
                      <div key={key} className="space-y-1.5">
                        <div className="flex justify-between items-end">
                          <span className={`text-lg font-bold ${color}`}>{value}</span>
                          {pct > 0 && <span className="text-xs text-gray-600">{pct}%</span>}
                        </div>
                        <div className="w-full bg-gray-800 rounded-full h-1.5">
                          <div className={`h-1.5 rounded-full ${bg}`} style={{ width: `${pct}%` }} />
                        </div>
                        <p className="text-xs text-gray-500 leading-tight">{label}</p>
                      </div>
                    )
                  })}
                </div>

                {/* Follow-up queue indicator */}
                {c.follow_up_message && (
                  <div className={`flex items-center justify-between text-xs rounded-lg px-3 py-2 border ${
                    fuEligible > 0 && !c.follow_up_paused
                      ? "bg-amber-500/10 border-amber-500/30 text-amber-300"
                      : "bg-gray-800/50 border-gray-700/50 text-gray-500"
                  }`}>
                    <div className="flex items-center gap-2">
                      <span>💬 Follow-up</span>
                      {c.follow_up_paused && <span className="text-yellow-500 font-medium">⏸ pausado</span>}
                    </div>
                    <div className="flex items-center gap-4">
                      <span>
                        <span className={fuEligible > 0 ? "text-amber-400 font-semibold" : ""}>{fuEligible}</span>
                        {" "}en cola · delay: {c.follow_up_delay_days ?? 3}d
                      </span>
                      {lastFollowup !== null ? (
                        <span className="text-gray-600">último: hace {lastFollowup}min</span>
                      ) : (
                        <span className="text-gray-600">nunca ejecutado</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Job Controls ─────────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-white font-semibold mb-3">Control de Jobs</h2>
        <div className="space-y-3">
          {(campaigns ?? []).map(c => {
            const acc = accounts?.find(a => a.id === c.linkedin_account_id)
            const lastSearch = minAgo(c.last_searched_at)
            const lastBatch  = minAgo(c.last_batch_at)
            const lastInbox  = minAgo(acc?.last_inbox_check_at ?? null)

            return (
              <div key={c.id} className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                {/* Campaign header */}
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-white font-medium">{c.name}</h3>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      !c.is_active ? "bg-gray-700 text-gray-400" :
                      "bg-green-500/15 text-green-400"
                    }`}>
                      {c.is_active ? "campaña activa" : "campaña inactiva"}
                    </span>
                    {acc && (
                      <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${
                        acc.status === "active"       ? "bg-green-500/15 text-green-400" :
                        acc.status === "rate_limited" ? "bg-yellow-500/15 text-yellow-400" :
                        acc.status === "banned"       ? "bg-red-500/15 text-red-400" :
                                                        "bg-gray-700 text-gray-400"
                      }`}>
                        {acc.label ?? "cuenta"} · {acc.status}
                      </span>
                    )}
                  </div>
                </div>

                {/* Job rows */}
                <div className="space-y-2">

                  {/* SEARCH */}
                  <JobBlock
                    label="🔍 Search"
                    color="purple"
                    paused={c.search_paused}
                    lastRun={lastSearch != null ? `hace ${lastSearch} min` : "nunca"}
                    cooldownMin={lastSearch != null ? Math.max(0, (c.search_gap_hours ?? 20)*60 - lastSearch) : null}
                    runNowBtn={<RunNowBtn jobType="search" campaignId={c.id} color="purple" />}
                    toggleForm={
                      <form action={toggleCampaignJob}>
                        <input type="hidden" name="campaign_id" value={c.id} />
                        <input type="hidden" name="field" value="search_paused" />
                        <input type="hidden" name="current" value={String(c.search_paused)} />
                        <ToggleBtn paused={c.search_paused} />
                      </form>
                    }
                    configForm={
                      <form action={saveSearchConfig} className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 pt-3 border-t border-gray-700/50">
                        <input type="hidden" name="campaign_id" value={c.id} />
                        <ConfigField label="Intervalo (horas)" name="search_gap_hours" value={c.search_gap_hours ?? 20} min={1} max={168} hint="Entre búsquedas" />
                        <ConfigField label="Umbral cola" name="min_pending_threshold" value={c.min_pending_threshold ?? 15} min={1} max={200} hint="Leads mínimos antes de buscar" />
                        <ConfigField label="Hora inicio (0-23)" name="schedule_start_hour" value={c.schedule_start_hour ?? 9} min={0} max={23} hint="Hora MX de inicio" />
                        <ConfigField label="Hora fin (0-23)" name="schedule_end_hour" value={c.schedule_end_hour ?? 19} min={1} max={24} hint="Hora MX de corte" />
                        <div className="col-span-full">
                          <button type="submit" className="px-4 py-1.5 bg-purple-600/30 hover:bg-purple-600/50 text-purple-300 text-xs font-medium rounded-lg border border-purple-500/30 transition-colors">
                            Guardar configuración
                          </button>
                        </div>
                      </form>
                    }
                  />

                  {/* BATCH */}
                  <JobBlock
                    label="📤 Batch"
                    color="blue"
                    paused={c.batch_paused}
                    lastRun={lastBatch != null ? `hace ${lastBatch} min` : "nunca"}
                    cooldownMin={lastBatch != null ? Math.max(0, (c.min_batch_gap_min ?? 120) - lastBatch) : null}
                    runNowBtn={<RunNowBtn jobType="batch" campaignId={c.id} color="blue" />}
                    toggleForm={
                      <form action={toggleCampaignJob}>
                        <input type="hidden" name="campaign_id" value={c.id} />
                        <input type="hidden" name="field" value="batch_paused" />
                        <input type="hidden" name="current" value={String(c.batch_paused)} />
                        <ToggleBtn paused={c.batch_paused} />
                      </form>
                    }
                    configForm={
                      <form action={saveBatchConfig} className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 pt-3 border-t border-gray-700/50">
                        <input type="hidden" name="campaign_id" value={c.id} />
                        <ConfigField label="Inv/día" name="daily_invite_target" value={c.daily_invite_target ?? 8} min={1} max={25} hint="Máx invitaciones diarias" />
                        <ConfigField label="Gap entre batches (min)" name="min_batch_gap_min" value={c.min_batch_gap_min ?? 120} min={30} max={480} hint="Tiempo entre envíos" />
                        <ConfigField label="Hora inicio (0-23)" name="schedule_start_hour" value={c.schedule_start_hour ?? 9} min={0} max={23} hint="Hora MX de inicio" />
                        <ConfigField label="Hora fin (0-23)" name="schedule_end_hour" value={c.schedule_end_hour ?? 19} min={1} max={24} hint="Hora MX de corte" />
                        <div className="col-span-full">
                          <button type="submit" className="px-4 py-1.5 bg-blue-600/30 hover:bg-blue-600/50 text-blue-300 text-xs font-medium rounded-lg border border-blue-500/30 transition-colors">
                            Guardar configuración
                          </button>
                        </div>
                      </form>
                    }
                  />

                  {/* INBOX */}
                  {acc && (
                    <JobBlock
                      label="📬 Inbox"
                      color="teal"
                      paused={acc.inbox_paused}
                      lastRun={lastInbox != null ? `hace ${lastInbox} min` : "nunca"}
                      cooldownMin={lastInbox != null ? Math.max(0, (acc.inbox_gap_min ?? 60) - lastInbox) : null}
                      runNowBtn={<RunNowBtn jobType="inbox" accountId={acc.id} color="teal" />}
                      toggleForm={
                        <form action={toggleInbox}>
                          <input type="hidden" name="account_id" value={acc.id} />
                          <input type="hidden" name="current" value={String(acc.inbox_paused)} />
                          <ToggleBtn paused={acc.inbox_paused} />
                        </form>
                      }
                      configForm={
                        <form action={saveInboxConfig} className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 pt-3 border-t border-gray-700/50">
                          <input type="hidden" name="account_id" value={acc.id} />
                          <ConfigField label="Intervalo inbox (min)" name="inbox_gap_min" value={acc.inbox_gap_min ?? 60} min={15} max={480} hint="Minutos entre revisiones" />
                          <div className="col-span-full">
                            <button type="submit" className="px-4 py-1.5 bg-teal-600/30 hover:bg-teal-600/50 text-teal-300 text-xs font-medium rounded-lg border border-teal-500/30 transition-colors">
                              Guardar configuración
                            </button>
                          </div>
                        </form>
                      }
                    />
                  )}

                  {/* FOLLOW-UP */}
                  {c.follow_up_message && (() => {
                    const lastFU = minAgo(c.last_followup_at ?? null)
                    const fuElig = followupByCampaign[c.id] ?? 0
                    return (
                      <JobBlock
                        label={`💬 Follow-up (${fuElig} en cola)`}
                        color="amber"
                        paused={c.follow_up_paused ?? false}
                        lastRun={lastFU != null ? `hace ${lastFU} min` : "nunca"}
                        cooldownMin={lastFU != null ? Math.max(0, 6*60 - lastFU) : null}
                        runNowBtn={<RunNowBtn jobType="followup" campaignId={c.id} color="amber" />}
                        toggleForm={
                          <form action={toggleFollowup}>
                            <input type="hidden" name="campaign_id" value={c.id} />
                            <input type="hidden" name="current" value={String(c.follow_up_paused ?? false)} />
                            <ToggleBtn paused={c.follow_up_paused ?? false} />
                          </form>
                        }
                        configForm={
                          <div className="mt-3 pt-3 border-t border-gray-700/50 text-xs text-gray-500 space-y-1">
                            <p>Delay configurado: <span className="text-gray-300">{c.follow_up_delay_days ?? 3} días desde invite_sent</span></p>
                            <p>Cap diario: <span className="text-gray-300">8 mensajes/cuenta/día</span></p>
                            <p>Cap por ejecución: <span className="text-gray-300">4 mensajes/run</span></p>
                            <p className="text-gray-600">Edita el mensaje y delay en la página de la campaña.</p>
                          </div>
                        }
                      />
                    )
                  })()}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Alertas de Automatización ────────────────────────────────────────── */}
      {(activeAlerts ?? []).length > 0 && (
        <div>
          <h2 className="text-white font-semibold mb-3">
            Alertas
            <span className="ml-2 text-xs font-normal text-gray-400">
              {(activeAlerts ?? []).filter(a => !a.resolved_at).length} sin resolver ·{" "}
              {(activeAlerts ?? []).filter(a => a.resolved_at).length} resueltas
            </span>
          </h2>
          <div className="space-y-2">
            {(activeAlerts ?? []).map(alert => {
              const severityStyle =
                alert.severity === "critical" ? "border-red-500/40 bg-red-950/40" :
                alert.severity === "warning"  ? "border-yellow-500/40 bg-yellow-950/30" :
                                                "border-blue-500/30 bg-blue-950/20"
              const severityBadge =
                alert.severity === "critical" ? "bg-red-500/20 text-red-300 border-red-500/40" :
                alert.severity === "warning"  ? "bg-yellow-500/20 text-yellow-300 border-yellow-500/40" :
                                                "bg-blue-500/20 text-blue-300 border-blue-500/30"
              const typeIcon: Record<string, string> = {
                captcha: "🤖", rate_limited: "⚠️", banned: "🚫",
                cookie_expiry: "🔑", error_spike: "💥",
              }
              const camp = alert.campaign_id ? campMap[alert.campaign_id] : null
              const acc  = alert.linkedin_account_id ? accMap[alert.linkedin_account_id] : null

              return (
                <div key={alert.id} className={`flex items-start gap-3 p-4 rounded-xl border ${severityStyle} ${alert.resolved_at ? "opacity-50" : ""}`}>
                  <span className="text-xl shrink-0 mt-0.5">{typeIcon[alert.alert_type] ?? "⚠️"}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${severityBadge}`}>
                        {alert.alert_type.replace(/_/g, " ")}
                      </span>
                      {acc && <span className="text-xs text-gray-400">· {acc.label}</span>}
                      {camp && <span className="text-xs text-gray-400">· {camp.name}</span>}
                      {alert.auto_paused && (
                        <span className="text-xs text-orange-400 font-medium">⏸ auto-pausada</span>
                      )}
                      {alert.resolved_at && (
                        <span className="text-xs text-green-400">✓ Resuelta por {alert.resolved_by}</span>
                      )}
                    </div>
                    <p className="text-gray-200 text-sm">{alert.message}</p>
                    <p className="text-gray-500 text-xs mt-1">
                      {new Date(alert.created_at!).toLocaleString("es-MX")}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── System Log ───────────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-white font-semibold mb-3">Log del Sistema</h2>
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-3 text-left">Hora</th>
                  <th className="px-4 py-3 text-left">Job</th>
                  <th className="px-4 py-3 text-left">Estado</th>
                  <th className="px-4 py-3 text-left">Campaña / Cuenta</th>
                  <th className="px-4 py-3 text-left">Resultado</th>
                  <th className="px-4 py-3 text-left">Duración</th>
                  <th className="px-4 py-3 text-left">Detalle</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/60 font-mono">
                {(logs ?? []).map(log => {
                  const camp = log.campaign_id ? campMap[log.campaign_id] : null
                  const acc  = log.account_id  ? accMap[log.account_id]  : null
                  return (
                    <tr key={log.id} className={`hover:bg-gray-800/30 transition-colors ${
                      log.status === "error" ? "bg-red-500/5" : ""
                    }`}>
                      <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">
                        {new Date(log.created_at!).toLocaleString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "2-digit" })}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                          log.job_type === "search"   ? "bg-purple-500/20 text-purple-400" :
                          log.job_type === "batch"    ? "bg-blue-500/20 text-blue-400" :
                          log.job_type === "inbox"    ? "bg-teal-500/20 text-teal-400" :
                          log.job_type === "followup" ? "bg-amber-500/20 text-amber-400" :
                                                        "bg-gray-700 text-gray-400"
                        }`}>
                          {log.job_type}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`${
                          log.status === "error"     ? "text-red-400" :
                          log.status === "completed" || log.status === "ok" ? "text-green-400" :
                          log.status === "skipped"   ? "text-gray-500" :
                          log.status === "started"   ? "text-yellow-400" :
                          log.status === "partial"   ? "text-orange-400" :
                          "text-gray-400"
                        }`}>
                          {log.status === "error" ? "⚠ error" :
                           log.status === "completed" || log.status === "ok" ? "✓ ok" :
                           log.status === "skipped" ? "– skip" :
                           log.status === "started" ? "⟳ iniciado" :
                           log.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-gray-400">
                        {camp?.name ?? acc?.label ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-gray-300">
                        {log.leads_sent   != null ? `↑ ${log.leads_sent} enviados` : ""}
                        {log.leads_found  != null ? `↓ ${log.leads_found} encontrados` : ""}
                        {log.skip_reason && <span className="text-gray-500">{log.skip_reason}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-gray-500">
                        {log.duration_ms != null ? `${(log.duration_ms / 1000).toFixed(1)}s` : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600 max-w-[200px] truncate">
                        {log.details && Object.keys(log.details as object).length > 0
                          ? JSON.stringify(log.details).slice(0, 60)
                          : ""}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Cuentas LinkedIn ─────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-white font-semibold mb-3">Estado de Cuentas LinkedIn</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(accounts ?? []).map(acc => (
            <div key={acc.id} className={`bg-gray-900 border rounded-xl p-4 ${
              acc.status === "banned"       ? "border-red-500/40" :
              acc.status === "rate_limited" ? "border-yellow-500/40" :
                                             "border-gray-800"
            }`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-white font-medium">{acc.label ?? acc.linkedin_profile_url ?? acc.id}</p>
                  <p className="text-gray-500 text-xs mt-0.5">
                    Último inbox: {acc.last_inbox_check_at
                      ? `hace ${minAgo(acc.last_inbox_check_at)} min`
                      : "nunca"}
                  </p>
                </div>
                <span className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
                  acc.status === "active"       ? "bg-green-500/15 text-green-400 border-green-500/30" :
                  acc.status === "rate_limited" ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" :
                  acc.status === "banned"       ? "bg-red-500/15 text-red-400 border-red-500/30" :
                                                  "bg-gray-700 text-gray-400 border-gray-600"
                }`}>
                  {acc.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function JobBlock({ label, color, paused, lastRun, cooldownMin, runNowBtn, toggleForm, configForm }: {
  label: string
  color: "purple" | "blue" | "teal" | "amber"
  paused: boolean
  lastRun: string
  cooldownMin: number | null
  runNowBtn: React.ReactNode
  toggleForm: React.ReactNode
  configForm: React.ReactNode
}) {
  const dotCls = paused ? "bg-yellow-400" : "bg-green-400 animate-pulse"
  const labelCls = { purple: "text-purple-400", blue: "text-blue-400", teal: "text-teal-400", amber: "text-amber-400" }[color]

  return (
    <div className="bg-gray-800/50 rounded-xl overflow-hidden">
      {/* Header row: toggle button + status + expand trigger */}
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={`w-2 h-2 rounded-full shrink-0 ${dotCls}`} />
        <span className={`text-sm font-medium ${labelCls}`}>{label}</span>
        {paused && <span className="text-xs text-yellow-500 bg-yellow-500/10 px-2 py-0.5 rounded-full border border-yellow-500/30">pausado</span>}
        <div className="flex-1" />
        <div className="text-right hidden sm:block mr-3">
          <p className="text-gray-400 text-xs">{lastRun}</p>
          {cooldownMin != null && cooldownMin > 0 && (
            <p className="text-yellow-500 text-xs">cooldown: faltan {cooldownMin} min</p>
          )}
          {(cooldownMin === 0 || cooldownMin === null) && !paused && (
            <p className="text-green-500 text-xs">listo para correr</p>
          )}
        </div>
        {runNowBtn}
        {toggleForm}
      </div>

      {/* Config panel — always visible below */}
      <details className="group">
        <summary className="px-4 py-2 text-xs text-gray-500 hover:text-gray-300 cursor-pointer list-none flex items-center gap-1 border-t border-gray-700/40">
          <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
          Programación y parámetros
        </summary>
        <div className="px-4 pb-4">
          {configForm}
        </div>
      </details>
    </div>
  )
}

function ToggleBtn({ paused }: { paused: boolean }) {
  return (
    <button
      type="submit"
      className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors border whitespace-nowrap ${
        paused
          ? "bg-green-600/20 hover:bg-green-600/40 text-green-400 border-green-500/30"
          : "bg-yellow-600/20 hover:bg-yellow-600/40 text-yellow-400 border-yellow-500/30"
      }`}
    >
      {paused ? "▶ Activar" : "⏸ Pausar"}
    </button>
  )
}

function ConfigField({ label, name, value, min, max, hint }: {
  label: string; name: string; value: number; min: number; max: number; hint?: string
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs text-gray-400 font-medium">{label}</label>
      <input
        name={name}
        type="number"
        min={min}
        max={max}
        defaultValue={value}
        className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {hint && <p className="text-gray-600 text-xs">{hint}</p>}
    </div>
  )
}
