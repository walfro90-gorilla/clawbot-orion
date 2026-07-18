#!/usr/bin/env bash
# backup-db.sh — pg_dump de la DB Supabase a un archivo comprimido con timestamp + retención.
#
# El FODA (17-jul-2026) rankeó "DB sin backups" como riesgo CRÍTICO #1: Supabase Free NO tiene
# PITR ni backups, y hoy corrimos DDL sin respaldo. Este script es el interin barato mientras se
# evalúa Supabase Pro. Está pensado para correr por cron nocturno en el box Upcloud.
#
# Uso:
#   SUPABASE_DB_URL='postgresql://…' ./backup-db.sh
#   (o dejar SUPABASE_DB_URL en el entorno / en un archivo de env que el cron cargue)
#
# La connection string se saca de: Supabase Dashboard → Project Settings → Database →
# Connection string → URI (usa la del "Direct connection", puerto 5432, o el pooler 6543).
# NUNCA se commitea el valor: el script solo LEE la variable de entorno.
#
# Prerrequisito: pg_dump instalado (postgresql-client). En Debian/Ubuntu: apt-get install -y postgresql-client
#
# ponytail: interin simple (pg_dump + gzip + borrar viejos). Si crece el volumen o se necesita
#           PITR real, la ruta de upgrade es Supabase Pro (backups diarios + PITR gestionados).
set -euo pipefail

# ── Config (override por env) ────────────────────────────────────────────────
BACKUP_DIR="${BACKUP_DIR:-/root/clawbot-backups}"     # dónde guardar
RETENTION_DAYS="${RETENTION_DAYS:-14}"                 # borrar dumps más viejos que esto
DB_URL="${SUPABASE_DB_URL:-}"                          # requerido

if [ -z "$DB_URL" ]; then
  echo "❌ SUPABASE_DB_URL no está seteada. Exportá la connection string de Supabase (Settings → Database → URI)." >&2
  exit 1
fi
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "❌ pg_dump no está instalado. En Debian/Ubuntu: apt-get install -y postgresql-client" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
OUT="$BACKUP_DIR/clawbot-db-$TS.sql.gz"

echo "🗄️  Dump → $OUT"
# --no-owner/--no-privileges: restaurable en cualquier proyecto sin choques de roles.
# Redirigimos a gzip por streaming (no deja el .sql plano en disco).
if pg_dump --no-owner --no-privileges "$DB_URL" | gzip -9 > "$OUT"; then
  SIZE="$(du -h "$OUT" | cut -f1)"
  echo "✅ Backup OK ($SIZE)"
else
  echo "❌ pg_dump falló — borrando dump parcial" >&2
  rm -f "$OUT"
  exit 1
fi

# ── Retención: borrar dumps más viejos que RETENTION_DAYS ────────────────────
DELETED="$(find "$BACKUP_DIR" -name 'clawbot-db-*.sql.gz' -type f -mtime "+$RETENTION_DAYS" -print -delete | wc -l)"
[ "$DELETED" -gt 0 ] && echo "🧹 Borrados $DELETED backup(s) > ${RETENTION_DAYS}d"

echo "📦 Backups actuales: $(find "$BACKUP_DIR" -name 'clawbot-db-*.sql.gz' | wc -l) en $BACKUP_DIR"
