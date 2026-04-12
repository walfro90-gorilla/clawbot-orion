import { createClient } from "@supabase/supabase-js"
import type { Database } from "@clawbot/db-types"

// Service role client — solo usar en Server Actions / Route Handlers
// NUNCA exponer al browser
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set")
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
