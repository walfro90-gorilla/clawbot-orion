# ClawBot — CLAUDE.md

> Guía de arquitectura y contexto técnico para Claude Code.
> Actualizado: 2026-04-12

---

## 1. Estructura del monorepo

```
/root/clawbot/
├── apps/
│   ├── prometheus/          ← Backend automatización LinkedIn (Node.js ESM)
│   └── orion/               ← CRM dashboard (Next.js 14 App Router)
├── packages/
│   └── db-types/            ← Tipos TypeScript generados de Supabase
└── ecosystem.config.cjs     ← PM2: orion (:3000) + prometheus-scheduler
```

**Servidor:** 209.50.63.149 — acceso SSH directo.

---

## 2. PM2 Procesos

| Nombre                 | Puerto | Script                      | Descripción                         |
|------------------------|--------|-----------------------------|-------------------------------------|
| `orion`                | 3000   | `npm start` (Next.js)       | CRM frontend                        |
| `prometheus-scheduler` | —      | `scheduler.js`              | Orquestador: batch + search + inbox |

```bash
pm2 list                        # estado
pm2 logs prometheus-scheduler   # logs en vivo
pm2 restart orion               # tras rebuild
pm2 save                        # persistir tras reboot
```

---

## 3. Prometheus — Archivos clave

```
apps/prometheus/
├── scheduler.js    ← Orquestador central (tick ~30min)
├── worker.js       ← Scraper + AI qualify + envío de invitación
├── batch.js        ← Coordina múltiples workers en paralelo
├── search.js       ← Scraping de perfiles LinkedIn desde búsqueda
├── inbox.js        ← Lee inbox LinkedIn via GraphQL interceptor
├── ai.js           ← Gemini 2.5 Flash: qualify + generar mensaje
└── lib/supabase.js ← Cliente Supabase + helpers logActivity
```

### Horario del scheduler

- **Batch/Search** (envío de invitaciones): Lun–Vie 09–19h hora México
- **Inbox** (lectura de respuestas): Lun–Sáb 08–21h hora México
- Tick base: ~30 min ± 10 min jitter

### Cómo funciona el inbox (inbox.js) — IMPORTANTE

LinkedIn abandonó su REST Voyager API para mensajes. Ahora usa **GraphQL** (`/voyager/api/voyagerMessagingGraphQL/graphql`).

Estrategia actual:
1. Browser abre feed LinkedIn (warmup)
2. **Interceptor global** (`page.on('response')`) captura TODAS las respuestas `/voyager/api/` → guardadas en `Map<url, json>`
3. Navega a `/messaging/` → LinkedIn dispara `messengerConversations` GraphQL automáticamente
4. Parsea participantes: `distance === 'SELF'` = cuenta propia; el otro = lead
5. Match lead por **nombre completo** (no por URL — GraphQL usa IDs internos no slugs públicos)
6. Por cada lead matched: navega al hilo → LinkedIn dispara `messengerMessagesBySyncToken`
7. Filtra mensajes `inbound` (sender `distance !== 'SELF'`), captura texto con `body.text`
8. Emoji responses son válidas: filtro `body.trim().length >= 1` (emojis tienen `.length === 2` en JS UTF-16)
9. Solo llama `markReplied()` si hay mensaje inbound real. Sin inbound → solo `markConnected()`.

### Columnas DB que deben existir (conversations / conversation_events)

**conversations.status** constraint: `initiated | connected | active | meeting_booked | dead | closed_won | closed_lost`
- inbox.js usa: `'active'` (lead respondió)
- batch.js usa: `'initiated'` (invitación enviada)

**conversation_events.event_type** constraint: `invite_sent | invite_accepted | invite_rejected | message_sent | message_failed | reply_received | follow_up_sent | meeting_proposed | meeting_confirmed | note_added`
- inbox.js usa: `'reply_received'`
- batch.js usa: `'invite_sent'`

### Generación de mensajes (ai.js + worker.js)

- **Modelo**: Gemini 2.5 Flash (temperatura 0.9)
- **Extracción**: worker.js pre-extrae `headlineCompany` del headline via regex ANTES de llamar a Gemini
  - Patrones: `" en Company"`, `" at Company"`, `"@ Company"`, `"| Company"`, `"Company /"`, `" de Company"`
  - Descarta: ubicaciones (México, CDMX, Monterrey...) y títulos (Director, Manager, CFO...)
  - Resultado en `extractedData.headlineCompany` — Gemini lo usa en vez de inferirlo del texto crudo
- **Templates**: guardados en `message_templates` por campaña en Supabase
- **Regla crítica**: si `headlineCompany` es null, Gemini usa fallback por rol. NUNCA debe usar títulos como empresa.

---

## 4. Orion — Páginas del dashboard

| Ruta | Descripción |
|------|-------------|
| `/dashboard` | KPIs: leads sent/connected/replied, actividad reciente |
| `/dashboard/leads` | Lista de leads con estado y badge de respuesta |
| `/dashboard/leads/[id]` | Detalle del lead + historial de conversación |
| `/dashboard/conversations` | Bandeja de mensajes recibidos (leads que respondieron) |
| `/dashboard/campaigns` | Gestión de campañas |
| `/dashboard/campaigns/[id]/edit` | Editor de campaña + template de mensaje |
| `/dashboard/accounts` | Cuentas LinkedIn (cookie, proxy, estado) |
| `/dashboard/monitor` | Monitor de scheduler_log en tiempo real |
| `/dashboard/activity` | Log de actividad de LinkedIn |
| `/dashboard/users` | Gestión de usuarios (admin) |

### API Routes

