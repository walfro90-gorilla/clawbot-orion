import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { ResetPasswordForm } from "./reset-password-form"

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const sp = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Sin sesión = el link expiró o fue inválido. Redirigir a forgot-password.
  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950 px-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-2 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-red-500/10 border border-red-500/30 mb-1">
              <span className="text-2xl">⏱</span>
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Link expirado</h1>
            <p className="text-sm text-gray-400">El enlace de recuperación venció o no es válido</p>
          </div>
          <div className="p-7 bg-gray-900/80 backdrop-blur rounded-2xl border border-gray-800 shadow-2xl space-y-4">
            <p className="text-sm text-gray-400">
              Los links de recuperación son válidos por <strong className="text-gray-200">1 hora</strong>.
              Solicita uno nuevo para continuar.
            </p>
            <Link
              href="/forgot-password"
              className="block text-center py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm rounded-lg transition-colors"
            >
              Solicitar link nuevo
            </Link>
            <Link
              href="/login"
              className="block text-center text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              ← Volver al login
            </Link>
          </div>
        </div>
      </div>
    )
  }

  async function updatePassword(formData: FormData) {
    "use server"
    const { createClient } = await import("@/lib/supabase/server")
    const supabase = await createClient()
    const password = formData.get("password") as string
    const confirm  = formData.get("confirm")  as string

    if (password.length < 8) {
      redirect(`/reset-password?error=${encodeURIComponent("La contraseña debe tener al menos 8 caracteres")}`)
    }
    if (password !== confirm) {
      redirect(`/reset-password?error=${encodeURIComponent("Las contraseñas no coinciden")}`)
    }

    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      redirect(`/reset-password?error=${encodeURIComponent(error.message || "Error al actualizar")}`)
    }

    redirect("/login?message=Contraseña actualizada. Inicia sesión con tu nueva contraseña.")
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950 px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/30 mb-1">
            <span className="text-2xl">🔐</span>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Nueva contraseña</h1>
          <p className="text-sm text-gray-400">Elige una contraseña fuerte para <strong className="text-gray-300">{user.email}</strong></p>
        </div>

        <div className="p-7 bg-gray-900/80 backdrop-blur rounded-2xl border border-gray-800 shadow-2xl">
          <ResetPasswordForm action={updatePassword} errorMessage={sp.error} />
        </div>
      </div>
    </div>
  )
}
