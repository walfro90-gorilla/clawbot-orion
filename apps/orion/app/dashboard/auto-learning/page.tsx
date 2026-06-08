import { createAdminClient } from "@/lib/supabase/admin"
import { AutoLearningClient } from "./client"

export default async function AutoLearningPage() {
  const admin = createAdminClient() as any

  const [insightsResult, ticketsResult, learnedResult, runtimeResult, timelinesResult] = await Promise.all([
    admin.from("phase_insights")
      .select("*")
      .order("acknowledged", { ascending: true })
      .order("severity", { ascending: true })
      .order("detected_at", { ascending: false })
      .limit(100),
    admin.from("selector_tickets").select("id, phase_name, status, created_at").order("created_at", { ascending: false }).limit(20),
    admin.from("learned_selectors").select("*").order("priority", { ascending: false }),
    admin.from("runtime_config").select("*").order("updated_at", { ascending: false }),
    // Timelines FSM: comandos recientes con micro_phase_log (los checkpoints que
    // instrumentamos: typing_started→typing_complete→send_clicked, etc).
    admin.from("extension_commands")
      .select("id, action, status, error, created_at, micro_phase_log")
      .not("micro_phase_log", "is", null)
      .order("created_at", { ascending: false })
      .limit(15),
  ])

  return (
    <AutoLearningClient
      insights={insightsResult.data ?? []}
      tickets={ticketsResult.data ?? []}
      learnedSelectors={learnedResult.data ?? []}
      runtimeConfig={runtimeResult.data ?? []}
      timelines={timelinesResult.data ?? []}
    />
  )
}
