import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { redirect } from "next/navigation"

// Página fail-closed para usuarios restringidos (user/viewer) SIN cuenta LinkedIn
// vinculada. Vive en la raíz (fuera de /dashboard) para no disparar el guard del
// layout en loop. Si el usuario YA tiene cuenta (o es admin), lo mandamos al dashboard.
export const dynamic = "force-dynamic"

export default async function NoAccountPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const admin = createAdminClient()
  const { data: profile } = await admin
    .from("profiles")
    .select("role, linkedin_account_id")
    .eq("id", user.id)
    .single()

  const isRestricted = profile?.role === "user" || profile?.role === "viewer"
  // Si NO aplica (admin, o restringido que YA tiene cuenta) → al dashboard.
  if (!isRestricted || profile?.linkedin_account_id) redirect("/dashboard")

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center space-y-4">
        <div className="text-4xl">🔒</div>
        <h1 className="text-xl font-bold text-gray-50">Tu cuenta aún no está configurada</h1>
        <p className="text-sm text-gray-400">
          Tu usuario todavía no está vinculado a una cuenta de LinkedIn. Por seguridad,
          no podemos mostrarte ningún dato hasta que un administrador asigne tu cuenta.
        </p>
        <p className="text-sm text-gray-500">
          Contacta a tu administrador para que complete la configuración.
        </p>
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="mt-2 px-5 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm rounded-lg transition-colors"
          >
            Cerrar sesión
          </button>
        </form>
      </div>
    </div>
  )
}
