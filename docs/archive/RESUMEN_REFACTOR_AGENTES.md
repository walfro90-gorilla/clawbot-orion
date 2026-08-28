> 🗄️ **ARCHIVADO (27-ago-2026) — no describe el sistema actual.**
> Este documento es de **jun-2026** y describe un sprint de hard-testing sobre la extensión v0.7.28→0.7.42.
> Dos versiones mayores atrás. Hoy: `docs/EVOLUTION.md` (línea de tiempo) y `docs/followups-flujo.md`.
> Contexto del archivo: [`docs/archive/README.md`](README.md).

---

# 🤖 Refactorización de Agentes LinkedIn — Resumen para el equipo
### Stress testing tipo "armadora" · v0.7.28 → v0.7.42 · Junio 2026
**5 agentes battle-tested · 20+ fixes · 2 envíos reales validados**

---

## 🌟 Hallazgo estrella (afectaba a TODOS los agentes)

| Tema | Detalle |
|---|---|
| ⚡ **Background-Tab Throttle** | Chrome ralentiza los timers a **~1 seg** en pestañas sin foco. El bot trabaja en segundo plano → escribir un mensaje tardaba minutos → **timeout → fallo** |
| 🎯 Impacto | Causa raíz oculta del **~59% de éxito** histórico de invitaciones y follow-ups |
| ✅ Cura de raíz (v0.7.42) | Enfocar la pestaña durante cada acción → **escribir pasó de 125s a 15s** |

---

## 🔍 Agente 1 — SEARCH (búsqueda) · 🟢 100%

| 🐛 Falla | Sev | ✅ Fix | Estado |
|---|---|---|---|
| Filtro de ubicación ignoraba acentos: `"mexico"` ≠ `"México"` → **scrapeaba 0, funnel muerto** | 🔴 | Normalización de acentos en filtros (location + empresa) | ✅ 0 → 10 perfiles |
| "Sin resultados" se reportaba como "selector roto" → falsas alarmas | 🟠 | Señal estructural (conteo de perfiles) en vez de texto | ✅ Validado |

---

## 📨 Agente 2 — SEND_INVITE (invitaciones) · 🟢 *invitación real enviada*

| 🐛 Falla | Sev | ✅ Fix | Estado |
|---|---|---|---|
| Invitación con nota se colgaba 219s (throttle al escribir) | 🔴 | Escritura por bloques (chunked) | ✅ 219s → 15s |
| Seguridad: si se colgaba, dejaba la invitación "armada" lista para enviarse | 🔴 | Limpieza garantizada del modal (vacía + cierra) | ✅ Validado |
| Comando perdido si el navegador suspendía el proceso | 🔴 | Auto-reintento seguro + telemetría (distingue "nunca llegó" vs "llegó y murió") | ✅ Desplegado |
| Agente era "caja negra" (sin trazas) | 🟡 | Checkpoints de cada paso | ✅ |

---

## 📥 Agente 3 — CHECK_SENT_INVITES (detectar aceptaciones) · 🟢 seguro + funcional

| 🐛 Falla | Sev | ✅ Fix | Estado |
|---|---|---|---|
| Sin protección: si el scraper fallaba, marcaba **TODOS los leads como aceptados** → follow-ups a gente que nunca conectó | 🔴🔴 | Guard: si scrape vacío → aborta | ✅ Cero corrupción |
| Parser roto (LinkedIn cambió estructura) → leía 0 invitaciones | 🔴 | Parser robusto que conserva la URL | ✅ 0 → 10 |
| Solo cargaba 10 de 86 (paginación) → no detectaba aceptaciones | 🟠 | Detección por ventana temporal (segura sin cargar todo) | ✅ Validado |

---

## 📬 Agente 4 — CHECK_INBOX (leer bandeja) · 🟢 core validado

| 🐛 Falla | Sev | ✅ Fix | Estado |
|---|---|---|---|
| No capturaba la URL del perfil (estructura nueva) | 🔴 | Capturarla del encabezado de la conversación | ✅ Desplegado |
| Regresión: el fix anterior causó timeout | 🔴 | Quitar la pausa innecesaria | ✅ Vuelta a 55s |

---

## 💬 Agente 5 — SEND_FOLLOWUP (seguimiento) · 🟢 *follow-up real enviado*

| 🐛 Falla | Sev | ✅ Fix | Estado |
|---|---|---|---|
| Escribía letra por letra (<300 chars) → throttle → ~200s → timeout (**la causa del 59% de éxito**) | 🔴 | Escritura por bloques desde 40 chars | ✅ 200s → 15s |
| Tono de **VENTA** (ROI, "ahorra 15%", pedía cita) | 🎯 | Cambiado a **RELACIÓN**: saludar, presentarse, mantener contacto. Configurable por cuenta | ✅ Validado |

---

## 🔧 Mejoras transversales (todos los agentes)

| Mejora | Beneficio |
|---|---|
| ⚡ Anti-throttle (enfocar pestaña) | Elimina la causa raíz de los timeouts |
| 🔄 Reporte durable | Si el navegador se desconecta, el resultado no se pierde |
| 🏷️ Telemetría precisa | Distingue fallo de infra vs fallo real (antes todo era "no respondió") |
| 🛡️ Auto-reintento seguro | Recupera comandos perdidos sin duplicar |
| 🤝 Tono relación configurable | El admin define por cuenta: relación (default) o venta |

---

## ✅ Estado final

| Agente | Estado | Validación |
|---|---|---|
| 🔍 search | 🟢 100% | Extracción, ingesta, dedup, rotación |
| 📨 send_invite | 🟢 Battle-tested | **Invitación real enviada + registrada** |
| 📥 check_sent_invites | 🟢 Seguro + funcional | Cero falsos positivos |
| 📬 check_inbox | 🟢 Core validado | Lee, matchea, 0 falsos |
| 💬 send_followup | 🟢 Battle-tested | **Follow-up real enviado + confirmado** |

**Resumen:** los 5 agentes pasaron de "tasas opacas arrastradas por bugs ocultos" a "funcionalidad verificada con telemetría clara". Causa raíz del bajo éxito (throttle) **curada de raíz**. Mensajes de seguimiento ahora **cálidos, de relación, no de venta**.

*Pendiente operativo: recargar extensión a v0.7.42 en ambas cuentas + reactivar producción.*
