# ClawBot — comandos operativos

## PM2 (4 procesos reales)
```bash
pm2 list                               # estado: orion, prometheus-scheduler, extension-bridge, xvfb
pm2 logs prometheus-scheduler --lines 50
pm2 logs extension-bridge --lines 50
pm2 restart orion                      # tras rebuild de Next
pm2 restart prometheus-scheduler
pm2 save                               # PERSISTE el set de procesos (necesario para resurrect)
pm2 resurrect                          # recuperación real tras reboot (NO usar ecosystem.config.cjs: está stale)
```
⚠️ `pm2 start ecosystem.config.cjs` levanta el set EQUIVOCADO (solo orion + viejo scheduler.js, sin bridge ni xvfb). Usa `pm2 resurrect`.

## Orion (Next.js)
```bash
cd /root/clawbot/apps/orion
npm run build && pm2 restart orion
npm run lint
npm run dev                            # desarrollo local :3000
```

## Prometheus (backend)
```bash
cd /root/clawbot/apps/prometheus
# El orquestador real es scheduler-extension.js (NO scheduler.js)
pm2 logs prometheus-scheduler          # ver ticks en vivo
```

## Tipos de Supabase
```bash
cd /root/clawbot
npm run types                          # regenera packages/db-types/database.types.ts
# = supabase gen types typescript --project-id cjbvutiugmehrhdnfeta > database.types.ts
```

## Extensión Chrome
- Editar `apps/orion-extension/{background,content}.js` o `manifest.json`.
- **Recargar la extensión** en `chrome://extensions` + recargar pestaña LinkedIn por cada cuenta (Wal, Josh).

## DB
- Inspección/queries: **MCP de Supabase** (`list_tables`, `execute_sql`, `get_advisors`, `get_logs`). Project id: `cjbvutiugmehrhdnfeta`.

## Env
- Prometheus: `apps/prometheus/.env` → `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY` (no en repo).
- Orion: `apps/orion/.env.local` → vars de Supabase + auth.
