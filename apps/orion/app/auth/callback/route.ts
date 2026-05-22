import { createClient } from "@/lib/supabase/server"
import { NextResponse } from "next/server"

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code  = searchParams.get("code")
  const next  = searchParams.get("next")   // ej: /reset-password (recovery)
  const error = searchParams.get("error_description") ?? searchParams.get("error")

  // Auth error explícito del provider (link expirado, token mal formado, etc.)
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error)}`)
  }

  if (code) {
    const supabase = await createClient()
    const { error: exchangeErr } = await supabase.auth.exchangeCodeForSession(code)
    if (exchangeErr) {
      return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(exchangeErr.message)}`)
    }
  }

  // Solo permitir paths internos como `next` (no URLs absolutas → previene open redirect)
  const target = next && next.startsWith("/") ? next : "/dashboard"
  return NextResponse.redirect(`${origin}${target}`)
}
