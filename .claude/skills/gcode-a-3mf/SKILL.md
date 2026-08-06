---
name: gcode-a-3mf
description: Empaquetar g-code propio en un .gcode.3mf imprimible en la Bambu A1, y calibrar patrones calados (celosía, malla) de FullControl. Usar al generar, adaptar o empaquetar g-code para esta impresora, al tocar src/bambu.ts, al ajustar parámetros de un bowl calado, o cuando una pieza sale descolgada, sin soldar o el preview se ve mal.
---

# G-code propio → .gcode.3mf en la A1

Cada regla de acá costó al menos una impresión perdida. Están ordenadas por lo
caro que sale ignorarlas.

## Regla cero: medí el archivo generado, no confíes en el código

Cada bug de esta lista se veía bien en el código y estaba mal en el `.gcode`. La
verificación siempre es la misma: **descomprimir el `.3mf`, leer
`Metadata/plate_1.gcode`, y contar**.

```bash
unzip -q pieza.gcode.3mf -d /tmp/v
G=/tmp/v/Metadata/plate_1.gcode
[ "$(md5 -q $G | tr a-z A-Z)" = "$(cat $G.md5)" ] && echo "md5 OK" || echo "md5 MAL"
n=$(grep -n "body grafted" $G | cut -d: -f1)
sed -n "${n},\$p" $G | grep -o '^M106 S[0-9]*' | sort -u   # ventilador
sed -n "${n},\$p" $G | grep -o '^M104 S[0-9]*' | sort -u   # temperatura
```

## El contenedor

El A1 no arranca un `.gcode` pelado: solo acepta `.gcode.3mf`. **El CLI de Orca
no puede enviar** — verificado en 2.4.2, no hay `--send`/`--upload`/
`--print-host`; "Upload & Print" existe solo en la GUI. **Usar Orca, no Bambu
Studio**: Orca abre `.gcode.3mf` y tiene modo LAN completo (IP + Access Code).

El 3mf **no lleva geometría** (`3D/3dmodel.model` tiene `<resources/>` y
`<build/>` vacíos), así que cambiar `Metadata/plate_1.gcode` es todo el trabajo.
En Orca, la pestaña Prepare queda vacía y eso es normal: todo está en Preview.
**No apretar "Slice plate"** — no hay nada que cortar y reemplaza el g-code.

Cosas que hay que reescribir al injertar, todas load-bearing:

- **`plate_1.gcode.md5`** — el firmware lo verifica. Hex MAYÚSCULA, sin newline.
- **`G29 A1 X.. Y.. I.. J..`** — es la malla de cama adaptativa, y X/Y/I/J son la
  esquina mínima y el tamaño de la **primera capa**. Sin reapuntarlo, palpa la
  huella del objeto del template y no nivela nada debajo del nuestro.
- **`M73`** — el head del template trae los del objeto viejo; el cubo llega a P47
  solo con su start gcode, así que la pantalla salta al 47 % antes de la primera
  extrusión y se queda ahí toda la impresión.

## Lo que el template controla y lo que no

| | de dónde sale |
|---|---|
| Temperatura | **del template** (los `M104/M109` de la fuente se descartan) |
| Ventilador | **del g-code fuente** (hay que restaurarlo explícito) |
| Boquilla, cama, material | del template |

**Ese reparto es la trampa más cara.** FullControl pone su `M106 S255` DENTRO del
bloque de start gcode, arriba del marcador `FIN DEL START GCODE`. Cortar por el
marcador dejaba el ventilador **apagado toda la pieza**: el material nunca cuaja,
los hilos se descuelgan unos sobre otros y un calado colapsa en un bloque. El
empaquetador ahora arrastra el estado (`G90/G91`, `M82/M83`, `M106`) a través del
corte y lo re-declara. Al tocar `extractBody`, mantener eso.

Para cambiar de material hay que exportar **otro template** desde Orca con ese
filamento. Cambiar el `Perfil` de Python no sirve: sus temperaturas se descartan.

## La metadata del visor MANDA, no describe

Los visores (Orca, Bambu Studio) construyen su render de los comentarios, no de
los movimientos. Un comentario equivocado es peor que ninguno.

