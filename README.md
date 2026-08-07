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
| Comprobar que todo funciona | `npm run selftest` |
| Acceso directo en Escritorio + Inicio | `powershell -ExecutionPolicy Bypass -File Crear-acceso-directo.ps1` |
| Generar un `.exe` distribuible | `npm run build` (portable) o `npm run dist` (instalador) |

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
transcripción que configures en Ajustes; el texto se escribe en el terminal
(opcionalmente con Enter automático). Funciona con cualquier endpoint compatible
con la API de OpenAI:

| Proveedor | Endpoint | Modelo |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1/audio/transcriptions` | `whisper-1` o `gpt-4o-mini-transcribe` |
| Groq | `https://api.groq.com/openai/v1/audio/transcriptions` | `whisper-large-v3-turbo` |
| Local | `http://127.0.0.1:8000/v1/audio/transcriptions` | el de tu servidor Whisper |

**Archivos.** Botón 📁 (o `Ctrl+Shift+O`) para elegir varios archivos e insertar sus
rutas absolutas entrecomilladas en el prompt — que es justo lo que Claude Code y
Codex necesitan para leerlos. También puedes arrastrar y soltar archivos sobre la
ventana.

**Pestañas**, búsqueda en el scrollback, zoom con `Ctrl`+rueda y ajustes que se
aplican en vivo a todas las pestañas.

---

## Atajos

| Atajo | Acción |
| --- | --- |
| `Ctrl+Shift+T` / `Ctrl+Shift+W` | Nueva pestaña / cerrar pestaña |
| `Ctrl+Tab` / `Ctrl+1..9` | Cambiar de pestaña |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copiar / pegar (`Ctrl+C` queda libre para las CLI) |
| `Ctrl+Shift+F` | Buscar |
| `Ctrl+Shift+M` | Micrófono |
| `Ctrl+Shift+O` | Insertar rutas de archivos |
| `Ctrl` `+` / `-` / `0` | Tamaño de fuente |
| `Ctrl+,` | Ajustes |
| Clic derecho | Copia la selección, o pega si no hay selección |

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

## Seguridad

La app corre como administrador: todo lo que escribas en ella se ejecuta con
permisos completos sobre el sistema. La API key de transcripción se guarda en
texto plano en `%APPDATA%\AdminTerm\settings.json`, igual que hacen la mayoría de
clientes de escritorio; usa una key con el menor alcance posible.
