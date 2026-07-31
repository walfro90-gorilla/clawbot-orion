# Orion Sync — Chrome Extension

Extensión Manifest V3 que ejecuta acciones de LinkedIn (invites, follow-ups, inbox checks)
**dentro del browser del usuario, con su IP real**. Resuelve el conflicto multi-IP que mata
cookies cuando server-side + browser personal usan la misma cuenta.

## Arquitectura

```
[Tu Chrome + Orion Sync extension]
       │ WebSocket
       ▼
[extension-bridge.js (Node WS server, puerto 4002)]
       │ Postgres
       ▼
[Orion server] ◄── orquesta, AI gen, scheduling
       │
       ▼
[scheduler.js] inserta comandos en extension_commands queue
       │
       ▼
[bridge polea queue, despacha por WS a la extension correcta]
       │
       ▼
[content.js ejecuta acción DOM en linkedin.com tab]
       │ (usa tu IP, tu sesión, tu fingerprint real)
       ▼
[Resultado → bridge → DB]
```

## Componentes

| Archivo | Responsabilidad |
|---|---|
| `manifest.json` | MV3 spec, permisos cookies+tabs+scripting, host linkedin.com |
| `background.js` | Service worker — mantiene WebSocket con bridge, despacha a content |
| `content.js` | Inyectado en linkedin.com — ejecuta acciones DOM (invite, FU, inbox) |
| `popup/popup.html` + `.js` | UI para configurar Orion URL + API key + cuenta |
| `icons/` | PNGs del logo (placeholders, reemplazar con logo real) |

## ⚠️ Actualizar la extensión (leer antes de "por qué no agarra el cambio")

**Chrome NO carga esta carpeta del repo.** Carga una **copia** (`~/.orion/extension` en
Mac/Linux, `%LOCALAPPDATA%\Orion\extension` en Windows). `git pull` deja el repo al día
pero **no toca esa copia** → la extensión sigue corriendo el código viejo aunque le des
a "recargar".

**Operadores** (Josh, Café 57, Wal) — un comando, se baja del server de prod:

```bash
curl -fsSL http://209.50.63.149/download/install.sh | bash     # Mac / Linux
irm http://209.50.63.149/download/install.ps1 | iex            # Windows (PowerShell)
```

**Dev** (probar cambios locales sin publicar): `./sync-local.sh` copia esta carpeta a
`~/.orion/extension`.

Después, **sí o sí**: `chrome://extensions` → recargar (↻) → refrescar la pestaña de
LinkedIn. La versión que reporta cada cuenta se ve en `linkedin_accounts.ext_version`;
si no coincide con `manifest.json`, la actualización no llegó.

### Publicar al endpoint /download (servidor)

`publish.sh` copia esta carpeta a `/opt/orion-public` (lo que sirve nginx) y regenera el
tarball + los instaladores. Lo dispara solo el hook `post-merge` de `/root/clawbot`, así
que **cada `git pull` en prod republica**. A mano: `./publish.sh`.

| Archivo | Qué es |
|---|---|
| `sync-local.sh` | dev: repo → `~/.orion/extension` (sin publicar) |
| `publish.sh` | servidor: repo → `/opt/orion-public` (tarball + instaladores) |
| `public-install.sh` / `.ps1` | lo que corre el operador; nginx los sirve como `/download/install.sh` y `.ps1` |

## Setup local (dev)

### 1. Generar API key para una cuenta

En la DB (vía Supabase SQL o `/dashboard/accounts` UI):

```sql
UPDATE linkedin_accounts
SET extension_api_key = 'orion_sk_' || encode(gen_random_bytes(16), 'hex')
WHERE label = 'Josh'
RETURNING id, extension_api_key;
```

Anota el `id` (account_id) y el `extension_api_key`.

### 2. Cargar extension en Chrome

1. Abre `chrome://extensions/`
2. Activa "Modo de desarrollador" (toggle arriba derecha)
3. Click "Cargar descomprimido"
4. Selecciona `/root/clawbot/apps/orion-extension/`
5. La extension aparece en la barra (icono "O")

### 3. Configurar conexión

1. Click en el icono de la extension → popup
2. **Orion URL**: `http://localhost:4002` (o `http://209.50.63.149:4002` desde fuera del VPS)
3. **API Key**: el valor `orion_sk_...` del paso 1
4. **Cuenta activa**: el `account_id` UUID
5. Click "Conectar"

Si todo OK, verás el badge verde (●) y el popup dirá "Conectado".

### 4. Verificar en el server

```bash
# Health endpoint del bridge
curl http://localhost:4002/health

# Esperado:
# {"ok":true,"connected_accounts":[{"accountId":"...","label":"Josh","lastSeen":...}],"uptime":...}
```

O en logs:
```bash
pm2 logs extension-bridge --lines 20
# Esperado: "[bridge] ✅ Auth OK: Josh (2ea4a7f2)"
```

## Estado de implementación (sub-fases)

- [x] 2.1 — Scaffold + WebSocket connectivity ✅
- [ ] 2.2 — Comando `check_inbox` (stub) — siguiente
- [ ] 2.3 — Comando `send_invite`
- [ ] 2.4 — Comando `send_followup`
- [ ] 2.5 — Comando `search`
- [ ] 2.6 — Onboarding flow desde Orion UI (botón "Conectar extension")

Hoy la extension se conecta + autentica + acepta el handshake. Las acciones DOM siguen en stub.
La próxima sub-fase (2.2) implementa la primera acción real: `check_inbox`.

## Testing manual del flow ahora

1. Setup como arriba — extension conectada
2. Insertar un comando de prueba:
   ```sql
   INSERT INTO extension_commands (account_id, action, payload)
   VALUES ('<josh-account-id>', 'check_inbox', '{}'::jsonb)
   RETURNING id;
   ```
3. En ~3 seg el bridge despachará. En logs del background extension verás:
   ```
   [Orion] Server msg: command
   [Orion] Executing check_inbox (cmd ...)
   [Orion content] Command check_inbox (...)
   ```
4. La extension ejecuta el stub y reporta. Verifica en DB:
   ```sql
   SELECT status, result FROM extension_commands ORDER BY created_at DESC LIMIT 1;
   ```
   Esperado: `status='completed'`, `result.status='not_implemented'`.

Esto valida el flow end-to-end **antes** de implementar las acciones reales.

## Privacidad y seguridad

- API key se guarda solo en `chrome.storage.local` del usuario (no sincroniza a Google account)
- WebSocket reusa connection mientras Chrome está abierto (no abre nueva por cada comando)
- Extension solo lee cookies de `.linkedin.com` (no toca otras webs)
- Comandos vencen en 10 min si extension desconecta (`expires_at`)
- Resultados se guardan en `extension_commands.result` (JSONB, auditable)

## Limitaciones conocidas (MV3)

- Service worker se duerme cada 30s idle → keep-alive con `chrome.alarms` cada 24s
- En reconexión, la primera acción puede tardar 2-5s extra (cold start del SW)
- Chrome cerrado completamente = bot inactivo (es el trade-off aceptado de esta arch)
