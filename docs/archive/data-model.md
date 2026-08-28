> 🗄️ **ARCHIVADO (27-ago-2026) — no describe el sistema actual.**
> Este documento es de **jun-2026** y describe el modelo de datos de la skill `clawbot-stack`, INCOMPLETO.
> Le faltan `campaign_target_companies`, `campaign_followups` y `extension_commands` —las tres tablas centrales de hoy— y el estado `follow_up_sent`. Hoy: `CLAUDE.md` §5.
> Contexto del archivo: [`docs/archive/README.md`](README.md).

---

# ClawBot — modelo de datos (Supabase)

Verifica el esquema real con el **MCP de Supabase** (`list_tables`) antes de cambiarlo; esto es el mapa, no la fuente de verdad.

## Tablas principales
| Tabla | Rol |
|-------|-----|
| `linkedin_accounts` | cuentas LinkedIn: cookie, proxy, estado, campaña |
| `campaigns` | campañas vinculadas a una cuenta |
| `leads` | leads: `profile_data` (JSON), `status`, `ai_message`, `headlineCompany` |
| `message_templates` | templates de mensaje por campaña (reglas para Gemini) |
| `conversations` | conversación activa con un lead |
| `conversation_events` | historial mensaje a mensaje |
| `scheduler_log` | cada tick/job del scheduler |
| `daily_activity` | contador diario de invitaciones por cuenta |
| `account_alerts` | alertas (cookie expirada, captcha, etc.) |

## CHECK constraints (insertar fuera del set = error, no fallo silencioso)
- **`conversations.status`** ∈ `initiated | connected | active | meeting_booked | dead | closed_won | closed_lost`
- **`conversation_events.event_type`** ∈ `invite_sent | invite_accepted | invite_rejected | message_sent | message_failed | reply_received | follow_up_sent | meeting_proposed | meeting_confirmed | note_added`

## Estado del lead (flujo)
```
pending → invite_sent → connected → replied
                    ↘ failed / disqualified
```

## Notas / deuda conocida
- `currentCompany` históricamente quedaba `null`; workaround = `headlineCompany` por regex del headline.
- Match de leads en inbox por nombre completo (frágil con duplicados) — arquitectura del flujo viejo (ver [clawbot-stack] sobre arch muerta vs Smart Hybrid).
- Antes de escribir en `conversation_events`, elige el `event_type` correcto (no todo es `invite_sent`).

## Tipos en código
```ts
import type { Database } from '@clawbot/db-types'
type Lead = Database['public']['Tables']['leads']['Row']
```
Tras cambiar el esquema: `npm run types` para regenerar. Detalle de queries/RLS en la skill [postgres-supabase-pro].
