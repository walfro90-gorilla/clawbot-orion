// ─────────────────────────────────────────────────────────────────────────────
// Cal.com URL helper — embeds LEAD_ID so the cal-webhook can link bookings
// back to the originating lead.
//
// Cal.com booking URLs accept `metadata[<key>]=<value>` query params, and
// forwards them in the webhook payload under `payload.metadata`. The
// /api/cal-webhook endpoint extracts `metadata.leadId` (along with a few
// other fallbacks) to know which lead booked.
//
// Without this, every booking lands as "no_lead_id" in the webhook and the
// meeting never appears in /dashboard/meetings.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append `?metadata[leadId]=<uuid>` (or `&metadata[leadId]=...`) to a Cal.com
 * link. Idempotent — won't add a duplicate if the URL already has it.
 *
 * @param {string|null|undefined} rawUrl  — base cal.com URL or null
 * @param {string|null|undefined} leadId  — lead UUID
 * @returns {string|null} URL with embedded leadId, or null if no URL passed
 */
export function withLeadIdMetadata(rawUrl, leadId) {
  if (!rawUrl) return null
  if (!leadId) return rawUrl

  try {
    const u = new URL(rawUrl)
    // metadata[leadId] = uuid  (Cal.com convention)
    u.searchParams.set('metadata[leadId]', leadId)
    return u.toString()
  } catch {
    // Not a valid URL — return as-is to avoid breaking the message
    return rawUrl
  }
}
