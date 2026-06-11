import { createAdminClient } from "@/lib/supabase/admin"
import { requireRole } from "@/lib/auth/role"
import { redirect } from "next/navigation"
import { randomBytes } from "crypto"
import { DeleteUserBtn } from "@/components/delete-user-btn"

// ── Server Actions ─────────────────────────────────────────────────────────────

async function createUser(formData: FormData) {
  "use server"
  const admin = createAdminClient()
  const email           = formData.get("email")              as string
  const password        = formData.get("password")           as string
  const role            = formData.get("role")               as string
  const company         = formData.get("company_name")       as string
  const linkedAccountId = formData.get("linkedin_account_id") as string | null

  // Create user with password directly — no invitation email
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) { console.error("Create user error:", error.message); return }

  if (data.user) {
    await admin.from("profiles").upsert({
      id:                  data.user.id,
      email,
      role:                role || "user",
      company_name:        company || null,
      linkedin_account_id: linkedAccountId || null,
    })

    // Sync linkedin_accounts.user_id so RLS policies work correctly.
    // Clear any previous ownership first, then assign the new one.
    if (linkedAccountId) {
      // Remove this user from any other account they were previously assigned to
      await admin.from("linkedin_accounts")
        .update({ user_id: null })
        .eq("user_id", data.user.id)
        .neq("id", linkedAccountId)
      // Assign the selected account to this user
      await admin.from("linkedin_accounts")
        .update({ user_id: data.user.id })
        .eq("id", linkedAccountId)
    }
  }
  redirect("/dashboard/users")
}

async function updateUser(formData: FormData) {
  "use server"
  const admin = createAdminClient()
  const userId          = formData.get("user_id")            as string
  const role            = formData.get("role")               as string
  const company         = formData.get("company_name")       as string
  const linkedAccountId = formData.get("linkedin_account_id") as string | null
  const newPassword     = formData.get("new_password")       as string | null

  await admin.from("profiles").update({
    role,
    company_name:        company || null,
    linkedin_account_id: linkedAccountId || null,
  }).eq("id", userId)

  // Sync linkedin_accounts.user_id so RLS policies work correctly.
  // Always clear previous ownership for this user, then assign the new account.
  await admin.from("linkedin_accounts")
    .update({ user_id: null })
    .eq("user_id", userId)

  if (linkedAccountId) {
    await admin.from("linkedin_accounts")
      .update({ user_id: userId })
      .eq("id", linkedAccountId)
  }

  // Optionally update password
  if (newPassword && newPassword.trim().length >= 6) {
    await admin.auth.admin.updateUserById(userId, { password: newPassword })
  }

  redirect("/dashboard/users")
}

async function deleteUser(formData: FormData) {
  "use server"
  const admin = createAdminClient()
  const userId = formData.get("user_id") as string
  await admin.auth.admin.deleteUser(userId)
  redirect("/dashboard/users")
}

