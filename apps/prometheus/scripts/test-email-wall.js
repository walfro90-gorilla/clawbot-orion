// Self-check del detector del muro de email de LinkedIn (ext 0.10.29, 17-ago-2026).
// (copia fiel del predicado de content.js `detectInviteEmailWall`: son funciones de la
//  extensión, que no se puede importar desde Node. Si cambias una, cambia la otra.)
//
// Lo que protege, en los dos sentidos:
//  - FALSO POSITIVO: abortaría TODAS las invitaciones. Es el riesgo caro.
//  - FALSO NEGATIVO: vuelve el `sent_unconfirmed` ambiguo + modal colgado.
import assert from 'node:assert/strict'

// Copia fiel del predicado. Las señales las extrae el DOM en content.js; aquí se inyectan.
const ASKS_EMAIL_RE = /introduce su (correo|email)|introduce el (correo|email)|enter (their|the recipient)/i
const VERIFY_RE     = /comprobar que conoces|verify you know|please enter .*email/i
function isEmailWall({ modalText = '', hasEmailInput = false, sendBtnExists = true, sendDisabled = false }) {
  const txt = modalText.toLowerCase()
  const asksEmail = ASKS_EMAIL_RE.test(txt) || VERIFY_RE.test(txt)
  return (asksEmail || hasEmailInput) && (sendDisabled || !sendBtnExists)
}

// ── SÍ es muro: texto REAL del modal capturado el 17-ago ────────────────────
const REAL = '¿Añadir una nota a la invitación? Para comprobar que conoces a este miembro, '
           + 'introduce su email. También puedes incluir una nota personal. Averigua por qué '
           + 'Añadir una nota Enviar sin nota'
assert.equal(isEmailWall({ modalText: REAL, hasEmailInput: true, sendDisabled: true }), true,
  'el modal real con email + boton deshabilitado ES muro')
// Variante en inglés.
assert.equal(isEmailWall({
  modalText: 'To verify you know this member, please enter their email.',
  hasEmailInput: true, sendDisabled: true,
}), true)
// Solo el input de email, sin el texto (por si cambia la redacción).
assert.equal(isEmailWall({ modalText: 'Add a note?', hasEmailInput: true, sendDisabled: true }), true)
// Pide email y el botón ni existe.
assert.equal(isEmailWall({ modalText: REAL, hasEmailInput: true, sendBtnExists: false, sendDisabled: false }), true)

// ── NO es muro: los casos que NO deben bloquear un invite legítimo ──────────
const NORMAL = '¿Añadir una nota a la invitación? Añadir una nota Enviar sin nota'
assert.equal(isEmailWall({ modalText: NORMAL }), false, 'modal normal NO es muro')
// ⚠️ EL CASO CRÍTICO: boton deshabilitado un instante por hidratación, sin pedir email.
// Con solo la señal C, esto abortaría invites buenos. Por eso se exige tambien A o B.
assert.equal(isEmailWall({ modalText: NORMAL, sendDisabled: true }), false,
  'boton deshabilitado SIN peticion de email NO es muro (hidratacion)')
// Menciona "email" de pasada pero no lo pide ni bloquea.
assert.equal(isEmailWall({ modalText: 'Te avisaremos por email cuando responda. Enviar sin nota' }), false)
// Pide email pero el envío SÍ está habilitado (email opcional) → dejar pasar.
assert.equal(isEmailWall({ modalText: REAL, hasEmailInput: true, sendDisabled: false }), false,
  'si se puede enviar, no hay muro aunque el input exista')

console.log('✅ email-wall OK (detecta el modal real; no aborta por hidratacion ni por email opcional)')
