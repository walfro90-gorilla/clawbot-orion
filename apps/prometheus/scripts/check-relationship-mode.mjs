// Self-check del "modo relación" (vender sin vender) en el FM/auto-reply.
// buildSystemPrompt es pura (sin DB); inyectamos env dummy solo para pasar el guard
// de import de lib/supabase.js. Corre:  node apps/prometheus/scripts/check-relationship-mode.mjs
import assert from 'node:assert'
process.env.SUPABASE_URL ||= 'http://localhost'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'dummy-service-role-key-for-selfcheck'

const { buildSystemPrompt } = await import('../lib/ai-message.js')
const CAL = 'https://cal.com/x?notes=LEAD_ID%3D1'
const DIR = 'Solo saludar y construir relación. NO vender, NO agendar cita.'

// 1) Sin directive → comportamiento legacy: fm_reply_2 EMPUJA a cita + inyecta cal.
const push = buildSystemPrompt({ type: 'fm_reply_2', calUrl: CAL })
assert(push.includes('PROPÓN explícitamente una llamada'), 'legacy fm_reply_2 debe empujar cita')
assert(push.includes('LINK DE CALENDARIO PARA AGENDAR'), 'legacy debe inyectar cal incondicional')

// 2) Con directive → modo relación: NO empuja cita, cal SOLO si el lead lo pide.
const rel = buildSystemPrompt({ type: 'fm_reply_2', calUrl: CAL, toneDirective: DIR })
assert(!rel.includes('PROPÓN explícitamente una llamada'), 'modo relación NO debe empujar cita')
assert(!rel.includes('Mueve hacia la cita'), 'modo relación NO debe traer regla de mover a cita')
assert(rel.includes('PROHIBIDO proponer'), 'modo relación debe traer reglas de relación')
assert(rel.includes('ÚNICAMENTE si el lead PIDIÓ'), 'cal debe ser condicional a que el lead lo pida')
assert(rel.includes(DIR), 'debe inyectar la directriz de tono de la campaña')
assert(rel.includes(CAL), 'el cal link debe seguir disponible por si el lead lo pide')

// 3) Directive en un tipo NO-FM (invite) → sin efecto (relationshipMode solo aplica a fm_reply_*).
const inv = buildSystemPrompt({ type: 'invite', toneDirective: DIR })
assert(!inv.includes('PROHIBIDO proponer'), 'invite no debe entrar en modo relación')

console.log('✅ relationship-mode self-check OK')
