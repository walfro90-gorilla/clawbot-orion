# ClawBot — Blueprint Técnico

> Documento de arquitectura completo. Creado: 2026-04-12.

---

## Visión general

ClawBot automatiza la prospección outbound en LinkedIn para EBOOMS:

```
LinkedIn ←→ Prometheus (Playwright) ←→ Supabase ←→ Orion (Next.js CRM)
```

1. **Prometheus** scraping leads → califica con Gemini AI → envía invitaciones → lee respuestas
2. **Supabase** almacena estado de leads, campañas, conversaciones, logs
3. **Orion** CRM dashboard para monitorear, gestionar y responder

---

## Flujo completo de un lead

```
1. SEARCH     search.js    → Busca perfiles en LinkedIn por keywords + location
                           → Guarda URLs en leads (status: pending)

2. SCRAPE     worker.js    → Abre perfil con Playwright (stealth + proxy)
                           → Extrae: name, headline, location, about, experience
                           → Pre-extrae headlineCompany con regex
                           → Envía a Gemini 2.5 Flash para qualify + mensaje

3. AI QUALIFY ai.js        → Si calificado: genera mensaje personalizado (≤150 chars)
                           → Si no calificado: status → disqualified

4. SEND       worker.js    → Detecta CTA: Connect/Message/Quick-Connect
                           → Envía invitación con nota personalizada
                           → status → invite_sent, guarda sent_at
                           → Registra en conversation_events (invite_sent)

5. INBOX      inbox.js     → Lee messengerConversations via GraphQL intercept
                           → Match leads por nombre completo
                           → Navega a cada hilo → captura messengerMessages
                           → Filtra mensajes inbound (distance !== 'SELF')
                           → Si hay respuesta real: status → replied
                           → Guarda en conversations + conversation_events

6. CRM        orion        → Dashboard muestra estado en tiempo real
                           → /conversations muestra bandeja de respuestas
                           → /leads/[id] muestra historial de conversación
```

---

## Arquitectura anti-ban

### LinkedIn detection vectors (mitigados)

| Vector | Mitigación |
|--------|-----------|
| IP datacenter | Proxy residencial por cuenta (`proxy_url`) |
| Headless UA | Stealth plugin + UA rotado de Chrome real |
| Timing predecible | Delays variables (60–180s entre leads, 7–18s entre páginas) |
| Volumen alto | Batch size 3–6 aleatorio, daily limit por cuenta |
| Patrón horario | Solo Lun–Vie 9–19h hora México + jitter ±10min |
| Warmup faltante | Visita feed antes de actuar (simula uso real) |
| Requests en paralelo | Una campaña por cuenta a la vez (scheduler dedup) |

### Proxy configuration

Cada cuenta LinkedIn tiene su propio proxy dedicado en `linkedin_accounts.proxy_url`.
Formato: `http://user:pass@host:port`

`parseProxy()` en worker.js/inbox.js lo convierte a formato Playwright:
```javascript
{ server: "http://host:port", username: "user", password: "pass" }
```

---

## Inbox — Arquitectura GraphQL (crítica)

LinkedIn deprecó su REST Voyager API de mensajes. La estrategia actual:

### Por qué no funciona DOM scraping
LinkedIn usa Ember.js con FastBoot SSR. En headless Chromium, el SPA no hidrata completamente → los selectores DOM fallan (timeout).

### Por qué no funciona REST API
`/voyager/api/messaging/conversations` → 400/404 (deprecado en 2024-2025).

### Solución: interceptar GraphQL del browser

```javascript
// Interceptor global — captura ANTES de navegar a /messaging/
page.on('response', async (response) => {
  if (!url.includes('/voyager/api/')) return
  if (response.status() !== 200) return
  const json = await response.json()
  globalApiResponses.set(url, json)  // Map<url → json>
})
```

Cuando LinkedIn carga `/messaging/` o un thread, dispara automáticamente:
- `messengerConversations.{hash}` → lista de conversaciones (20 max)
- `messengerMessages.{hash}` → mensajes de un hilo

### Estructura GraphQL de conversaciones

```javascript
conversation = {
  backendUrn: "urn:li:messagingThread:2-XXXX...",  // → threadId
  unreadCount: 0,
  lastActivityAt: timestamp,
  conversationParticipants: [
    {
      participantType: {
        member: {
          firstName: { text: "Josh" },
          lastName:  { text: "Sanchez" },
          distance:  "SELF"             // ← cuenta propia
        }
      }
    },
    {
      participantType: {
        member: {
          firstName: { text: "Adolfo" },
          lastName:  { text: "Borrego" },
          distance:  "DISTANCE_1"       // ← lead (contacto)
        }
      }
    }
  ]
}
```

### Estructura GraphQL de mensajes

```javascript
message = {
  body: { text: "Hola Jorge. Gracias, un saludo." },
  sender: {
    participantType: {
      member: { distance: "DISTANCE_1" }  // "SELF" si es nuestro
    }
  },
  deliveredAt: timestamp
}
```

