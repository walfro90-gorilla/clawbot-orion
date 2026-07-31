#!/usr/bin/env bash
# Actualiza la extensión que Chrome tiene cargada.
#
# POR QUÉ EXISTE ESTO: Chrome NO carga la extensión desde el repo. Carga una COPIA
# (por defecto ~/.orion/extension) que se hizo a mano una vez. Un `git pull` NO
# actualiza esa copia — el 29-jul-2026 eso mantuvo las 3 cuentas en v0.9.26 durante
# un día entero con el código nuevo ya en main y "recargando" sin efecto.
#
# Uso:
#   ./install.sh                    # destino por defecto: ~/.orion/extension
#   ./install.sh /otra/ruta         # la ruta que muestre chrome://extensions
#                                   # ("Cargada desde:" / "Loaded from:")
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-$HOME/.orion/extension}"

if [ ! -d "$DEST" ]; then
  echo "⚠️  $DEST no existe."
  echo "   Mira la ruta real en chrome://extensions (Orion Sync → 'Cargada desde')"
  echo "   y pásala como argumento: ./install.sh /esa/ruta"
  exit 1
fi

cp -r "$SRC/." "$DEST/"
rm -f "$DEST/install.sh"

echo "✅ Copiada $(grep '"version"' "$DEST/manifest.json" | tr -d ' ",') → $DEST"
echo
echo "FALTA EL PASO MANUAL (sin esto Chrome sigue con el código viejo en memoria):"
echo "  1. chrome://extensions → botón recargar (↻) en Orion Sync"
echo "  2. refrescar la pestaña de LinkedIn"
echo
echo "Verificar: la versión bajo 'Orion Sync' debe coincidir con la de arriba,"
echo "y en la DB: select label, ext_version from linkedin_accounts;"
