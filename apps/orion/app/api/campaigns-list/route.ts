import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getSessionUser } from "@/lib/auth/role"

export async function GET() {
  const supabase = await createClient()
  const me = await getSessionUser()
  if (!me) return NextResponse.json([], { status: 401 })

  let query = supabase
    .from("campaigns")
    .select("id, name, linkedin_account_id")
    .eq("is_active", true)
    .order("name")

  // For restricted users, filter by their account
  if ((me.role === "user" || me.role === "viewer") && me.linkedin_account_id) {
    query = query.eq("linkedin_account_id", me.linkedin_account_id) as typeof query
  }

  const { data } = await query
  return NextResponse.json(data ?? [])
}
