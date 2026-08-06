#!/usr/bin/env bash
# Candado del flujo company-scoped (3-ago-2026). Lee el PreToolUse JSON de stdin y, si
# el archivo a editar está en la lista congelada, pide CONFIRMACIÓN al usuario en vez de
# dejar pasar el edit en silencio. Ground truth: docs/company-scoped-flujo.md.
# Quitar un archivo del candado = borrarlo de PROTECTED (con commit que lo justifique).
INPUT="$(cat)"
printf '%s' "$INPUT" | python3 -c "
import json, sys

PROTECTED = [
    'apps/prometheus/scheduler-extension.js',
    'apps/prometheus/lib/extension-dispatch.js',
    'apps/prometheus/lib/ai-message.js',
    'apps/prometheus/extension-bridge.js',
    'apps/orion-extension/background.js',
    'apps/orion-extension/content.js',
]

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)  # sin input parseable, no bloquear nada

path = (data.get('tool_input') or {}).get('file_path') or ''
hit = next((p for p in PROTECTED if path.endswith(p)), None)
if hit:
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'ask',
            'permissionDecisionReason': (
                '🔒 ' + hit + ' es parte del flujo company-scoped CONGELADO (funcional '
                'desde 3-ago-2026, costó 15 bugs encadenados). Lee '
                'docs/company-scoped-flujo.md y corre npm run check -w apps/prometheus '
                'antes. ¿Confirmas el cambio?'
            ),
        }
    }))
sys.exit(0)
"
