# ADR-NNNN · <título afirmativo: la decisión, no el tema>

- **Estado**: aceptado (DD-mmm-AAAA)
- **Contexto que lo detona**: <una frase — el incidente concreto que obligó a decidir>
- **Gobierna**: <archivos o rutas que esta decisión ata; los lee el hook protect-stable.sh>

## El problema, dicho una sola vez

<Qué se rompía y por qué. Con evidencia — números medidos, no adjetivos. Si hay
varios incidentes del mismo origen, tabla `Fecha | Qué se rompió | Qué mostró el sistema`.>

## Decisión

**<Una frase en negrita: la regla.>**

<Luego el desarrollo. Si son varias reglas, `### 1.`, `### 2.` … con título-frase.>

## Caminos descartados — no reintroducir

<LA SECCIÓN MÁS IMPORTANTE. Un ADR sin esto no es un ADR: es una nota.>

| Camino | Por qué se descartó | Dónde murió |
|---|---|---|
| <la alternativa> | <el daño concreto que causó> | <SHA verificado con `git log -1`, o fecha> |

## Consecuencias

**A favor**: <qué ganamos>

**En contra**: <qué cuesta. Honesto. Si no hay coste, no era una decisión.>

## Cómo se aplica

<Checklist accionable, no prosa. Las preguntas que alguien debe hacerse al tocar
el código que esto gobierna.>

Relacionado: <links a otros ADR y a los docs de ground truth>
