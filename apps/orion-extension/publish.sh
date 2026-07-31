#!/usr/bin/env bash
# SERVIDOR (prod) — publica la extensión a /opt/orion-public, que es lo que nginx sirve
# en http://<host>/download/ y lo que instala el one-liner de los operadores:
#
#   curl -fsSL http://209.50.63.149/download/install.sh | bash
#
# Sustituye a /root/deploy-extension.sh (que vivía fuera del repo, sin versionar, y que
# nadie corría: el 29-jul el endpoint seguía sirviendo v0.9.26 con v0.10.0 ya en main).
# Lo dispara solo el hook .git/hooks/post-merge de /root/clawbot en cada git pull.
#
# El tarball es FLAT a propósito: install.sh extrae SIN --strip-components, así que
# manifest.json tiene que quedar en la RAÍZ del tar.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-/opt/orion-public}"

[ -d "$DEST" ] || { echo "❌ $DEST no existe (¿es este el servidor de prod?)"; exit 1; }

cp "$SRC/content.js" "$SRC/background.js" "$SRC/manifest.json" "$DEST/"
cp -r "$SRC/icons" "$DEST/"
[ -d "$SRC/popup" ] && cp -r "$SRC/popup" "$DEST/"

# Scripts de mantenimiento fuera del bundle: el operador no los necesita en su carpeta.
tar -czf "$DEST/orion-extension.tar.gz" -C "$SRC" \
  --exclude=install.sh --exclude=publish.sh .

echo "✅ publicada $(grep '"version"' "$DEST/manifest.json" | tr -d ' ",') en $DEST"
echo "   los operadores actualizan con: curl -fsSL http://209.50.63.149/download/install.sh | bash"
