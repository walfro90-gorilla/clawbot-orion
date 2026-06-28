import { createAdminClient } from "@/lib/supabase/admin"
import { requireRole } from "@/lib/auth/role"
import { revalidatePath } from "next/cache"
import { redirect, notFound } from "next/navigation"
import Link from "next/link"

const ALL_DAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]

async function savePublishAgent(formData: FormData): Promise<void> {
  "use server"
  const admin = createAdminClient() as any
  const id = formData.get("id") as string
  if (!id) return
  const days = (formData.getAll("schedule_days") as string[]).filter(Boolean)
  await admin.from("publish_agents").update({
    name: ((formData.get("name") as string) || "").trim() || "Publicador diario",
    is_active: formData.get("is_active") === "on",
    business_context: ((formData.get("business_context") as string) || "").trim() || null,
    ideas: ((formData.get("ideas") as string) || "").trim() || null,
    tone: ((formData.get("tone") as string) || "").trim() || null,
    do_dont: ((formData.get("do_dont") as string) || "").trim() || null,
    gemini_system_prompt: ((formData.get("gemini_system_prompt") as string) || "").trim() || null,
    schedule_start_hour: parseInt((formData.get("schedule_start_hour") as string) || "9") || 9,
    schedule_end_hour: parseInt((formData.get("schedule_end_hour") as string) || "19") || 19,
    schedule_days: days.length ? days : null,
    updated_at: new Date().toISOString(),
  }).eq("id", id)
  revalidatePath("/dashboard/publish-agent")
  redirect("/dashboard/publish-agent")
}

export default async function EditPublishAgentPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole("admin")
  const { id } = await params
  const admin = createAdminClient() as any
  const { data: agent } = await admin
    .from("publish_agents")
    .select("*, linkedin_accounts(label)")
    .eq("id", id)
    .maybeSingle()
  if (!agent) notFound()

  const inp = "w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-50 placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
  const lbl = "text-[11px] text-gray-500"
  const days: string[] = agent.schedule_days ?? ["lunes", "martes", "miércoles", "jueves", "viernes"]

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-gray-50">Configurar agente · {agent.linkedin_accounts?.label ?? ""}</h1>
        <Link href="/dashboard/publish-agent" className="text-gray-400 hover:text-gray-200 text-sm">← Volver</Link>
      </div>

      <form action={savePublishAgent} className="space-y-5 bg-gray-900/40 border border-gray-800 rounded-lg p-4">
        <input type="hidden" name="id" value={agent.id} />

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className={lbl}>Nombre</label>
            <input name="name" defaultValue={agent.name ?? ""} className={inp} />
          </div>
          <label className="flex items-center gap-2 mt-5">
            <input type="checkbox" name="is_active" defaultChecked={agent.is_active} className="w-4 h-4" />
            <span className="text-sm text-gray-200">Activo (genera 1 borrador/día)</span>
          </label>
        </div>

        <div>
          <label className={lbl}>Contexto del negocio (giro, qué ofreces, a quién) — lo más importante</label>
          <textarea name="business_context" rows={4} defaultValue={agent.business_context ?? ""}
            placeholder="Ej. Ofrecemos automatización con IA y SaaS agéntico para PYMES B2B en LATAM. Ayudamos a equipos de ventas a..."
            className={inp + " resize-y"} />
        </div>

        <div>
          <label className={lbl}>Ideas / temas recurrentes (uno por línea)</label>
          <textarea name="ideas" rows={4} defaultValue={agent.ideas ?? ""}
            placeholder={"Casos de uso de agentes IA\nErrores comunes al automatizar ventas\nROI de la automatización\nTendencias de IA en LATAM"}
            className={inp + " resize-y"} />
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className={lbl}>Tono</label>
            <input name="tone" defaultValue={agent.tone ?? ""} placeholder="profesional, cercano, directo" className={inp} />
          </div>
          <div>
            <label className={lbl}>Do / Don't (reglas extra)</label>
            <input name="do_dont" defaultValue={agent.do_dont ?? ""} placeholder="No mencionar precios; sí incluir 1 dato accionable" className={inp} />
          </div>
        </div>

        <div>
          <label className={lbl}>Instrucción extra para la IA (opcional)</label>
          <textarea name="gemini_system_prompt" rows={2} defaultValue={agent.gemini_system_prompt ?? ""} className={inp + " resize-y"} />
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className={lbl}>Hora inicio</label>
            <input name="schedule_start_hour" type="number" min={0} max={23} defaultValue={agent.schedule_start_hour ?? 9} className={inp} />
          </div>
          <div>
            <label className={lbl}>Hora fin</label>
            <input name="schedule_end_hour" type="number" min={0} max={23} defaultValue={agent.schedule_end_hour ?? 19} className={inp} />
          </div>
        </div>

        <div>
          <label className={lbl}>Días (genera dentro de la ventana, hora de México)</label>
          <div className="flex flex-wrap gap-3 mt-1">
            {ALL_DAYS.map((d) => (
              <label key={d} className="flex items-center gap-1.5 text-sm text-gray-300">
                <input type="checkbox" name="schedule_days" value={d} defaultChecked={days.includes(d)} className="w-4 h-4" />
                {d}
              </label>
            ))}
          </div>
        </div>

        <div className="flex justify-end">
          <button type="submit" className="px-5 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-white text-sm font-semibold">Guardar</button>
        </div>
      </form>
    </div>
  )
}
