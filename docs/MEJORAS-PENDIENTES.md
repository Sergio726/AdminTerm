# Mejoras pendientes

Ideas evaluadas pero **no implementadas**, con lo que se sabe hasta ahora para
que retomarlas no cueste volver a investigar desde cero.

---

## 1. Autocompletado / IntelliSense al escribir

**Estado:** pendiente. Analizado el 2026-08-07, sin implementar.

**Veredicto corto:** el rendimiento *no* es la barrera. Las barreras son que el
emulador no sabe qué estás escribiendo, y que el uso principal de esta app
(Claude Code, Codex) ocurre en pantalla alternativa, justo donde el
autocompletado del terminal tiene que estar apagado.

### Mediciones tomadas

Benchmark a nivel PTY sobre esta máquina, PowerShell con `-NoProfile`,
40 muestras:

| Medición | Resultado |
| --- | --- |
| Latencia tecla → eco | 15,8 ms (p50), 16,7 ms (p90) |
| 5000 líneas emitidas por el comando | 409 ms, **5 chunks, 1182 bytes** |
| Ritmo de chunks del PTY | ~12/s |

Dos conclusiones:

- El trabajo lo dispara el **teclado**, no la salida. A 120 ppm hay ~100 ms
  entre teclas; buscar un prefijo entre 3286 líneas de historial es
  sub-milisegundo, y ese cálculo corre en el renderer **en paralelo** al viaje
  al PTY, así que no se suma a los 15,8 ms.
- **ConPTY ya colapsa la salida**: es orientado a pantalla, no a flujo, y manda
  el viewport diferenciado. El camino de salida no está bajo presión.

### Reglas si se implementa

1. Nunca enganchar trabajo por chunk de salida. Usar
   `term.parser.registerOscHandler(133, ...)`, que solo dispara en su secuencia.
2. Toda I/O de disco asíncrona, con debounce ~100 ms y caché por directorio.
3. Desplegable como DOM encima del canvas WebGL: no toca el renderizador.
4. Apagado obligatorio con `buffer.active.type === 'alternate'` (TUI a pantalla
   completa) y en prompts de contraseña.

APIs verificadas como disponibles en xterm 6.0: `registerOscHandler`,
`registerCsiHandler`, `registerMarker`, `onWriteParsed`, `onCursorMove`,
`buffer.active.type`, `cursorX` / `cursorY`.

### Camino A — que lo haga la shell (recomendado empezar aquí)

PSReadLine trae predicción nativa (texto fantasma gris + vista de lista) desde
la versión **2.1**. Esta máquina tiene **PSReadLine 2.0.0**, que no la soporta.
Actualizando el módulo o instalando PowerShell 7 se obtiene el grueso del valor
con **cero código** en AdminTerm e impacto nulo en rendimiento: son escapes
ANSI más que renderizar.

```powershell
Install-Module PSReadLine -MinimumVersion 2.3.4 -Force -SkipPublisherCheck
Set-PSReadLineOption -PredictionSource HistoryAndPlugin -PredictionViewStyle ListView
```

Mejora posible en la app: detectar PSReadLine < 2.1 y ofrecer la actualización.

### Camino B — IntelliSense propio en el emulador

Requiere *shell integration*: un hook en el perfil de PowerShell que emita
OSC 133 (inicio de prompt, inicio de comando, fin) y OSC 7 (directorio actual).
Con eso el terminal puede leer la línea actual del buffer de xterm y saber
cuándo callarse.

| Fase | Alcance | Esfuerzo |
| --- | --- | --- |
| 1 | Inyectar shell integration + rastrear cwd | 1–2 días |
| 2 | Desplegable con historial, rutas y comandos del PATH | 3–5 días |
| 3 | Flags y subcomandos por herramienta | abierto |

La fase 1 aporta valor por sí sola aunque nunca se construya el desplegable:
permite mostrar la carpeta actual en la barra de estado y soltar archivos con
rutas relativas al cwd.

La fase 3 no es un problema técnico sino de *contenido*: alguien tiene que
mantener las especificaciones de cada CLI. Pozo sin fondo.

**Descartado:** sugerencias con LLM por pulsación. 300 ms–1 s de red y coste por
tecla. Solo tendría sentido con disparo explícito tipo `Ctrl+Espacio`.

---

## 2. Transcripción local sin depender de la nube

**Estado:** pendiente. La app **no detecta** instalaciones locales de Whisper.

Hoy el micrófono solo sabe hacer POST de audio a un endpoint HTTP con API
compatible con OpenAI. No escanea el equipo, no lanza procesos y no pide
instalar nada. El preset "Servidor local" apunta a
`http://127.0.0.1:8000/v1/audio/transcriptions`, dando por hecho que **ya tienes
un servidor escuchando ahí**.

Lo instalado en esta máquina (comprobado el 2026-08-07):

- `faster-whisper` 1.2.1 y `ctranslate2` 4.7.1 en `C:\Python311`
- Modelos ya descargados en la caché de Hugging Face: `base` (141 MB),
  `small` (464 MB), `medium` (66 MB — **descarga incompleta**, debería rondar
  1,5 GB)
- `ffmpeg` disponible en el PATH
- Nada escuchando en los puertos locales habituales

`faster-whisper` es una **librería de Python**: no trae ejecutable ni servidor,
así que no hay nada con lo que AdminTerm pueda hablar por HTTP tal cual está.

### Opciones

1. **Envolver `faster-whisper` en un servidor local mínimo** (~30 líneas con
   FastAPI + uvicorn) que exponga `/v1/audio/transcriptions`. El preset
   "Servidor local" funciona sin tocar la app, sin API key y sin conexión.
   Es la opción más limpia.
2. **Añadir un modo "comando local"** al micrófono: en vez de HTTP, escribir el
   audio a un temporal, ejecutar un comando configurable y leer su salida como
   texto. Más general (sirve para `whisper.cpp` o cualquier CLI), pero aquí
   haría falta un script de Python igualmente, porque `faster-whisper` no tiene
   CLI.
3. **Autodetección**: buscar Python + `faster-whisper` al abrir Ajustes y
   ofrecer el arranque del servidor. Cómodo, pero más piezas móviles.

Recomendado: la 1, y opcionalmente que la app incluya el script y un botón para
levantarlo.

---

## 3. Paneles anidados

**Estado:** fuera de alcance a propósito.

Cada pestaña admite hasta 4 paneles en **un solo eje** (fila o columna).
Dividir un panel ya dividido en el otro eje exigiría un árbol de disposición en
vez de una lista plana. La app lo dice claramente en vez de fallar en silencio.
Cubre el caso real (Claude en un panel, el repo en otro); si algún día estorba,
el cambio afecta a `layoutTab`, `splitActive` y `layoutSnapshot`.