**Ruta del dato:** `data.messengerMessagesBySyncToken.elements`

---

## Modelo de datos clave

### leads.profile_data (JSON)

```json
{
  "name": "Patricio Diez de Bonilla",
  "headline": "Managing Director - CFO",
  "location": "Ciudad de México",
  "about": "...",
  "currentPosition": null,
  "currentCompany": null,
  "headlineCompany": null,
  "profileUrl": "https://www.linkedin.com/in/...",
  "scrapedAt": "2026-04-08T..."
}
```

`headlineCompany` es extraído por regex en worker.js antes de llamar a Gemini.
`currentCompany` viene del scraper de `/details/experience/` — frecuentemente null porque el SPA no carga en headless.

### Constraints críticos en DB

```sql
-- conversations.status
CHECK (status = ANY (ARRAY[
  'initiated','connected','active','meeting_booked','dead','closed_won','closed_lost'
]))

-- conversation_events.event_type  
CHECK (event_type = ANY (ARRAY[
  'invite_sent','invite_accepted','invite_rejected','message_sent','message_failed',
  'reply_received','follow_up_sent','meeting_proposed','meeting_confirmed','note_added'
]))

-- conversation_events.direction
CHECK (direction = ANY (ARRAY['outbound','inbound','internal']))
```

---

## Generación de mensajes AI

### Pipeline

```
extractedData → buildSystemPrompt(template) → Gemini 2.5 Flash → JSON response
```

### Template por campaña (message_templates)

```
qualification_rules  → cuándo descalificar
message_rules        → lógica de personalización (prioridad 1–4)
opening_hint         → cómo empezar
example_good         → ejemplo ideal
example_bad          → qué evitar
max_chars            → 150 por defecto
```

### Lógica de personalización (Directores Finanzas campaign)

```
1. Post reciente → "Vi tu post sobre [tema]..."
2. headlineCompany + crecimiento → "Se nota que [empresa] está en un momento..."
3. headlineCompany sin señal → "Vi lo que están haciendo en [empresa]..."
4. headlineCompany null → "Vi tu perfil como [rol]..." (FALLBACK)
```

**Regla crítica**: NUNCA usar títulos (Director General, CFO) ni ubicaciones (México, Miguel Hidalgo) como empresa.

---

## Orion — Stack técnico

- **Framework**: Next.js 14 App Router (TypeScript)
- **Auth**: Supabase Auth con middleware
- **DB client**: `@supabase/ssr` — `createClient()` server-side, `createBrowserClient()` client-side
- **Admin client**: `createAdminClient()` (service key) solo para bypass de RLS en operaciones admin
- **Estilos**: Tailwind CSS
- **Roles**: `god_admin | admin | user` — verificados via `profiles.role` en DB

### Refresh inbox manual

`RefreshInboxBtn` component → `POST /api/run-job` → `spawn('node', ['inbox.js'])` con `ACCOUNT_ID` env

---

## Operaciones de mantenimiento

### Renovar cookie LinkedIn

1. Loguear en LinkedIn en browser real
2. Extraer `li_at` cookie (DevTools → Application → Cookies)
3. Actualizar en Orion: `/dashboard/accounts` → editar cuenta
4. Si `li_at_cookie_updated_at` es viejo, PM2 genera alerta automática

### Agregar leads manualmente

1. Ir a `/dashboard/leads` → importar CSV con `linkedin_url, full_name`
2. O insertar en Supabase: `leads (campaign_id, linkedin_url, full_name, status='pending')`
3. El scheduler los scrapeará y enviará automáticamente

### Pausar una campaña

`/dashboard/campaigns/[id]/edit` → toggle `is_active = false`
O directo en DB: `UPDATE campaigns SET is_active = false WHERE id = '...'`

---

## Mejoras pendientes (priorizado)

### Alta prioridad

1. **Paginación inbox** (`syncToken`) — detectar respuestas en posición 21+
2. **Captcha detection post-click** — detectar `/checkpoint` y marcar cuenta
3. **Account locking** — evitar dos jobs paralelos en misma cuenta
4. **currentCompany fix** — esperar más tiempo o usar otra estrategia de scraping para experience

### Media prioridad

5. **Follow-up messages** — batch.js actualmente no envía mensajes de seguimiento a connected leads
6. **Diferenciación invite_sent vs message_sent** en batch.js `recordOutbound`
7. **Conversaciones page: paginación** — actualmente limit 100
8. **Monitor: aggregation queries** — 7 queries → 1 query con CASE WHEN

### Baja prioridad

9. **Mobile UI**: overflow-x-auto en tablas, sidebar hamburger
10. **Error boundaries** en Orion (`error.tsx`)
11. **Toast feedback** en forms (actualmente redirigen sin feedback visual)
12. **DB indexes** en leads(campaign_id, status), campaigns(account_id)
