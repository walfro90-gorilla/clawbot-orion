---
name: adr
description: Registrar una decisión de arquitectura de ClawBot como ADR en docs/adr/. Úsala cuando un cambio introduzca una dependencia externa, cambie la topología de despliegue, o tome una decisión cara de revertir — y cuando el usuario diga "documenta esta decisión", "registra un ADR", "/adr", o pregunte por qué el sistema es como es.
---

# Escribir un ADR de ClawBot

Índice y reglas vigentes: `docs/adr/README.md`. Plantilla: `docs/adr/_template.md`.

## Antes de escribir: ¿califica?

Un ADR exige **las tres**:

1. Fue una elección entre alternativas reales — **se rechazó algo concreto**.
2. Tiene consecuencias que atan el desarrollo futuro.
3. Alguien podría razonablemente intentar deshacerla sin saber por qué existe.

**Prueba rápida: si no puedes nombrar la alternativa que se descartó, no es un ADR.**

No califican: un bug arreglado, un parámetro afinado, una lección operativa, un incidente.
Eso va a `docs/bitacora-operativa.md` o `docs/EVOLUTION.md`. Dilo y ofrece ese destino en
vez de escribir un ADR flojo.

## Procedimiento

1. **Número**: `ls docs/adr/` y toma el siguiente. Nombre `NNNN-slug-kebab.md`, 4 dígitos.
2. **Copia `_template.md`** y rellénalo. No inventes secciones ni las reordenes.
3. **`Caminos descartados` no puede quedar vacío.** Es la sección que justifica el archivo.
   Si el usuario no da la alternativa rechazada, **pregúntasela** — no la deduzcas.
4. **Verifica cada SHA** con `git log -1 <sha>` antes de escribirlo. El ADR-0001 llegó a
   citar un commit que era de otra feature; ese error salió justo de no verificar.
5. **Evidencia, no adjetivos.** "46 de 104 leads eran de otra empresa" vale; "muchos leads
   incorrectos" no. Si no hay número medido, dilo explícitamente en vez de adornar.
6. **`Gobierna`**: lista los archivos que la decisión ata. No es decorativo —
   `.claude/hooks/protect-stable.sh` lo usa para nombrar el ADR cuando alguien los edite.
7. **Actualiza tres sitios**:
   - la tabla del índice en `docs/adr/README.md`;
   - el mapa `PROTECTED` de `.claude/hooks/protect-stable.sh` (y `TITULOS`);
   - `CLAUDE.md`, sustituyendo la prosa que el ADR absorbe por **una línea** con el enlace.
8. **Prueba el hook** si tocaste `PROTECTED`:
   `echo '{"tool_input":{"file_path":"<ruta>"}}' | bash .claude/hooks/protect-stable.sh`

## Reglas duras

- **`CLAUDE.md` debe encoger, no crecer.** Un ADR que solo añade contexto duplica; el "por
  qué" se **mueve**, no se copia. Comprueba con `wc -c CLAUDE.md` antes y después.
- **Un ADR no se borra ni se reescribe.** Si deja de valer, `Estado: supersedido por
  ADR-NNNN` y el nuevo explica qué cambió. Este proyecto revierte decisiones y el historial
  es el producto.
- **Escribe la decisión, no el tema.** Título afirmativo: "Una conexión se confirma por
  presencia", no "Sobre la detección de aceptaciones".
- Si la decisión **parece un bug desde fuera** (una feature a medio hacer, una asimetría,
  un valor raro como un gate `9.9.9`), dilo explícito en `Consecuencias`. Es la razón
  principal de que el archivo exista.