// ── Onboarding: crear cliente COMPLETO en un flujo ──────────────────────────────
// Crea user + profile (role=user, onboarding_step=pending) + cuenta LinkedIn shell
// (status=rate_limited, sin cookie — la extensión usa la sesión real del cliente) +
// extension_api_key inline + campaña DESACTIVADA con defaults conservadores + template.
// La cuenta NO se procesa por el scheduler hasta que /api/onboarding/activate la active
// (campaña nace is_active=false). Defaults conservadores van a COLUMNAS de campaigns,
// NUNCA a account_config (eso lockearía el auto-learning). Cleanup-on-error: si algo
// falla tras crear el auth.user, se borra para no dejar huérfanos que bloqueen el email.
async function createClientFull(formData: FormData) {
  "use server"
  await requireRole("admin")
  const admin = createAdminClient()

  const email    = (formData.get("c_email")    as string || "").trim()
  const password = (formData.get("c_password") as string || "")
  const company  = (formData.get("c_company")  as string || "").trim()
  const label    = (formData.get("c_label")    as string || "").trim()
  const profileUrl = (formData.get("c_profile_url") as string || "").trim()
  const proxyUrl   = (formData.get("c_proxy_url")   as string || "").trim()

  if (!email || !password) { console.error("[onboarding] createClientFull: email/password requeridos"); return }

  // 1. auth user
  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (authErr || !created?.user) { console.error("[onboarding] createUser:", authErr?.message); return }
  const userId = created.user.id

  // 2. cuenta LinkedIn shell + api_key inline (antes del profile para tener account.id)
  const apiKey = "orion_sk_" + randomBytes(16).toString("hex")
  const { data: account, error: accErr } = await admin.from("linkedin_accounts").insert({
    label:                  label || email,
    linkedin_profile_url:   profileUrl || null,
    proxy_url:              proxyUrl || null,
    li_at_cookie:           "",                       // la extensión trabaja con la sesión real del cliente
    status:                 "rate_limited",           // inactiva hasta activar onboarding
    user_id:                userId,
    timezone:               "America/Mexico_City",
    warmup_status:          "cold",
    warmup_started_at:      new Date().toISOString(),
    daily_connection_limit: 8,
    extension_api_key:      apiKey,
  }).select("id").single()
  if (accErr || !account) {
    console.error("[onboarding] insert account:", accErr?.message)
    await admin.auth.admin.deleteUser(userId)        // cleanup orphan auth user
    return
  }

  // 3. profile (role=user, onboarding_step=pending, doble-sync con la cuenta)
  const { error: profErr } = await admin.from("profiles").upsert({
    id:                  userId,
    email,
    role:                "user",
    company_name:        company || null,
    linkedin_account_id: account.id,
    onboarding_step:     "pending",
  })
  if (profErr) {
    console.error("[onboarding] upsert profile:", profErr.message)
    await admin.from("linkedin_accounts").delete().eq("id", account.id)
    await admin.auth.admin.deleteUser(userId)
    return
  }

  // 4. campaña DESACTIVADA con defaults conservadores (en columnas de campaigns)
  const { data: campaign, error: campErr } = await admin.from("campaigns").insert({
    name:                  `${company || label || email} — Campaña inicial`,
    linkedin_account_id:   account.id,
    gemini_system_prompt:  "",               // requerido por el schema (el cliente lo afina luego)
    is_active:             false,            // ← el scheduler NO la toca hasta activar
    daily_invite_target:   8,
    min_batch_gap_min:     90,
    search_gap_hours:      20,
    min_pending_threshold: 15,
    schedule_start_hour:   9,
    schedule_end_hour:     19,
    schedule_days:         ["lunes", "martes", "miércoles", "jueves", "viernes"],
    search_keywords:       [],               // el cliente las llena en el wizard
    search_count:          25,
    title_whitelist:       [],
    title_blacklist:       [],
    batch_paused:          false,
    search_paused:         false,
    follow_up_paused:      false,
    follow_up_delay_days:  3,
    auto_reply_mode:       "auto",
  }).select("id").single()
  // La campaña no es crítica para no-romper: si falla, la cuenta+user existen y el admin
  // puede crear la campaña a mano. No se hace rollback del user/cuenta.
  if (campErr || !campaign) {
    console.error("[onboarding] insert campaign:", campErr?.message)
  } else {
    const { error: tplErr } = await admin.from("message_templates").insert({
      campaign_id: campaign.id,
      name:        "Template principal",
      tone:        "casual",
      language:    "es",
      max_chars:   150,
      is_active:   true,
    })
    if (tplErr) console.error("[onboarding] insert template:", tplErr.message)
  }

  // Redirige a la lista de cuentas (#account.id): ahí la card muestra el ExtensionPanel
  // (instalar + pairing) y el panel de activación con el checklist en vivo.
  redirect(`/dashboard/accounts?new=${account.id}`)
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function UsersPage() {
  const me = await requireRole("admin")

  const admin = createAdminClient()
  const [
    { data: { users } },
    { data: profiles },
    { data: accounts },
  ] = await Promise.all([
    admin.auth.admin.listUsers(),
    admin.from("profiles").select("*"),
    admin.from("linkedin_accounts").select("id, label").eq("status", "active").order("label"),
  ])

  const profileMap = Object.fromEntries((profiles ?? []).map((p: any) => [p.id, p]))
  const accountMap = Object.fromEntries((accounts ?? []).map((a: any) => [a.id, a.label]))

  const roleColors: Record<string, string> = {
    god_admin: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    admin:     "bg-purple-500/15 text-purple-400 border-purple-500/30",
    user:      "bg-blue-500/15 text-blue-400 border-blue-500/30",
    viewer:    "bg-gray-500/15 text-gray-400 border-gray-500/30",
  }

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-50">Gestión de Usuarios</h1>
        <p className="text-gray-400 text-sm mt-0.5">{users?.length ?? 0} usuarios registrados</p>
      </div>

      {/* User list */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase tracking-wider">
                <th className="px-5 py-3 text-left font-medium">Usuario</th>
                <th className="px-5 py-3 text-left font-medium">Empresa</th>
                <th className="px-5 py-3 text-left font-medium">Rol</th>
                <th className="px-5 py-3 text-left font-medium">Cuenta LinkedIn</th>
                <th className="px-5 py-3 text-left font-medium">Último acceso</th>
                <th className="px-5 py-3 text-left font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {(users ?? []).map((u) => {
                const p = profileMap[u.id]
                const isMe = u.id === me.id
                const linkedLabel = p?.linkedin_account_id ? accountMap[p.linkedin_account_id] : null
                return (
                  <tr key={u.id} className="hover:bg-gray-800/40 transition-colors">
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
                          {u.email?.[0]?.toUpperCase()}
                        </div>
                        <div>
                          <p className="text-gray-50 font-medium">{u.email}</p>
                          {isMe && <span className="text-xs text-blue-400">Tú</span>}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-gray-400 text-sm">{p?.company_name ?? "—"}</td>
                    <td className="px-5 py-4">
                      <span className={`text-xs px-2.5 py-1 rounded-full border font-medium ${roleColors[p?.role ?? "user"] ?? roleColors.user}`}>
                        {p?.role ?? "user"}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      {linkedLabel ? (
                        <span className="text-xs px-2.5 py-1 rounded-full border font-medium bg-green-500/15 text-green-400 border-green-500/30">
                          {linkedLabel}
                        </span>
                      ) : (
                        <span className="text-gray-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-gray-400 text-xs">
                      {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString("es-MX") : "Nunca"}
                    </td>
                    <td className="px-5 py-4">
                      <details className="relative">
                        <summary className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer list-none">
                          ✏️ Editar
                        </summary>
                        <div className="mt-2 bg-gray-800 border border-gray-700 rounded-xl p-4 space-y-3 min-w-[280px] z-10">
                          <form action={updateUser} className="space-y-3">
                            <input type="hidden" name="user_id" value={u.id} />
                            <div className="space-y-1">
                              <label className="block text-xs text-gray-400">Empresa</label>
                              <input
                                name="company_name"
                                defaultValue={p?.company_name ?? ""}
                                placeholder="Nombre de empresa"
                                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="block text-xs text-gray-400">Rol</label>
                              <select
                                name="role"
                                defaultValue={p?.role ?? "user"}
                                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                              >
                                <option value="god_admin">god_admin — Superadmin</option>
                                <option value="admin">admin — Acceso total</option>
                                <option value="user">user — Solo su cuenta</option>
                                <option value="viewer">viewer — Solo lectura</option>
                              </select>
                            </div>
                            <div className="space-y-1">
                              <label className="block text-xs text-gray-400">Cuenta LinkedIn vinculada</label>
                              <select
                                name="linkedin_account_id"
                                defaultValue={p?.linkedin_account_id ?? ""}
                                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                              >
                                <option value="">Sin vincular</option>
                                {(accounts ?? []).map((a: any) => (
                                  <option key={a.id} value={a.id}>{a.label}</option>
                                ))}
                              </select>
                            </div>
                            <div className="space-y-1">
                              <label className="block text-xs text-gray-400">Nueva contraseña (opcional)</label>
                              <input
                                name="new_password"
                                type="password"
                                placeholder="Dejar vacío para no cambiar"
                                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                            </div>
                            <button type="submit" className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white  text-xs font-medium rounded-lg transition-colors">
                              Guardar cambios
                            </button>
                          </form>

                          {!isMe && (
                            <DeleteUserBtn
                              userId={u.id}
                              userEmail={u.email ?? ""}
                              action={deleteUser}
                            />
                          )}
                        </div>
                      </details>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Onboarding: crear CLIENTE completo (user + cuenta + api_key + campaña) */}
      <div className="bg-gradient-to-br from-blue-600/10 to-purple-600/10 border border-blue-500/30 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-lg">🚀</span>
          <h2 className="text-gray-50 font-semibold">Onboarding — Crear cliente nuevo</h2>
        </div>
        <p className="text-gray-400 text-xs mb-4">
          Crea en un solo paso: usuario + cuenta de LinkedIn + API key de la extensión + campaña inicial (conservadora, desactivada).
          Al terminar te lleva a la cuenta para instalar/parear la extensión y activarla. La campaña no envía nada hasta que actives el onboarding.
        </p>
        <form action={createClientFull} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="space-y-1">
            <label className="block text-xs text-gray-400">Email del cliente *</label>
            <input name="c_email" type="email" required placeholder="cliente@empresa.com"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-gray-400">Contraseña *</label>
            <input name="c_password" type="password" required minLength={8} placeholder="Mínimo 8 caracteres"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-gray-400">Empresa</label>
            <input name="c_company" placeholder="Nombre empresa"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-gray-400">Etiqueta de la cuenta</label>
            <input name="c_label" placeholder="Ej: Juan Pérez (CEO)"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-gray-400">URL del perfil de LinkedIn</label>
            <input name="c_profile_url" placeholder="https://www.linkedin.com/in/..."
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-gray-400">Proxy (opcional)</label>
            <input name="c_proxy_url" placeholder="http://user:pass@host:port"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex items-end lg:col-span-3">
            <button type="submit" className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg transition-colors">
              🚀 Crear cliente y continuar al pairing
            </button>
          </div>
        </form>
      </div>

      {/* Create user form (simple — usuario suelto, vincula a cuenta existente) */}
      <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-6">
        <h2 className="text-gray-50 font-semibold mb-1">Crear usuario suelto</h2>
        <p className="text-gray-400 text-xs mb-4">Solo crea el usuario (sin provisionar cuenta). Útil para vincular a una cuenta existente o crear admins. El usuario puede iniciar sesión de inmediato.</p>
        <form action={createUser} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="space-y-1">
            <label className="block text-xs text-gray-400">Email *</label>
            <input
              name="email" type="email" required placeholder="usuario@empresa.com"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-gray-400">Contraseña *</label>
            <input
              name="password" type="password" required minLength={8} placeholder="Mínimo 8 caracteres"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-gray-400">Empresa</label>
            <input
              name="company_name" placeholder="Nombre empresa"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-gray-400">Rol</label>
            <select name="role" className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="user">user — Solo su cuenta</option>
              <option value="admin">admin — Acceso total</option>
              <option value="god_admin">god_admin — Superadmin</option>
              <option value="viewer">viewer — Solo lectura</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-gray-400">Cuenta LinkedIn vinculada</label>
            <select name="linkedin_account_id" className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">Sin vincular</option>
              {(accounts ?? []).map((a: any) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button type="submit" className="w-full px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white  text-sm font-semibold rounded-lg transition-colors">
              Crear usuario
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
