# AdminTerm

Terminal de escritorio mínima para Windows: abre una shell **con privilegios de
administrador**, con tipografía monoespaciada legible, **dictado por micrófono** y
**carga de archivos** por botón o arrastrar-y-soltar. Pensada para trabajar con
Claude Code y Codex CLI durante horas sin cansar la vista.

No es un reemplazo de Windows Terminal: es una ventana única y directa al shell,
sin paneles, perfiles ni configuración pesada.

---

## Instalación

```bash
cd C:\Users\Sebastian\source\repos\AdminTerm
npm install
```

`npm install` descarga Electron, copia los assets de xterm a `src/renderer/vendor/`
y genera el icono.

## Uso

| Cómo | Comando |
| --- | --- |
| Arranque normal (pide UAC) | `npm start` o doble clic en `Iniciar-AdminTerm.bat` |
| Sin pedir administrador | `npm run start:normal` |
| Comprobar que todo funciona | `npm run selftest` (28 comprobaciones, sin abrir ventana) |
| Acceso directo en Escritorio + Inicio | `powershell -ExecutionPolicy Bypass -File Crear-acceso-directo.ps1` |
| Generar un `.exe` distribuible | `npm run build` (portable) o `npm run dist` (instalador) |

`npm run build` deja un ejecutable autocontenido en
`dist\AdminTerm-portable-1.1.0.exe` (~86 MB) que funciona en cualquier Windows
x64 sin Node ni instalación.

Al abrir, AdminTerm se relanza a sí misma pidiendo UAC. Si cancelas el aviso, la
app sigue abriéndose en modo normal y muestra un botón **Reiniciar como admin**
en la barra inferior. Puedes desactivar la elevación automática en Ajustes.

---

## Lo que trae

**Terminal real.** ConPTY nativo vía `@lydell/node-pty` (binarios N-API precompilados:
no hace falta Visual Studio ni recompilar para Electron) y `xterm.js` con renderizado
WebGL. Detecta automáticamente Windows PowerShell, PowerShell 7, cmd, Git Bash y WSL.

**Legibilidad.** Tipografía, tamaño, interlineado, espaciado entre letras y grosor
configurables; detecta qué fuentes monoespaciadas tienes realmente instaladas
(Cascadia Mono, JetBrains Mono, Fira Code…). Tres temas de alto contraste y una
opción para forzar contraste mínimo AA sobre los colores ANSI que emitan las CLI.

**Micrófono.** El botón 🎤 graba localmente y envía el audio al endpoint de
transcripción que configures en Ajustes; el texto se escribe en el panel activo
(opcionalmente con Enter automático). Funciona con cualquier endpoint compatible
con la API de OpenAI:

| Proveedor | Endpoint | Modelo |
| --- | --- | --- |
| **Servidor local** | `http://127.0.0.1:8756/v1/audio/transcriptions` | `small` o `base` |
| OpenAI | `https://api.openai.com/v1/audio/transcriptions` | `whisper-1` o `gpt-4o-mini-transcribe` |
| Groq | `https://api.groq.com/openai/v1/audio/transcriptions` | `whisper-large-v3-turbo` |

### Dictado local, sin conexión y sin API key

Con el proveedor **Servidor local**, AdminTerm levanta Whisper en tu propio equipo
la primera vez que dictas y lo cierra al salir. No hace falta API key, no sale
audio de la máquina y no cuesta nada.

Requiere Python con `faster-whisper`, `fastapi`, `uvicorn` y `python-multipart`:

```bash
pip install faster-whisper fastapi uvicorn python-multipart
```

El servidor vive en [`tools/whisper-server/`](tools/whisper-server/) y también se
puede lanzar a mano con `start.bat` para depurar.

Elegir modelo en Ajustes → Micrófono → Modelo. Medido sobre un i7-8550U (portátil
de 2017, sin GPU) con 4,8 s de audio y el servidor ya caliente:

| Modelo | Latencia | Tamaño |
| --- | --- | --- |
| `base` | **1,7 s** | 141 MB |
| `small` | 4,9 s | 464 MB |

`base` es unas 3 veces más rápido; `small` acierta más con nombres propios y
jerga técnica. En una máquina moderna ambos van bastante más rápido.

**Archivos.** Botón 📁 (o `Ctrl+Shift+O`) para elegir varios archivos e insertar sus
rutas absolutas entrecomilladas en el prompt — que es justo lo que Claude Code y
Codex necesitan para leerlos. También puedes arrastrar y soltar archivos sobre la
ventana.

**Paneles divididos.** Divide una pestaña a la derecha o abajo (hasta 4 paneles),
arrastra el divisor para repartir el espacio y muévete entre paneles con
`Alt`+flechas. Cada panel es una shell independiente: Claude en uno, el repo en
el otro. Los paneles anidados (dividir un panel ya dividido en el otro eje) no
están soportados; para eso, abre otra pestaña.

