# Ops Runbook — acciones de producción (no-código)

> Acciones que **solo se ejecutan en el servidor de producción** (Upcloud, `/root/clawbot`), no en el repo.
> Salieron del FODA del 17-jul-2026: los riesgos críticos que el código no puede resolver por sí solo.
> Todo aquí es **copy-paste ready**. Corre en el box vía `ssh orion`.

---

## 1. Backups de la DB (riesgo CRÍTICO #1 — Supabase Free NO tiene backups/PITR)

Hay dos rutas; **la robusta es Supabase Pro**, el script es el interin barato.

### Opción A (recomendada a mediano plazo): Supabase Pro
Dashboard de Supabase → Settings → Billing → upgrade a **Pro** (~$25/mo). Incluye backups diarios automáticos + PITR (7 días). Cero mantenimiento. Resuelve además el bloqueo de seguridad (poder correr DDL/migraciones con red).

### Opción B (interin, gratis): cron de `pg_dump` en el box
El script ya está en el repo: [`apps/prometheus/scripts/backup-db.sh`](../apps/prometheus/scripts/backup-db.sh).

```bash
# 1. Prerrequisito (una vez): cliente de Postgres
ssh orion 'apt-get update && apt-get install -y postgresql-client'

# 2. Conseguir la connection string:
#    Supabase Dashboard → Project Settings → Database → Connection string → URI
#    (usa "Direct connection", puerto 5432). NO la pegues en el repo.

# 3. Guardar la URL en el .env de prometheus (el cron la lee de ahí):
ssh orion "grep -q '^SUPABASE_DB_URL=' /root/clawbot/apps/prometheus/.env || echo 'SUPABASE_DB_URL=postgresql://…' >> /root/clawbot/apps/prometheus/.env"
#    ↑ reemplaza postgresql://… por tu URI real

# 4. Probar a mano (debe crear un .sql.gz en /root/clawbot-backups):
ssh orion 'set -a; . /root/clawbot/apps/prometheus/.env; set +a; bash /root/clawbot/apps/prometheus/scripts/backup-db.sh'

# 5. Instalar el cron nocturno (3:17am, hora del box):
ssh orion '( crontab -l 2>/dev/null | grep -v backup-db.sh; \
  echo "17 3 * * * set -a; . /root/clawbot/apps/prometheus/.env; set +a; bash /root/clawbot/apps/prometheus/scripts/backup-db.sh >> /root/.pm2/logs/backup-db.log 2>&1" ) | crontab -'

# 6. Verificar que quedó:
ssh orion 'crontab -l | grep backup-db.sh'
```

Retención por defecto: 14 días (`RETENTION_DAYS` en el env lo cambia). Los dumps quedan en `/root/clawbot-backups`.
**Recomendado además:** copiar los dumps fuera del box (otro bucket/host) — un backup en el mismo servidor no protege contra "muere el box".

---

## 2. Alertas push — hoy NINGUNA falla llega al operador (crítico)

El watchdog (`watchdog.js`) y `notifyOps()` ya existen y están cableados en todos los caminos de falla graves, pero **son no-op mientras los env estén vacíos**. Sin esto, un scheduler/DB/box caído no avisa a nadie.

```bash
# 1. Canal de webhook (elige uno):
#    - ntfy (lo más simple, gratis): crea un topic en https://ntfy.sh/  → la URL es https://ntfy.sh/<tu-topic>
#    - Slack: Incoming Webhook → https://hooks.slack.com/services/…
#
# 2. Dead-man's-switch (para cazar "el box entero murió"):
#    - Healthchecks.io (gratis): crea un check con período 5min → copia su ping URL
#
# 3. Setear los 2 env en prometheus/.env:
ssh orion "cd /root/clawbot/apps/prometheus && \
  grep -q '^OPS_WEBHOOK_URL='   .env || echo 'OPS_WEBHOOK_URL=https://ntfy.sh/tu-topic'          >> .env; \
  grep -q '^OPS_HEARTBEAT_URL=' .env || echo 'OPS_HEARTBEAT_URL=https://hc-ping.com/tu-uuid'     >> .env"
#    ↑ reemplaza las 2 URLs por las reales

# 4. Los procesos que llaman notifyOps son prometheus-scheduler y extension-bridge → reiniciar:
ssh orion 'pm2 restart prometheus-scheduler extension-bridge'

# 5. Probar el webhook (debe llegarte un mensaje):
ssh orion 'cd /root/clawbot/apps/prometheus && set -a; . .env; set +a; \
  node -e "import(\"./lib/notify-ops.js\").then(m=>m.notifyOps(\"test\",\"🔔 test de alertas ClawBot\",{force:true}))"'
```

---

## 3. Confirmar/instalar el cron del watchdog

El watchdog corre por **cron** (no PM2), cada 2 min, 24/7. El FODA notó que su instalación no está confirmada.

```bash
# ¿Está instalado?
ssh orion 'crontab -l | grep watchdog.js || echo "❌ watchdog NO está en cron"'

# Instalarlo (la línea canónica está documentada en watchdog.js:18):
ssh orion '( crontab -l 2>/dev/null | grep -v watchdog.js; \
  echo "*/2 * * * * node /root/clawbot/apps/prometheus/watchdog.js >> /root/.pm2/logs/watchdog.log 2>&1" ) | crontab -'

# Verificar que corre (tras 2-3 min debería haber líneas):
ssh orion 'tail -20 /root/.pm2/logs/watchdog.log'
```

Requiere que `OPS_HEARTBEAT_URL` (punto 2) esté seteado, o el dead-man's-switch no pinga.

---

## Orden sugerido
1. **Backups** (punto 1) — es el riesgo #1 y desbloquea poder tocar seguridad/DDL con red.
2. **Alertas + watchdog** (puntos 2 y 3, van juntos) — convierte todos los silencios-de-muerte en aviso push.

Una vez hechos, el fix de código `B` (tile "Errores hoy" veraz, esta misma rama) tiene sentido completo: el tile in-app deja de mentir **y** las fallas graves te llegan por push.