- **`; Z_HEIGHT:`** pisa la Z de los `G1`. Emitir uno solo al inicio del injerto
  renderizó un bowl de 58 mm como un panqueque plano, con la barra de estado
  mostrando `Z 0.400` en una línea cuyo texto decía `Z57.104454`.
- **`; LAYER_HEIGHT:`** define el ANCHO dibujado, porque el visor calcula
  `ancho = volumen / (largo · LAYER_HEIGHT)`. El g-code fija el **área** del
  cordón, no su forma. Pasarle el paso de la espiral (1.156 mm) dibujó cordones
  de 0.277 mm en vez de 0.800 y una base maciza se veía llena de huecos.
  **Paso de espiral ≠ altura del cordón.** Derivar la altura del flujo.
- **`; FEATURE:`** — sin él todo cae en "Custom" y el visor reporta ~0 s de
  impresión de modelo.
- Los marcadores de capa deben reaccionar a que la Z **se aleje** de la última
  anunciada, en cualquier dirección. Un umbral que solo sube se dispara en el
  viaje entre piezas y las posteriores no se dibujan.

El preview de esta extensión (`media/main.js`) dibuja **líneas** desde los X/Y/Z/E
reales y no lee ningún comentario — por eso nunca muestra estos bugs. Las dos
vistas fallan distinto, y eso es útil.

## Adaptar g-code ajeno

Al recortar el start gcode de otra impresora, **el corte no va donde parece**.
En el "Squeezy Fidget Toy" el autor había puesto `M104 S240` (bajar de 250 a 240
para imprimir) y `M106 S0` DENTRO del bloque marcado como editable. Cortar por
el marcador de cierre se los llevó y la pieza corrió 10 °C más caliente: no
solidificaba y se descolgaba.

Y aunque se conserven, **el camino genérico del empaquetador filtra todo `M104`**
(para no heredar el calentado de la fuente). La salida es envolver el cuerpo
adaptado en los marcadores de FullControl:

```gcode
M83                                  ← antes del marcador: estado a restaurar
M106 S0
;===== FIN DEL START GCODE =====
M104 S240                            ← después: sobrevive verbatim
... la pieza ...
;===== END GCODE - fin =====
```

Revisar siempre el bbox y recentrar: una pieza para cama de 180×180 viene
centrada en (90, 90) y en la A1 (256×256) queda descentrada.

## Patrones calados (celosía)

El patrón suelda **solo en los cruces**; entre ellos el cordón puentea al aire
**por diseño**. "Tiene huecos" nunca es el bug.

**La medición que responde "¿sueldan?"**: diferencia de Z entre vueltas
consecutivas **al mismo ángulo**, mínimo sobre la vuelta. Comparar el mínimo de
una contra el máximo de la anterior no dice nada — están en lados opuestos.
Desenrollar el ángulo, muestrear Z a fase fija, restar. Mínimo negativo =
interferencia = soldadura real.

**La segunda métrica**: por vuelta, el **arco continuo más largo sin apoyo**. Una
vuelta sana ronda 2.4–3.6 mm; decenas de mm es un anillo suelto. El porcentaje
apoyado solo lo esconde: 9 % apoyado puede ser un único puente de 70 mm.

Relaciones que gobiernan el diseño:

- **mordida** = `2·amplitud_z·solape`. Contra un cordón de 0.4 mm: `solape` 0.15
  da 0.09 (se rozan), 0.30 da 0.30 (suelda), 0.45 da 0.51 (la boquilla ara).
- **hueco al final de la vuelta de transición** = `2·amplitud_z·(1−2·solape)`.
  Tiene que quedar **≤ la altura del cordón**. Con `amplitud_z` 0.7 daba +0.56 y
  una vuelta flotaba 19 mm; con 0.5 da +0.40 y desaparece.
- **`capas_transicion` funciona al revés de la intuición.** La rampa suave rompe
  el arranque: mientras la amplitud sube, las primeras vueltas ondulan poco,
  nunca bajan a morder y quedan apiladas sin soldar. Medido sobre el arco
  flotante de la vuelta 2: ct=0 → 19 mm, ct=6 → 70, ct=30 → 93.
- **`capas_base` no arregla, solo mueve** la vuelta mala hacia arriba.

## Qué se puede modular y qué no