**Avisa cuando un agente te espera.** Si Claude Code, Codex u otra CLI se queda
pidiendo confirmación en una pestaña que no estás mirando, esa pestaña se tiñe y
parpadea hasta que la abres. Se reconoce por lo que hay en pantalla (`1. Yes`,
`[y/N]`, `Do you want to...?`, `¿Deseas continuar?` y formas parecidas), así que
funciona con cualquier CLI sin integrarse con ninguna. Se desactiva en Ajustes →
Terminal.

**Ayuda a mano.** `F1` abre una hoja con todos los atajos y, según la shell del
panel activo, los comandos que listan lo que puedes ejecutar (`Get-Command`,
`help`, `compgen -c`...). Al pulsar uno se escribe en el terminal sin ejecutarlo.

**Reabre donde lo dejaste.** Al cerrar guarda qué pestañas y paneles tenías, con
sus proporciones, y los reconstruye al abrir. También recuerda el tamaño y la
posición de la ventana.

**Atajo global.** Opcional, para traer AdminTerm al frente desde cualquier sitio
(por defecto `Control+Alt+T`, configurable).

**Pestañas**, búsqueda en el scrollback, zoom con `Ctrl`+rueda y ajustes que se
aplican en vivo a todos los paneles abiertos.

---

## Atajos

| Atajo | Acción |
| --- | --- |
| `F1` | Ayuda: atajos y comandos de la shell (también `Ctrl+Shift+H`) |
| `Ctrl+Shift+T` | Nueva pestaña |
| `Alt+Shift++` / `Alt+Shift+-` | Dividir a la derecha / abajo |
| `Alt`+flechas | Moverse entre paneles |
| `Ctrl+Shift+W` | Cerrar el panel activo (o la pestaña si es el último) |
| `Ctrl+Tab` / `Ctrl+1..9` | Cambiar de pestaña |
| `Ctrl+Shift+C` | Copiar (`Ctrl+C` queda libre para las CLI) |
| `Ctrl+V` / `Ctrl+Shift+V` | Pegar |
| `Ctrl+Shift+F` | Buscar |
| `Ctrl+Shift+M` | Micrófono |
| `Ctrl+Shift+O` | Insertar rutas de archivos |
| `Ctrl` `+` / `-` / `0` | Tamaño de fuente |
| `Ctrl+,` | Ajustes |
| Clic derecho | Copia la selección, o pega si no hay selección |

`Ctrl+V` lo atiende AdminTerm y no llega a lo que corras dentro. Es a propósito:
si se dejara pasar, PSReadLine (que también tiene `Ctrl+V` = pegar) pegaría por
su cuenta y el texto entraría dos veces.

---

## Dos limitaciones de Windows que conviene conocer

Ambas vienen de UIPI, el mecanismo que impide que un proceso de integridad media
manipule una ventana elevada. No son fallos de AdminTerm:

1. **Arrastrar y soltar desde el Explorador no funciona con la ventana elevada.**
   El Explorador corre en integridad media y Windows bloquea el drop. Usa el botón
   📁, o abre AdminTerm con `npm run start:normal` cuando quieras arrastrar.
2. **El dictado nativo de Windows (`Win+H`) no escribe en la ventana elevada**, por
   la misma razón. Por eso el micrófono de AdminTerm graba y transcribe por su
   cuenta en vez de depender de `Win+H`: así sí funciona con permisos de admin.

## Diagnóstico

| Flag | Para qué sirve |
| --- | --- |
| `--selftest` | Arranca sin ventana, ejerce la app de punta a punta (PTY, pestañas, ajustes en vivo, temas, rutas, portapapeles, cierre) e imprime un informe. Sale con código 0 si todo pasa. |
| `--shot ruta.png` | Guarda capturas de la interfaz (tema oscuro y claro) sin mostrar la ventana. Se combina con `--selftest`. |
| `--print-elevate-command` | Imprime el comando PowerShell exacto que se usa para pedir UAC y sale. Útil si la elevación falla. |
| `--no-elevate` | Arranca sin pedir permisos de administrador. |

```bash
node_modules\electron\dist\electron.exe . --no-elevate --selftest
```

## Mejoras pendientes

Ideas evaluadas y no implementadas están en
[`docs/MEJORAS-PENDIENTES.md`](docs/MEJORAS-PENDIENTES.md), con las mediciones
y decisiones ya tomadas: autocompletado al escribir, transcripción local sin
nube y paneles anidados.

## Seguridad

La app corre como administrador: todo lo que escribas en ella se ejecuta con
permisos completos sobre el sistema. La API key de transcripción se guarda en
texto plano en `%APPDATA%\AdminTerm\settings.json`, igual que hacen la mayoría de
clientes de escritorio; usa una key con el menor alcance posible.
