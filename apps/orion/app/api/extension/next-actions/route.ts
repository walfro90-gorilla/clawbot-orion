export const runtime = "nodejs"

import { NextRequest, NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { classifyCommandError } from "@/lib/error-class"

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-orion-api-key",
}
export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }) }

// GET /api/extension/next-actions?accountId=<uuid>
// Returns: { next_inbox_check, next_fu_due, next_search, next_batch, summary }
// El popup lo polea cada 30s para mostrar countdown.
export async function GET(req: NextRequest) {
  const accountId = req.nextUrl.searchParams.get("accountId")
  const apiKey = req.headers.get("x-orion-api-key") ?? req.nextUrl.searchParams.get("apiKey")
  if (!accountId || !apiKey) {
    return NextResponse.json({ error: "accountId+apiKey required" }, { status: 400, headers: CORS })
  }
  const admin = createAdminClient() as any
  const { data: account } = await admin
    .from("linkedin_accounts")
    .select("id, label, extension_api_key, inbox_gap_min, last_inbox_check_at")
    .eq("id", accountId)
    .single()
  if (!account || account.extension_api_key !== apiKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: CORS })
  }

  // Campaign data (puede haber múltiples; tomamos active)
  const { data: campaigns } = await admin
    .from("campaigns")
    .select("id, name, last_searched_at, search_gap_hours, last_batch_at, min_batch_gap_min, follow_up_delay_hours, follow_up_delay_days, daily_invite_target")
    .eq("linkedin_account_id", accountId)
    .eq("is_active", true)

  const camp = campaigns?.[0]
  const now = Date.now()

  // Next inbox check
  const inboxGapMs = (account.inbox_gap_min ?? 60) * 60_000
  const lastInbox = account.last_inbox_check_at ? new Date(account.last_inbox_check_at).getTime() : 0
  const nextInbox = lastInbox + inboxGapMs

  // Next search
  let nextSearch = null
  if (camp) {
    const lastSearch = camp.last_searched_at ? new Date(camp.last_searched_at).getTime() : 0
    nextSearch = lastSearch + (camp.search_gap_hours ?? 12) * 3600_000
  }

  // Next batch
  let nextBatch = null
  if (camp) {
    const lastBatch = camp.last_batch_at ? new Date(camp.last_batch_at).getTime() : 0
    nextBatch = lastBatch + (camp.min_batch_gap_min ?? 45) * 60_000
  }

  // Next FU due (FU1 most urgent)
  let nextFuDue = null
  let nextFuLead = null
  if (camp) {
    const fu1Hours = camp.follow_up_delay_hours ?? (camp.follow_up_delay_days ?? 1) * 24
    const { data: connected } = await admin
      .from("leads")
      .select("id, full_name, connected_at")
      .eq("campaign_id", camp.id)
      .eq("status", "connected")
      .is("last_followup_at", null)
      .not("connected_at", "is", null)
      .order("connected_at", { ascending: true })
      .limit(1)
    const lead = connected?.[0]
    if (lead?.connected_at) {
      const due = new Date(lead.connected_at).getTime() + fu1Hours * 3600_000
      nextFuDue = due
      nextFuLead = lead.full_name
    }
  }

  // Contadores del popup — agregados sobre TODAS las campañas activas de la cuenta.
  const campaignIds = (campaigns ?? []).map((c: any) => c.id)
  let pendingReplyCount = 0  // 💬 mensajes GENUINAMENTE por contestar (ver abajo)
  let fuDueNow = 0           // 📤 seguimientos listos (connected sin FU1 aún)
  let errorsRecent = 0       // ⚠️ fallas reales (fault) últimas 3h
  if (campaignIds.length) {
    // 💬 'replied' es un bucket SEMI-PERSISTENTE: tras auto-responder, el lead SIGUE en
    // 'replied' (el envío usa kind:'reply', que no cambia status). Contar el status crudo
    // infla el badge — típico 19/20 ya contestados. Contamos solo los sin responder de
    // verdad: último inbound (≈ replied_at) MÁS NUEVO que el último outbound del hilo.
    const since30d = new Date(now - 30 * 86_400_000).toISOString()
    const convIdOf = (r: any) => Array.isArray(r.conversations) ? r.conversations[0]?.id : r.conversations?.id
    const [repRes, fuRes] = await Promise.all([
      admin.from("leads")
        .select("id, replied_at, conversations!inner(id)")
        .in("campaign_id", campaignIds).eq("status", "replied")
        .eq("automation_paused", false).is("quarantined_at", null)
        .gte("replied_at", since30d),
      admin.from("leads").select("id", { count: "exact", head: true })
        .in("campaign_id", campaignIds).eq("status", "connected").is("last_followup_at", null),
    ])
    fuDueNow = fuRes.count ?? 0
    const rows = (repRes.data ?? []) as any[]
    const convIds = rows.map(convIdOf).filter(Boolean)
    const lastOutAt = new Map<string, number>()
    if (convIds.length) {
      const { data: outs } = await admin
        .from("conversation_events")
        .select("conversation_id, sent_at")
        .in("conversation_id", convIds).eq("direction", "outbound")
        .order("sent_at", { ascending: false })
      for (const e of (outs ?? []) as any[]) {
        if (!lastOutAt.has(e.conversation_id)) lastOutAt.set(e.conversation_id, new Date(e.sent_at).getTime())
      }
    }
    pendingReplyCount = rows.filter((r) => {
      const inAt = r.replied_at ? new Date(r.replied_at).getTime() : 0
      const cid = convIdOf(r)
      return inAt > (cid ? (lastOutAt.get(cid) ?? 0) : 0)
    }).length
  }
  const since3h = new Date(now - 3 * 3600_000).toISOString()
  const { data: recentErrs } = await admin
    .from("extension_commands")
    .select("err:result->>error")
    .eq("account_id", accountId).eq("status", "error").gte("created_at", since3h)
  errorsRecent = (recentErrs ?? []).filter((r: any) => classifyCommandError(r.err, "error").isFault).length

  // Lo más cercano = "next_any"
  const candidates = [
    { type: "inbox_check", at: nextInbox, label: `📥 Inbox check` },
    nextSearch ? { type: "search", at: nextSearch, label: `🔍 Search` } : null,
    nextBatch ? { type: "invites_batch", at: nextBatch, label: `📨 Invites batch` } : null,
    nextFuDue ? { type: "fu_due", at: nextFuDue, label: `📤 FU1 → ${nextFuLead}` } : null,
  ].filter(Boolean) as Array<{ type: string; at: number; label: string }>
  const future = candidates.filter(c => c.at > now).sort((a, b) => a.at - b.at)
  const next_any = future[0] ?? null

  // Roster COMPLETO de agentes (NO filtrado a futuro) — el popup lo pinta SIEMPRE como fila de
  // agentes. Cada uno: at (próxima corrida, ts o null) + note/count. El popup deriva el estado
  // (ahora / en Xmin / N pendientes / idle). Esto arregla la "fila FIFO" que salía vacía porque
  // sorted_upcoming solo traía las acciones futuras (0-1 casi siempre).
  const roster = [
    { key: "inbox_check",   icon: "📥", label: "Inbox",        at: nextInbox },
    { key: "search",        icon: "🔍", label: "Búsqueda",     at: nextSearch },
    { key: "invites_batch", icon: "📨", label: "Invitaciones", at: nextBatch },
    { key: "fu_due",        icon: "📤", label: "Follow-ups",   at: nextFuDue, note: nextFuLead ?? null, count: fuDueNow },
    { key: "auto_reply",    icon: "💬", label: "Auto-reply",   at: null, count: pendingReplyCount },
  ]

  return NextResponse.json({
    account: { label: account.label },
    now: now,
    next_inbox_check_at: nextInbox,
    next_search_at: nextSearch,
    next_batch_at: nextBatch,
    next_fu_due_at: nextFuDue,
    next_fu_lead: nextFuLead,
    next_any,
    pending_replies: pendingReplyCount,
    fu_due_now: fuDueNow,
    errors_recent: errorsRecent,
    sorted_upcoming: future.slice(0, 4),
    roster,
  }, { headers: CORS })
}
