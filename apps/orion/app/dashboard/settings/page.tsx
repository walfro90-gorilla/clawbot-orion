import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { redirect } from "next/navigation"

async function saveCalUrl(formData: FormData) {
  "use server"
  const admin  = createAdminClient()
  const id     = formData.get("account_id") as string
  const calUrl = (formData.get("cal_com_url") as string).trim() || null

  if (!id) return

  const { error } = await admin
    .from("linkedin_accounts")
    .update({ cal_com_url: calUrl })
    .eq("id", id)

  if (error) console.error("[settings] saveCalUrl error:", error.message)
  redirect("/dashboard/settings?saved=1")
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>
}) {
  const { saved } = await searchParams
  const supabase  = await createClient()
  const admin     = createAdminClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: profile } = await admin.from("profiles").select("role, email").eq("id", user.id).single()

  // Find the LinkedIn account assigned to this user
  const { data: account } = await admin
    .from("linkedin_accounts")
    .select("id, label, linkedin_profile_url, cal_com_url, li_at_cookie_updated_at, warmup_status, status")
    .eq("user_id", user.id)
    .maybeSingle()

  // Cookie freshness
  const cookieDays = account?.li_at_cookie_updated_at
    ? Math.floor((Date.now() - new Date(account.li_at_cookie_updated_at).getTime()) / 86400000)
    : null

  const cookieStatus =
    cookieDays === null  ? { label: "Desconocida", cls: "text-gray-500" }
    : cookieDays >= 60   ? { label: `${cookieDays}d — CRÍTICO`, cls: "text-red-400" }
    : cookieDays >= 30   ? { label: `${cookieDays}d — Advertencia`, cls: "text-yellow-400" }
    : { label: `${cookieDays}d — OK`, cls: "text-green-400" }

  const warmupMeta: Record<string, { icon: string; label: string }> = {
    cold:    { icon: "❄️", label: "Fría (nueva)" },
    warming: { icon: "🌡️", label: "Tibia (calentando)" },
    warm:    { icon: "☀️", label: "Cálida (activa)" },
    hot:     { icon: "🔥", label: "Caliente (veterana)" },
  }
  const ws = warmupMeta[account?.warmup_status ?? "cold"] ?? warmupMeta.cold

  return (
    <div className="p-8 max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-50">Mi configuración</h1>
        <p className="text-gray-400 text-sm mt-0.5">{profile?.email}</p>
      </div>

      {saved && (
        <div className="flex items-center gap-2 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-xl text-green-400 text-sm">
          ✓ Configuración guardada correctamente
        </div>
      )}

      {/* LinkedIn account card */}
      {account ? (
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 space-y-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-gray-50 font-semibold text-lg">{account.label ?? "Mi cuenta LinkedIn"}</p>
              {account.linkedin_profile_url && (
                <a
                  href={account.linkedin_profile_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300 text-xs mt-0.5 block truncate max-w-xs"
                >
                  {account.linkedin_profile_url}
                </a>
              )}
            </div>
            <span className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
              account.status === "active"
                ? "bg-green-500/10 text-green-400 border-green-500/30"
                : "bg-gray-500/10 text-gray-400 border-gray-500/30"
            }`}>
              {account.status}
            </span>
          </div>

          {/* Account stats */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-800 rounded-lg px-4 py-3">
              <p className="text-gray-500 text-xs mb-1">Temperatura de cuenta</p>
              <p className="text-gray-50 text-sm font-medium">{ws.icon} {ws.label}</p>
            </div>
            <div className="bg-gray-800 rounded-lg px-4 py-3">
              <p className="text-gray-500 text-xs mb-1">Cookie LinkedIn</p>
              <p className={`text-sm font-medium ${cookieStatus.cls}`}>{cookieStatus.label}</p>
            </div>
          </div>

          {cookieDays !== null && cookieDays >= 30 && (
            <div className={`px-4 py-3 rounded-lg text-sm border ${
              cookieDays >= 60
                ? "bg-red-500/10 border-red-500/30 text-red-400"
                : "bg-yellow-500/10 border-yellow-500/30 text-yellow-400"
            }`}>
              {cookieDays >= 60
                ? "Tu cookie de LinkedIn lleva más de 60 días — el sistema está pausado. Renuévala en Cuentas LI o contacta a soporte."
                : "Tu cookie de LinkedIn lleva más de 30 días. Considera renovarla pronto para evitar interrupciones."}
            </div>
          )}

          {/* Cal.com section */}
          <form action={saveCalUrl} className="space-y-4 pt-1 border-t border-gray-700">
            <input type="hidden" name="account_id" value={account.id} />

            <div>
              <h2 className="text-gray-50 font-medium mb-1">Enlace de agenda Cal.com</h2>
              <p className="text-gray-500 text-xs mb-3">
                La IA incluirá este link en la conversación cuando el lead esté listo para agendar una reunión.
                Asegúrate de que sea un enlace directo a tu disponibilidad (Ej: 20 min).
              </p>
              <input
                type="url"
                name="cal_com_url"
                defaultValue={account.cal_com_url ?? ""}
                placeholder="https://cal.com/tu-usuario/20min"
                className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {account.cal_com_url && (
                <p className="text-gray-500 text-xs mt-1.5">
                  Actual:{" "}
                  <a href={account.cal_com_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
                    {account.cal_com_url}
                  </a>
                </p>
              )}
            </div>

            <button
              type="submit"
              className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Guardar
            </button>
          </form>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-8 text-center">
          <p className="text-gray-400 text-sm">No tienes ninguna cuenta LinkedIn asignada.</p>
          <p className="text-gray-500 text-xs mt-1">Contacta a un administrador para que asigne tu cuenta.</p>
        </div>
      )}
    </div>
  )
}
