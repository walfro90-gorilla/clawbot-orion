# Ops Runbook — acciones de producción (no-código)

> Acciones que **solo se ejecutan en el servidor de producción** (Upcloud, `/root/clawbot`), no en el repo.
> Salieron del FODA del 17-jul-2026: los riesgos críticos que el código no puede resolver por sí solo.
> Todo aquí es **copy-paste ready**. Corre en el box vía `ssh orion`.

---

## 1. Backups de la DB

Estado (03-sep-2026): **las dos capas están activas.**

- **Supabase Pro** (desde 01-sep): backup diario gestionado. PITR (RPO de segundos) cuesta **$100/mes** aparte — descartado para una DB de 56 MB; el mail de Supabase que lo ofrece ("2.4 million requests a month") usa como gancho nuestro propio polling (~75k req/día), no crecimiento de uso.
- **Cron de `pg_dump` en el box cada 6 h** (`apps/prometheus/scripts/backup-db.sh`): RPO de 6 h por $0 y una copia FUERA de Supabase — cosa que PITR no da. Dumps en `/root/clawbot-backups`, retención 14 días (`RETENTION_DAYS`), solo schemas `public` + `auth`. Si falla, alerta al mismo ntfy del watchdog (`OPS_WEBHOOK_URL`) y borra el dump parcial.

### Activación / re-instalación del cron

```bash
# 1. pg_dump del MISMO major que el server (PG17). Ubuntu 24.04 trae el 16 → PGDG:
ssh orion 'install -d /usr/share/postgresql-common/pgdg && \
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc && \
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
  apt-get update -qq && apt-get install -y -qq postgresql-client-17 && pg_dump --version'

# 2. Credencial en ~/.pgpass (la password de Dashboard → Settings → Database; resetearla no rompe
#    nada: ningún proceso usa conexión directa). Se teclea a ciegas, nunca pasa por el chat ni por argv:
ssh -t orion 'umask 077; printf "password de la DB: "; read -rs PW; echo; \
  printf "db.cjbvutiugmehrhdnfeta.supabase.co:5432:postgres:postgres:%s\n" "$PW" > /root/.pgpass; ls -l /root/.pgpass'

# 3. Probar a mano (debe crear un .sql.gz en /root/clawbot-backups y decir "Backup OK"):
ssh orion 'bash /root/clawbot/apps/prometheus/scripts/backup-db.sh'

# 4. Instalar el cron (cada 6 h, minuto 7 UTC). NO hagas `. .env` en el cron: DIGEST_FROM lleva `<`
#    sin comillas y rompe el source; el script lee lo que necesita del .env con grep.
ssh orion '( crontab -l 2>/dev/null | grep -v backup-db.sh; \
  echo "7 */6 * * * bash /root/clawbot/apps/prometheus/scripts/backup-db.sh >> /root/.pm2/logs/backup-db.log 2>&1" ) | crontab -'

# 5. Verificar que quedó:
ssh orion 'crontab -l | grep backup-db.sh; tail -3 /root/.pm2/logs/backup-db.log'
```

### Restaurar (drill: ver bitácora 03-sep-2026; se hace contra un Postgres 17 en Docker local)

```bash
scp orion:/root/clawbot-backups/clawbot-db-<TS>.sql.gz .
docker run -d --name pg-restore -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:17
zcat clawbot-db-<TS>.sql.gz | docker exec -i pg-restore psql -U postgres -v ON_ERROR_STOP=0 -q
docker exec pg-restore psql -U postgres -c 'select count(*) from public.leads'
```
Para volver a un proyecto Supabase: restaurar `public` con `psql` sobre la connection string del proyecto nuevo (los `CREATE EXTENSION` y roles ya existen ahí — ignorar esos errores).

### Pendientes NO urgentes (decidido 04-sep-2026: documentar y hacer después)

Lo crítico ya está: la DB tiene backup diario (Pro) + dumps cada 6 h probados con restore. Estos tres
cierran huecos secundarios; ninguno protege datos que hoy estén sin copia.

**a) Snapshot del box en Upcloud** — cubre "muere el server" (código en git, keys regenerables; los
dumps del box son la 2ª copia de la DB, no la única).
Hub → Servers → el server → pestaña **Backups** → *Simple Backup* plan **Daily** (7 d basta). El precio
sale antes de confirmar (proporcional al disco de 60 GB). *Take backup* = uno manual para probar.
Verificación: el snapshot aparece listado con hora.

**b) Check en healthchecks.io para el cron** — cubre "el cron dejó de correr y nadie lo supo" (el script
solo alerta cuando **él** falla). Misma cuenta del check `clawbot-orion-box`:
*Add Check* → nombre `clawbot-db-backup` · Period **6 h** · Grace **1 h** → copiar la ping URL.

```bash
# guardar la URL en el .env de prod sin que pase por el chat (la pegas cuando pida)
ssh -t orion 'printf "ping URL: "; read -r U; F=/root/clawbot/apps/prometheus/.env; grep -q "^BACKUP_HEARTBEAT_URL=" $F && echo "ya existía, no toqué" || printf "BACKUP_HEARTBEAT_URL=%s\n" "$U" >> $F; echo "claves BACKUP_HEARTBEAT_URL: $(grep -c "^BACKUP_HEARTBEAT_URL=" $F)"'
# primer ping: un backup a mano (el script lee el .env con grep en cada corrida; nada que reiniciar)
ssh orion 'bash /root/clawbot/apps/prometheus/scripts/backup-db.sh'
```
Verificación: el check pasa a **Up** en segundos.

**c) Entrecomillar `DIGEST_FROM` en el `.env` de prod** — fix de raíz de que `set -a; . .env` truene.
Cosmético: solo afecta a humanos en shell; el script y los procesos (dotenv) no lo sufren.

```bash
ssh orion 'cd /root/clawbot/apps/prometheus && cp -p .env .env.bak-$(date +%F) && sed -i "s|^DIGEST_FROM=Orion Lead Connections <digest@ebooms.com>\$|DIGEST_FROM=\"Orion Lead Connections <digest@ebooms.com>\"|" .env && grep -n "^DIGEST_FROM=" .env'
# verificación doble: dotenv devuelve el valor SIN comillas y source ya no truena
ssh orion 'cd /root/clawbot/apps/prometheus && node -e "require(\"dotenv\").config(); console.log(JSON.stringify(process.env.DIGEST_FROM))" && (set -a; . ./.env; set +a; echo "source OK")'
```
Esperado: `"Orion Lead Connections <digest@ebooms.com>"` y `source OK`. Sin reinicio (mismo valor en
memoria). Si difiere: `cp .env.bak-<fecha> .env`.

**d) (más adelante) copia off-site de los dumps** (S3/Backblaze) — requiere credenciales nuevas; el IAM
`clawbot-dns` es solo Route 53. El snapshot Upcloud de (a) cubre el 90 % del caso mientras tanto.

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
