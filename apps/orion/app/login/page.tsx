import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { LoginForm } from "./login-form"

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>
}) {
  const sp = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) redirect("/dashboard")

  async function login(formData: FormData) {
    "use server"
    const { createClient } = await import("@/lib/supabase/server")
    const supabase = await createClient()
    const email    = formData.get("email") as string
    const password = formData.get("password") as string

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      const msg = error.message?.toLowerCase().includes("invalid")
        ? "Email o contraseña incorrectos"
        : error.message?.toLowerCase().includes("not confirmed")
          ? "Confirma tu email antes de entrar"
          : error.message || "Error al iniciar sesión"
      redirect(`/login?error=${encodeURIComponent(msg)}`)
    }
    redirect("/dashboard")
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950 px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/30 mb-1">
            <span className="text-3xl">🌟</span>
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Orion</h1>
          <p className="text-sm text-gray-400">CRM para LinkedIn</p>
        </div>

        <div className="p-7 bg-gray-900/80 backdrop-blur rounded-2xl border border-gray-800 shadow-2xl space-y-5">
          {sp.message && (
            <div className="px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg text-xs text-green-300">
              ✓ {sp.message}
            </div>
          )}
          <LoginForm action={login} errorMessage={sp.error} />
        </div>

        <p className="text-center text-xs text-gray-600">
          ¿Problemas para entrar? Contacta al admin.
        </p>
      </div>
    </div>
  )
}
