import { redirect } from "next/navigation"
import Link from "next/link"
import { headers } from "next/headers"

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>
}) {
  const sp = await searchParams

  async function sendResetLink(formData: FormData) {
    "use server"
    const { createClient } = await import("@/lib/supabase/server")
    const supabase = await createClient()
    const email = formData.get("email") as string

    // Build absolute callback URL so the magic link returns to this app
    const h = await headers()
    const host  = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000"
    const proto = h.get("x-forwarded-proto") ?? "http"
    const redirectTo = `${proto}://${host}/auth/callback?next=/reset-password`

    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })

    if (error) {
      redirect(`/forgot-password?error=${encodeURIComponent(error.message || "No se pudo enviar el link")}`)
    }

    // Siempre regresamos "sent=1" sin importar si el email existe — evita revelar
    // qué emails están registrados (anti-enumeration).
    redirect(`/forgot-password?sent=1`)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950 px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/30 mb-1">
            <span className="text-2xl">🔑</span>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Recuperar contraseña</h1>
          <p className="text-sm text-gray-400">Te enviaremos un link a tu email para resetearla</p>
        </div>

        <div className="p-7 bg-gray-900/80 backdrop-blur rounded-2xl border border-gray-800 shadow-2xl space-y-5">
          {sp.sent ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-lg text-sm text-green-300">
                <span className="text-lg shrink-0">✉️</span>
                <div>
                  <p className="font-semibold">Revisa tu correo</p>
                  <p className="text-xs mt-1 text-green-300/80">
                    Si el email está registrado, te enviamos un link para resetear tu contraseña.
                    Revisa también tu carpeta de spam.
                  </p>
                </div>
              </div>
              <Link
                href="/login"
                className="block text-center py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium text-sm rounded-lg transition-colors"
              >
                ← Volver al login
              </Link>
            </div>
          ) : (
            <form action={sendResetLink} className="space-y-4">
              {sp.error && (
                <div className="flex items-start gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-300">
                  <span className="shrink-0 mt-0.5">⚠️</span>
                  <span>{sp.error}</span>
                </div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="email" className="block text-xs font-medium text-gray-400">
                  Email registrado
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  autoFocus
                  className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors"
                  placeholder="tu@email.com"
                />
              </div>

              <button
                type="submit"
                className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition-colors text-sm"
              >
                Enviar link de recuperación
              </button>

              <Link
                href="/login"
                className="block text-center text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                ← Volver al login
              </Link>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
