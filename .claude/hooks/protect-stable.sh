#!/usr/bin/env bash
# Candado del flujo estable (3-ago-2026) + router de ADRs (27-ago-2026). Lee el PreToolUse
# JSON de stdin y, si el archivo a editar está gobernado por una decisión registrada, pide
# CONFIRMACIÓN nombrando el ADR concreto en vez de dejar pasar el edit en silencio.
#
# Por qué existe el router: un ADR que nadie abre es un archivo muerto — le pasó al 0001
# durante cinco días. Este hook es el ÚNICO momento garantizado en que la decisión correcta
# aparece delante de quien va a romperla. Índice: docs/adr/README.md.
#
# Quitar un archivo del candado = borrarlo de PROTECTED (con commit que lo justifique).
INPUT="$(cat)"
printf '%s' "$INPUT" | python3 -c "
import json, sys

# archivo → ADRs que lo gobiernan (ver docs/adr/README.md, columna 'Gobierna')
PROTECTED = {
    'apps/prometheus/scheduler-extension.js':    ['0003', '0004', '0007'],
    'apps/prometheus/lib/extension-dispatch.js': ['0003'],
    'apps/prometheus/lib/ai-message.js':         ['0001'],
    'apps/prometheus/extension-bridge.js':       ['0004', '0005', '0006'],
    'apps/orion-extension/background.js':        ['0001', '0002'],
    'apps/orion-extension/content.js':           ['0001', '0002'],
    'apps/prometheus/lib/lead-score.js':         ['0007'],
    'apps/prometheus/lib/company-match.js':      ['0006'],
}

# Subconjunto del flujo company-scoped CONGELADO (3-ago-2026). No todo archivo gobernado
# por un ADR está congelado: lead-score.js y company-match.js son posteriores al candado.
CONGELADOS = {
    'apps/prometheus/scheduler-extension.js',
    'apps/prometheus/lib/extension-dispatch.js',
    'apps/prometheus/lib/ai-message.js',
    'apps/prometheus/extension-bridge.js',
    'apps/orion-extension/background.js',
    'apps/orion-extension/content.js',
}

TITULOS = {
    '0001': 'Nada degrada en silencio',
    '0002': 'Las acciones de LinkedIn se ejecutan en la sesión y la IP del usuario',
    '0003': 'En modo empresa nunca se busca por título suelto',
    '0004': 'Una conexión se confirma por presencia, nunca por ausencia',
    '0005': 'Matar un lead para siempre solo si el contacto nos eliminó',
    '0006': 'La empresa y la geografía se verifican al ingerir, no en la URL de búsqueda',
    '0007': 'El picker de invitaciones ordena; filtrar es otra cosa',
}

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)  # sin input parseable, no bloquear nada

path = (data.get('tool_input') or {}).get('file_path') or ''
hit = next((p for p in PROTECTED if path.endswith(p)), None)
if hit:
    adrs = PROTECTED[hit]
    lista = '; '.join('ADR-%s (%s)' % (n, TITULOS[n]) for n in adrs)
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'ask',
            'permissionDecisionReason': (
                '🔒 ' + hit + ' está gobernado por decisiones registradas: ' + lista + '. '
                'Léelas en docs/adr/ (sobre todo la tabla \"Caminos descartados\") antes de '
                'cambiar comportamiento — varias de esas decisiones PARECEN bugs desde fuera. '
                + ('Es además parte del flujo company-scoped CONGELADO (costó 15 bugs '
                   'encadenados): lee docs/company-scoped-flujo.md. ' if hit in CONGELADOS else '')
                + 'Corre npm run check -w apps/prometheus antes de dar por bueno el cambio. '
                '¿Confirmas?'
            ),
        }
    }))
sys.exit(0)
"
