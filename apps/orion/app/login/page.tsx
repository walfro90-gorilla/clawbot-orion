import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"

export default async function LoginPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) redirect("/dashboard")

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      <div className="w-full max-w-sm space-y-6 p-8 bg-gray-900 rounded-2xl border border-gray-800 shadow-2xl">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-bold text-white tracking-tight">Orion</h1>
          <p className="text-sm text-gray-400">ClawBot CRM — Accede a tu cuenta</p>
        </div>
        <LoginForm />
      </div>
    </div>
  )
}

function LoginForm() {
  async function login(formData: FormData) {
    "use server"
    const { createClient } = await import("@/lib/supabase/server")
    const supabase = await createClient()
    const email = formData.get("email") as string
    const password = formData.get("password") as string
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) redirect("/login?error=Credenciales incorrectas")
    redirect("/dashboard")
  }

  return (
    <form action={login} className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="email" className="block text-sm font-medium text-gray-300">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
          placeholder="tu@email.com"
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="password" className="block text-sm font-medium text-gray-300">
          Contraseña
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
          placeholder="••••••••"
        />
      </div>
      <button
        type="submit"
        className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition-colors text-sm"
      >
        Entrar
      </button>
    </form>
  )
}
