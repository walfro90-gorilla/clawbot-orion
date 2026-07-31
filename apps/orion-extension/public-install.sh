#!/bin/bash
# Orion Sync — Installer Mac/Linux
# Uso: curl -fsSL http://209.50.63.149/download/install.sh | bash

set -e

cat <<'EOF'

  ___       _
 / _ \ _ __(_) ___  _ __
| | | | '__| |/ _ \| '_ \
| |_| | |  | | (_) | | | |  Sync
 \___/|_|  |_|\___/|_| |_|

EOF

INSTALL_DIR="${HOME}/.orion/extension"
TARBALL_URL="http://209.50.63.149/download/orion-extension.tar.gz"
TARBALL_PATH="$(mktemp -d)/orion-extension.tar.gz"

# Si la carpeta ya existe, esto es una ACTUALIZACION: los pasos son otros (recargar,
# no volver a cargar). Distinguirlo evita el fallo del 29-jul-2026: se copiaron los
# archivos nuevos, nadie recargo, y Chrome siguio ejecutando la version vieja en memoria.
IS_UPDATE=0
[ -d "$INSTALL_DIR" ] && IS_UPDATE=1

echo "[1/3] Descargando..."
curl -fsSL "$TARBALL_URL" -o "$TARBALL_PATH"

echo "[2/3] Extrayendo a $INSTALL_DIR"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xzf "$TARBALL_PATH" -C "$INSTALL_DIR"
rm -f "$TARBALL_PATH"

VERSION="$(grep '"version"' "$INSTALL_DIR/manifest.json" | tr -d ' ",' | cut -d: -f2)"

echo "[3/3] Listo! Version $VERSION en:"
echo "  $INSTALL_DIR"
echo ""
if [ "$IS_UPDATE" = "1" ]; then
    echo "ACTUALIZACION — Chrome AUN corre la version vieja en memoria. Falta:"
    echo "  1. Se va a abrir chrome://extensions en 3 segundos"
    echo "  2. Busca 'Orion Sync' y dale al boton RECARGAR (flecha circular)"
    echo "  3. Refresca la pestana de LinkedIn"
    echo "  4. Confirma que debajo de 'Orion Sync' diga: $VERSION"
else
    echo "Siguiente paso (1 vez por Chrome):"
    echo "  1. Se va a abrir chrome://extensions en 3 segundos"
    echo "  2. Activa 'Modo de desarrollador' (esquina superior derecha)"
    echo "  3. Click 'Cargar extension sin empaquetar'"
    echo "  4. Selecciona la carpeta:"
    echo "     $INSTALL_DIR"
fi
echo ""

# Copiar path al clipboard (Mac + Linux + WSL)
if command -v pbcopy &> /dev/null; then
    echo -n "$INSTALL_DIR" | pbcopy && echo "[Path copiado al portapapeles]"
elif command -v xclip &> /dev/null; then
    echo -n "$INSTALL_DIR" | xclip -selection clipboard && echo "[Path copiado al portapapeles]"
elif command -v wl-copy &> /dev/null; then
    echo -n "$INSTALL_DIR" | wl-copy && echo "[Path copiado al portapapeles]"
fi

sleep 3

# Abrir chrome://extensions
if [[ "$OSTYPE" == "darwin"* ]]; then
    open -a "Google Chrome" "chrome://extensions/" 2>/dev/null || \
    open -a "Chrome" "chrome://extensions/" 2>/dev/null || \
    echo "Chrome no encontrado. Abre manualmente chrome://extensions"
elif command -v google-chrome &> /dev/null; then
    google-chrome "chrome://extensions/" &> /dev/null &
elif command -v chromium &> /dev/null; then
    chromium "chrome://extensions/" &> /dev/null &
elif command -v xdg-open &> /dev/null; then
    xdg-open "chrome://extensions/" &> /dev/null &
else
    echo "Browser no detectado. Abre manualmente chrome://extensions"
fi
