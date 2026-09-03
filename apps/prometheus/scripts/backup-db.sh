#!/usr/bin/env bash
# backup-db.sh — pg_dump de la DB Supabase a un archivo comprimido con timestamp + retención.
#
# El FODA (17-jul-2026) rankeó "DB sin backups" como riesgo CRÍTICO #1: Supabase Free NO tiene
# PITR ni backups, y hoy corrimos DDL sin respaldo. Este script es el interin barato mientras se
# evalúa Supabase Pro. Está pensado para correr por cron nocturno en el box Upcloud.
#
# 03-sep-2026: ACTIVADO por cron cada 6 h. Pro ya da backup diario, pero PITR cuesta $100/mes para
# una DB de 56 MB — este cron da RPO de 6 h por $0 y una copia FUERA de Supabase. Cambios:
#   - credencial en ~/.pgpass (nunca en argv ni en el .env que carga el scheduler)
#   - solo schemas public + auth (los internos de Supabase no son nuestros y varios no se pueden
#     dumpear como `postgres`)
#   - verificación de integridad del dump + alerta ntfy si falla (mismo canal que el watchdog)
#
# Uso:
#   ./backup-db.sh                                     # ~/.pgpass + PGHOST/PGUSER de abajo
#   SUPABASE_DB_URL='postgresql://…' ./backup-db.sh    # override completo (legacy)
#
# Credencial: /root/.pgpass (chmod 600) con la línea
#   db.cjbvutiugmehrhdnfeta.supabase.co:5432:postgres:postgres:<password>
# La password es la de Dashboard → Settings → Database. Resetearla NO rompe nada: ningún proceso
# usa conexión directa (Orion/Prometheus van por PostgREST con la service key).
#
# Prerrequisito: pg_dump del MISMO major que el server (PG17). Ubuntu 24.04 trae 16 → instalar
# postgresql-client-17 desde el repo PGDG (apt.postgresql.org). Un major menor aborta con
# "server version mismatch".
#
# ponytail: host directo por IPv6 sin fallback. Si el IPv6 del box flaquea, el camino es el pooler
#           (aws-0-us-east-1.pooler.supabase.com:5432, user postgres.<ref>) como 2ª línea en .pgpass.
set -euo pipefail

# ── Config (override por env) ────────────────────────────────────────────────
BACKUP_DIR="${BACKUP_DIR:-/root/clawbot-backups}"     # dónde guardar
RETENTION_DAYS="${RETENTION_DAYS:-14}"                 # borrar dumps más viejos que esto
ENV_FILE="${ENV_FILE:-/root/clawbot/apps/prometheus/.env}"   # solo para leer las URLs de ops
DB_URL="${SUPABASE_DB_URL:-}"                          # opcional; sin ella manda ~/.pgpass
export PGHOST="${PGHOST:-db.cjbvutiugmehrhdnfeta.supabase.co}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGDATABASE="${PGDATABASE:-postgres}"
export PGSSLMODE="${PGSSLMODE:-require}"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-20}"

# Lee UNA clave del .env sin `source`: DIGEST_FROM lleva `<` sin comillas y rompe `. .env`.
envval() { grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '\r"' || true; }   # sin match ≠ error (pipefail)

WEBHOOK="${OPS_WEBHOOK_URL:-$(envval OPS_WEBHOOK_URL)}"
HEARTBEAT="${BACKUP_HEARTBEAT_URL:-$(envval BACKUP_HEARTBEAT_URL)}"   # opcional: check propio en healthchecks.io

# Mismo contrato que lib/notify-ops.js: ntfy = texto plano + headers ASCII; otro webhook = JSON.
alert() {
  echo "❌ $1" >&2
  [ -z "$WEBHOOK" ] && return 0
  if [[ "$WEBHOOK" == *ntfy.sh* ]]; then
    curl -fsS -m 10 -H "Title: backup-db FALLO" -H "Tags: warning,floppy_disk" -H "Priority: high" \
      -d "$1" "$WEBHOOK" >/dev/null || true
  else
    curl -fsS -m 10 -H 'Content-Type: application/json' -d "{\"text\":\"backup-db FALLO: $1\"}" \
      "$WEBHOOK" >/dev/null || true
  fi
}
die() { alert "$1"; rm -f "${OUT:-}"; exit 1; }

if [ -z "$DB_URL" ] && [ ! -r "${PGPASSFILE:-$HOME/.pgpass}" ]; then
  die "sin credencial: falta ~/.pgpass (y no hay SUPABASE_DB_URL)"
fi
command -v pg_dump >/dev/null 2>&1 || die "pg_dump no está instalado (postgresql-client-17)"

mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
OUT="$BACKUP_DIR/clawbot-db-$TS.sql.gz"

echo "🗄️  Dump → $OUT"
# --no-owner/--no-privileges: restaurable en cualquier proyecto sin choques de roles.
# Redirigimos a gzip por streaming (no deja el .sql plano en disco).
DUMP_ARGS=(--no-owner --no-privileges --schema=public --schema=auth)
[ -n "$DB_URL" ] && DUMP_ARGS+=("$DB_URL")
pg_dump "${DUMP_ARGS[@]}" | gzip -9 > "$OUT" || die "pg_dump falló — dump parcial borrado (log del cron)"

# Un dump que existe pero está truncado o vacío es peor que ninguno: se descubre al restaurar.
gzip -t "$OUT" || die "dump corrupto (gzip -t)"
zcat "$OUT" | tail -n 5 | grep -q 'PostgreSQL database dump complete' || die "dump incompleto (sin trailer de pg_dump)"
[ "$(stat -c%s "$OUT")" -gt 100000 ] || die "dump sospechosamente chico ($(stat -c%s "$OUT") bytes)"
SIZE="$(du -h "$OUT" | cut -f1)"
echo "✅ Backup OK ($SIZE)"
[ -n "$HEARTBEAT" ] && { curl -fsS -m 10 "$HEARTBEAT" >/dev/null || echo "⚠️  heartbeat no respondió" >&2; }

# ── Retención: borrar dumps más viejos que RETENTION_DAYS ────────────────────
DELETED="$(find "$BACKUP_DIR" -name 'clawbot-db-*.sql.gz' -type f -mtime "+$RETENTION_DAYS" -print -delete | wc -l)"
[ "$DELETED" -gt 0 ] && echo "🧹 Borrados $DELETED backup(s) > ${RETENTION_DAYS}d"

echo "📦 Backups actuales: $(find "$BACKUP_DIR" -name 'clawbot-db-*.sql.gz' | wc -l) en $BACKUP_DIR"
