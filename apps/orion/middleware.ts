import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const isAuthRoute = request.nextUrl.pathname.startsWith("/login")
  const isPublicRoute = request.nextUrl.pathname === "/"
  // Public endpoints usados por la extension (sin auth Supabase — auth vía API key)
  const isPublicExtensionRoute =
    request.nextUrl.pathname === "/api/extension/version" ||
    request.nextUrl.pathname === "/api/extension/account-status" ||
    request.nextUrl.pathname === "/api/extension/pause-toggle" ||
    request.nextUrl.pathname === "/api/extension/capture-failure" ||
    request.nextUrl.pathname === "/api/extension/connectivity" ||
    request.nextUrl.pathname === "/api/extension/next-actions" ||
    request.nextUrl.pathname === "/api/extension/force-tick" ||
    request.nextUrl.pathname === "/api/runtime-config" ||
    request.nextUrl.pathname === "/api/runtime-config/heartbeat" ||
    request.nextUrl.pathname === "/api/admin/dispatch-test" ||
    request.nextUrl.pathname === "/api/visual-learning/capture" ||
    request.nextUrl.pathname === "/api/visual-learning/learned-selectors" ||
    request.nextUrl.pathname.startsWith("/api/visual-learning/tickets") ||
    request.nextUrl.pathname.startsWith("/api/visual-learning/pins")

  if (!user && !isAuthRoute && !isPublicRoute && !isPublicExtensionRoute) {
    const url = request.nextUrl.clone()
    url.pathname = "/login"
    return NextResponse.redirect(url)
  }

  if (user && isAuthRoute) {
    const url = request.nextUrl.clone()
    url.pathname = "/dashboard"
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
}