**El ventilador NO se modula por nodo.** Se intentó y el resultado fue que **no
arranca nunca**: 6463 comandos, cada nivel sostenido 64 ms (15.6 Hz) contra un
blower que tarda 500–1000 ms en cambiar de régimen — 10× más rápido de lo que
puede. Además, por debajo de ~30 % no arranca desde parado. **Fijo.**

**Velocidad y ancho sí**: el planificador obedece al instante (500 mm/s² hace que
pasar de 10 a 2 mm/s tome 0.01 s) y el ancho es solo cuánta E se empuja.

**El ancho va en ESCALÓN, no en rampa** — blob gordo en el cruce, hilo fino en el
vano. Medido en el gcode del Squeezy: 0.950 mm² horizontal contra 0.501 mm² en
pendiente. Gana en los dos frentes: menos masa colgando y más material donde
suelda. Una rampa lineal reparte mal las dos cosas.

**Tercera palanca: parar.** `G1 E-1.5` → `G4 P1500` → `G1 E1.5` en el cruce deja
cuajar la soldadura antes de salir al aire. La retracción no es opcional (si no,
grumo); en extrusión relativa se cancela sola y no ensucia la contabilidad de E.
Va en el **cruce**, no en el pico: en el pico el material está en el aire y la
pausa solo le da tiempo de descolgarse. Cuesta caro: 430 cruces × 1.5 s = 11 min.

## Placas de varias probetas

- **La separación la manda el CUERPO DEL CABEZAL, no la punta.** Con 40 mm entre
  centros el cabezal tumbó las probetas ya impresas aunque un chequeo de colisión
  de la punta pasara limpio. 80 mm para piezas de 28 mm.
- **Los viajes son tres movimientos**: subir vertical, viajar a Z constante,
  bajar sobre terreno vacío. En uno solo el descenso se interpola y la boquilla
  atraviesa la pieza recién terminada.
- **El estimador de altura de capa asume UNA pieza.** Cuenta revoluciones
  alrededor de un centro único; con dos probetas ese centro cae entre ambas y da
  0.002 mm / 7638 capas. Estimar solo sobre la primera (detectar la caída de Z).
- **El ventilador hay que fijarlo explícito por probeta** con `fc.Fan`: el start
  gcode de la segunda en adelante se descarta, y heredaría el de la primera.
- Cambiar **un solo parámetro** por probeta (OFAT). Con 3 variables el factorial
  completo son 8 piezas.
- Conservar el **largo del puente** (`2πr / n_nodos`) al achicar la probeta, o la
  prueba no dice nada sobre la pieza real.

## Cosas ya resueltas — no volver a investigarlas

- El CLI de Orca no puede enviar. Cerrado.
- Velocidad y temperatura no eran la causa del calado que no soldaba: falló a
  2 mm/s con ventilador, y el template ya corre a 220 °C (PLA) / 250 (PETG).
- Bajar el ventilador "para mejorar la adhesión entre capas" es consejo de
  piezas macizas. Esto es un patrón de puentes: para PLA en modo vaso el
  consenso es 100 % después de la capa 1.

## Señales físicas que ningún parámetro arregla

- **Estallidos durante la extrusión = filamento húmedo.** PETG es muy
  higroscópico. Contamina toda medición: extrusión inconsistente, más descuelgue
  y peor adhesión. Secar 65 °C, 6-8 h. Un confundidor así afecta a todas las
  probetas por igual, así que una **comparación** entre ellas sigue siendo válida
  aunque la calidad absoluta no lo sea.
- **Cordón picado, peludo o de ancho irregular** → humedad.
  **Cordón limpio pero vueltas separadas** → parámetros.

## PETG transparente

La luz se dispersa en interfaces: huecos de aire y fronteras de capa mal
fundidas. Boquilla 250–260, ventilador 0–20 %, sobre-extruir un poco, boquilla
grande, filamento seco. Modo vaso ya es el mejor caso (sin relleno ni costura).

**Claridad y calado se pelean**: la claridad quiere el ventilador apagado, el
puente lo quiere al máximo. Salida: controlar el descuelgue con **velocidad**, no
con ventilador — las dos atacan lo mismo pero solo el ventilador arruina la
transparencia.