- `POST /api/run-job` — dispara inbox manualmente desde Orion UI
- `GET/POST /api/alerts` — sistema de alertas

### Auth

- Supabase Auth + RLS
- Roles: `god_admin > admin > user`
- Middleware Next.js protege rutas `/dashboard/*`

---

## 5. Base de Datos (Supabase)

### Tablas principales

| Tabla | Descripción |
|-------|-------------|
| `linkedin_accounts` | Cuentas LinkedIn con cookie, proxy, estado |
| `campaigns` | Campañas vinculadas a cuentas |
| `leads` | Leads con profile_data JSON, status, ai_message |
| `message_templates` | Templates de mensaje por campaña (Gemini rules) |
| `conversations` | Conversaciones activas con leads |
| `conversation_events` | Historial mensaje a mensaje |
| `scheduler_log` | Registro de cada tick/job |
| `daily_activity` | Contador diario de invitaciones por cuenta |
| `account_alerts` | Alertas (cookie expirada, captcha, etc.) |

### Estado de leads

```
pending → invite_sent → connected → replied
                    ↘ failed / disqualified
```

---

## 6. Estado actual del sistema (2026-04-12)

| Métrica | Valor |
|---------|-------|
| Leads totales | 63 |
| Invitaciones enviadas | 22 (Josh) |
| Conectados | 7 |
| Respondieron | 2 (Adolfo Borrego, Christian Alejandro Pantoja Tovar) |
| Pendientes por enviar | 25 (Wal — Tech & Innovation) |
| Conversaciones en DB | 2 |
| Scheduler activo | Sí (Lun–Vie automático) |

### Cuentas LinkedIn

| Cuenta | Campaña | Proxy | Estado |
|--------|---------|-------|--------|
| Josh | Directores Finanzas México - Test | Sí | active |
| Wal | Tech & Innovation Leaders | Sí | active |

---

## 7. Bugs conocidos y mejoras pendientes

### Bugs activos

1. **currentCompany siempre null en DB**: El scraper de `/details/experience/` falla en headless porque LinkedIn no hidrata el SPA en Chromium sin JS completo. Workaround: `headlineCompany` extraído por regex del headline. Fix real: usar la API de LinkedIn para obtener experiencia, o esperar a que el SPA cargue con más tiempo.

2. **Inbox solo lee primeras 20 conversaciones**: LinkedIn devuelve máximo 20 en el primer `messengerConversations`. Leads que respondieron pero cuya conversación está en posición 21+ no se detectan. Fix: implementar paginación del GraphQL con `syncToken`.

3. **Match de leads por nombre (frágil si hay duplicados)**: inbox.js usa `firstName + lastName` para matchear leads. Si dos leads tienen el mismo nombre completo, habría colisión. Probabilidad baja con 31 leads.

4. **batch.js recordOutbound siempre usa event_type 'invite_sent'**: Los mensajes de seguimiento (follow-up) también se guardan con `invite_sent` en vez de `message_sent`. Fix menor.

5. **Orion error post-restart "Failed to find Server Action"**: Error cosmético de Next.js cuando el cliente tiene acciones cacheadas de un build anterior. Se resuelve solo al recargar el browser. No afecta funcionalidad.

### Mejoras de alto impacto pendientes

1. **Paginación del inbox**: Leer más allá de 20 conversaciones usando `messengerConversationsBySyncToken` con cursor/token.

2. **Outbound message history completo**: batch.js ya registra el mensaje saliente en `conversation_events`, pero el evento type es siempre `invite_sent`. Diferenciar `invite_sent` vs `message_sent` (follow-up).

3. **Re-generación de mensajes malos**: Los leads cuyo `ai_message` contiene un título como empresa (Patricio "Director General", Carlos "Miguel Hidalgo") ya recibieron el mensaje mal. Para nuevos leads el fix está aplicado. Los mensajes enviados no se pueden retractar.

4. **Captcha detection post-click**: worker.js no detecta captchas que aparecen DESPUÉS de hacer click en Connect. Si LinkedIn muestra un checkpoint, el job falla silenciosamente.

5. **Account locking**: Si dos campañas del mismo account corren en paralelo, hay requests simultáneos desde la misma IP. Añadir `is_running` flag en `linkedin_accounts`.

6. **Cookie staleness**: La alerta existe (>25 días → warning, >28 días → critical). Falta UI en Orion para mostrarla prominentemente y proceso para renovar la cookie.

7. **Mobile UI**: Varias tablas del dashboard no tienen `overflow-x-auto`. Sidebar sin hamburger menu en mobile.

8. **Sidebar para mobile**: Actualmente siempre visible; añadir comportamiento colapsable con hamburger.

---

## 8. Comandos frecuentes

```bash
# Correr inbox manualmente (sin afectar DB)
cd /root/clawbot/apps/prometheus
ACCOUNT_ID=2ea4a7f2-eb0a-40d0-a7af-3a3066829aeb DRY_RUN=true node inbox.js

# Correr inbox en real
ACCOUNT_ID=2ea4a7f2-eb0a-40d0-a7af-3a3066829aeb DRY_RUN=false node inbox.js

# Ver logs del scheduler en vivo
pm2 logs prometheus-scheduler --lines 50

# Rebuild y restart Orion
cd /root/clawbot/apps/orion && npm run build && pm2 restart orion

# Ver estado de la DB
# → Usar Supabase MCP (mcp__supabase__execute_sql)
```

---

## 9. Variables de entorno

Las vars están en `/root/clawbot/apps/prometheus/.env` y no en el repo.
Keys requeridas: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY`.
Orion tiene su propio `.env.local` con las vars de Supabase y Next Auth.
