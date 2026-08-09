'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, globalShortcut, screen,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const pty = require('@lydell/node-pty');

const IS_WIN = process.platform === 'win32';
const SYSROOT = process.env.SystemRoot || 'C:\\Windows';
const SYS32 = path.join(SYSROOT, 'System32');
const POWERSHELL = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// Evita que Windows "apague" el render al detectar la ventana tapada: el
// terminal debe seguir pintando mientras Claude/Codex escupen salida.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// ---------------------------------------------------------------------------
// Ajustes persistentes
// ---------------------------------------------------------------------------

const DEFAULTS = {
  autoElevate: true,
  shell: 'powershell',
  startCwd: '',
  fontFamily: 'Cascadia Mono',
  fontSize: 15,
  lineHeight: 1.35,
  letterSpacing: 0,
  fontWeight: 400,
  cursorStyle: 'bar',
  cursorBlink: true,
  theme: 'oscuro',
  scrollback: 20000,
  highContrast: true,
  confirmClose: true,
  restoreSession: true,
  rememberWindow: true,
  globalHotkeyEnabled: false,
  globalHotkey: 'Control+Alt+T',
  session: null,
  bounds: null,
  stt: {
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'whisper-1',
    apiKey: '',
    language: 'es',
    deviceId: '',
    autoSend: false,
    // Con un endpoint local, AdminTerm levanta el servidor Whisper por su
    // cuenta la primera vez que se dicta. `pythonPath` vacio = autodetectar.
    autoStartLocal: true,
    pythonPath: '',
  },
};

let settingsCache = null;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function mergeSettings(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = { ...base[k], ...v };
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function getSettings() {
  if (settingsCache) return settingsCache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    stored = {};
  }
  settingsCache = mergeSettings(DEFAULTS, stored);
  return settingsCache;
}

function saveSettings(patch) {
  settingsCache = mergeSettings(getSettings(), patch);
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settingsCache, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings] no se pudo guardar:', err.message);
  }
  return settingsCache;
}

// ---------------------------------------------------------------------------
// Elevacion (UAC)
// ---------------------------------------------------------------------------

function isElevated() {
  if (!IS_WIN) return typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  try {
    const out = execFileSync(path.join(SYS32, 'whoami.exe'), ['/groups'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    // S-1-16-12288 = High Mandatory Level (proceso elevado)
    return out.includes('S-1-16-12288');
  } catch {
    return false;
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Construye el comando PowerShell que relanza la app con UAC. Se puede
 * inspeccionar con `--print-elevate-command`, porque el entrecomillado de
 * rutas con espacios es la parte facil de romper y dificil de probar.
 */
function buildElevateCommand() {
  const exe = process.execPath;
  const rest = process.defaultApp
    ? [path.resolve(process.argv[1] || '.'), ...process.argv.slice(2)]
    : process.argv.slice(1);
  const args = rest.filter((a) => !['--no-elevate', '--elevated', '--print-elevate-command'].includes(a));

  // Start-Process une -ArgumentList con espacios sin entrecomillar, asi que
  // cada argumento lleva sus propias comillas dobles dentro del literal.
  const argList = args.map((a) => psQuote(`"${String(a).replace(/"/g, '\\"')}"`)).join(',');
  const parts = [`Start-Process -FilePath ${psQuote(exe)}`, '-Verb RunAs'];
  if (argList) parts.push(`-ArgumentList ${argList}`);
  parts.push(`-WorkingDirectory ${psQuote(process.cwd())}`);
  return parts.join(' ');
}

/** Relanza la app pidiendo UAC. Devuelve true si el proceso elevado arranco. */
function relaunchElevated() {
  try {
    execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', buildElevateCommand()], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 60000,
    });
    return true;
  } catch {
    return false; // UAC cancelado o bloqueado por politica
  }
}

if (process.argv.includes('--print-elevate-command')) {
  process.stdout.write(buildElevateCommand() + '\n');
  process.exit(0);
}

const elevated = isElevated();
let uacDenied = false;

if (IS_WIN && !elevated && !process.argv.includes('--no-elevate') && getSettings().autoElevate) {
  if (relaunchElevated()) {
    // process.exit y no app.exit: el apagado de Electron se bloquea en esta
    // app (ya paso con el cierre de ventana), y aqui dejaba vivo el proceso
    // lanzador con sus hijos en CADA arranque desde el acceso directo. No hay
    // nada que vaciar: esto ocurre antes de whenReady.
    process.exit(0);
  } else {
    uacDenied = true;
  }
}

// ---------------------------------------------------------------------------
// Shells disponibles
// ---------------------------------------------------------------------------

function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function detectShells() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';

  const found = [];
  const add = (key, label, file, args = []) => {
    if (file) found.push({ key, label, file, args });
  };

  add('powershell', 'Windows PowerShell', firstExisting([POWERSHELL]), ['-NoLogo']);
  add(
    'pwsh',
    'PowerShell 7',
    firstExisting([
      path.join(pf, 'PowerShell', '7', 'pwsh.exe'),
      path.join(pf, 'PowerShell', '6', 'pwsh.exe'),
      path.join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    ]),
    ['-NoLogo']
  );
  add('cmd', 'Simbolo del sistema', firstExisting([process.env.ComSpec, path.join(SYS32, 'cmd.exe')]));
  add(
    'gitbash',
    'Git Bash',
    firstExisting([
      path.join(pf, 'Git', 'bin', 'bash.exe'),
      path.join(pf86, 'Git', 'bin', 'bash.exe'),
      path.join(local, 'Programs', 'Git', 'bin', 'bash.exe'),
    ]),
    ['--login', '-i']
  );
  add('wsl', 'WSL', firstExisting([path.join(SYS32, 'wsl.exe')]));

  return found;
}

const SHELLS = detectShells();

function resolveShell(key) {
  return SHELLS.find((s) => s.key === key) || SHELLS[0];
}

function defaultCwd() {
  const configured = getSettings().startCwd;
  if (configured && fs.existsSync(configured)) return configured;
  return os.homedir();
}

// ---------------------------------------------------------------------------
// Sesiones PTY
// ---------------------------------------------------------------------------

let nextId = 1;
const sessions = new Map();

function ptyEnv() {
  const env = { ...process.env };
  // Variables que Electron inyecta y confunden a las CLI hijas.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.NODE_OPTIONS;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'AdminTerm';
  env.TERM_PROGRAM_VERSION = app.getVersion();
  return env;
}

function createSession(win, { shellKey, cols, rows, cwd }) {
  const sh = resolveShell(shellKey);
  if (!sh) throw new Error('No se encontro ninguna shell disponible en el sistema.');

  const workdir = cwd && fs.existsSync(cwd) ? cwd : defaultCwd();
  const proc = pty.spawn(sh.file, sh.args, {
    name: 'xterm-256color',
    cols: Math.max(2, cols | 0 || 80),
    rows: Math.max(1, rows | 0 || 24),
    cwd: workdir,
    env: ptyEnv(),
  });

  const id = nextId++;
  const session = { id, proc, shellKey: sh.key, buffer: '', flushTimer: null, alive: true };
  sessions.set(id, session);

  const flush = () => {
    session.flushTimer = null;
    if (!session.buffer) return;
    const data = session.buffer;
    session.buffer = '';
    if (!win.isDestroyed()) win.webContents.send('pty:data', { id, data });
  };

  // Agrupamos las escrituras del PTY en ventanas de ~6ms: menos IPC, misma fluidez.
  proc.onData((data) => {
    session.buffer += data;
    if (session.buffer.length > 65536) {
      if (session.flushTimer) clearTimeout(session.flushTimer);
      flush();
      return;
    }
    if (!session.flushTimer) session.flushTimer = setTimeout(flush, 6);
  });

  proc.onExit(({ exitCode, signal }) => {
    session.alive = false;
    if (session.flushTimer) clearTimeout(session.flushTimer);
    flush();
    sessions.delete(id);
    if (!win.isDestroyed()) win.webContents.send('pty:exit', { id, exitCode, signal });
  });

  return { id, shellKey: sh.key, label: sh.label, cwd: workdir, pid: proc.pid };
}

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  try {
    s.proc.kill();
  } catch {
    /* ya murio */
  }
  sessions.delete(id);
}

function killAllSessions() {
  for (const id of [...sessions.keys()]) killSession(id);
}

// ---------------------------------------------------------------------------
// Dictado de Windows (Win+H) como alternativa sin API key
// ---------------------------------------------------------------------------

function sendWinH() {
  const script = [
    'Add-Type -Namespace AT -Name K -MemberDefinition \'[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.IntPtr dwExtraInfo);\'',
    '[AT.K]::keybd_event(0x5B,0,0,[System.IntPtr]::Zero)',
    '[AT.K]::keybd_event(0x48,0,0,[System.IntPtr]::Zero)',
    'Start-Sleep -Milliseconds 40',
    '[AT.K]::keybd_event(0x48,0,2,[System.IntPtr]::Zero)',
    '[AT.K]::keybd_event(0x5B,0,2,[System.IntPtr]::Zero)',
  ].join('; ');
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}

// ---------------------------------------------------------------------------
// Servidor Whisper local (dictado sin conexion ni API key)
// ---------------------------------------------------------------------------

// Tamanos que el servidor local sabe cargar por nombre; cualquier otro valor
// (p.ej. "whisper-1") se trata como "usa el de por defecto".
const WHISPER_SIZES = new Set([
  'tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en',
  'medium', 'medium.en', 'large-v1', 'large-v2', 'large-v3',
  'large-v3-turbo', 'turbo', 'distil-small.en', 'distil-large-v3',
]);

/**
 * ¿El endpoint apunta a esta maquina? Se parsea la URL en vez de usar una
 * expresion regular sobre la cadena: "https://127.0.0.1.ejemplo.com/" empieza
 * por 127.0.0.1 y NO es local, y tratarla como tal saltaria la exigencia de
 * API key contra un servidor ajeno.
 * El renderer tiene la misma comprobacion en `sttNeedsKey()`.
 */
function endpointIsLocal(endpoint) {
  try {
    const { hostname } = new URL(String(endpoint));
    // El anclaje final es lo que importa: sin el, "127.0.0.1.ejemplo.com"
    // (un host de terceros) pasaria por local.
    return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' ||
      /^127(\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

function findPython() {
  const configured = getSettings().stt.pythonPath;
  if (configured && fs.existsSync(configured)) return configured;

  const localApp = process.env.LOCALAPPDATA || '';
  const versions = ['313', '312', '311', '310', '39'];
  const candidates = [
    ...versions.map((v) => `C:\\Python${v}\\python.exe`),
    ...versions.map((v) => path.join(localApp, 'Programs', 'Python', `Python${v}`, 'python.exe')),
  ];
  const found = firstExisting(candidates);
  if (found) return found;

  try {
    const out = execFileSync(path.join(SYS32, 'where.exe'), ['python'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    // El "python.exe" de WindowsApps es el stub que abre la Microsoft Store.
    return out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.includes('WindowsApps')) || null;
  } catch {
    return null;
  }
}

/** El .py no se puede ejecutar dentro del asar: se sirve desde app.asar.unpacked. */
function whisperScriptPath() {
  const base = app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked');
  return path.join(base, 'tools', 'whisper-server', 'server.py');
}

let localServer = null; // { proc, origin } solo si lo arrancamos nosotros
let localServerStarting = null; // promesa compartida para peticiones simultaneas

/**
 * null = nadie escucha · { foreign: true } = el puerto lo ocupa otro servicio
 * · objeto = es nuestro servidor.
 */
async function probeWhisperHealth(origin, timeoutMs = 1500) {
  try {
    const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { foreign: true };
    const body = await res.json();
    return body && body.service === 'adminterm-whisper' ? body : { foreign: true };
  } catch {
    return null;
  }
}

async function startLocalServer(url, notify) {
  const python = findPython();
  if (!python) {
    return { ok: false, error: 'No se encontro Python. Indica su ruta en Ajustes o instala Python 3.10+.' };
  }
  const script = whisperScriptPath();
  if (!fs.existsSync(script)) {
    return { ok: false, error: `No se encontro el servidor en ${script}` };
  }

  const stt = getSettings().stt;
  const size = WHISPER_SIZES.has(stt.model) ? stt.model : 'small';
  const origin = `${url.protocol}//${url.host}`;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');

  notify(`Arrancando Whisper local (${size})…`);
  const proc = spawn(
    python,
    [script, '--host', url.hostname, '--port', String(port), '--model', size],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stderr = '';
  let exited = null;
  proc.stdout.on('data', (d) => {
    for (const raw of String(d).split('\n')) {
      // El servidor ya escribe su propio prefijo: no se duplica.
      const line = raw.trim().replace(/^\[whisper\]\s*/, '');
      if (!line) continue;
      console.log('[whisper]', line);
      notify(line);
    }
  });
  proc.stderr.on('data', (d) => {
    stderr += String(d);
  });
  proc.on('exit', (code) => {
    exited = code;
  });

  localServer = { proc, origin };

  // Cargar el modelo lleva unos segundos la primera vez; la primera descarga
  // de un modelo nuevo, bastante mas.
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (exited !== null) {
      localServer = null;
      const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      return { ok: false, error: `El servidor local termino con codigo ${exited}. ${detail}` };
    }
    const health = await probeWhisperHealth(origin, 1200);
    if (health && !health.foreign) {
      notify('Whisper local listo.');
      return { ok: true, started: true };
    }
    await new Promise((r) => setTimeout(r, 700));
  }

  stopLocalServer();
  return { ok: false, error: 'El servidor local no respondio en 3 minutos.' };
}

async function ensureLocalServer(endpoint, notify = () => {}) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, error: `Endpoint no valido: ${endpoint}` };
  }
  const origin = `${url.protocol}//${url.host}`;

  const health = await probeWhisperHealth(origin);
  if (health && !health.foreign) return { ok: true, already: true };
  if (health && health.foreign) {
    return { ok: false, error: `El puerto ${url.port} lo ocupa otro servicio distinto a Whisper.` };
  }

  if (SELFTEST) return { ok: false, error: 'Arranque del servidor local desactivado en modo prueba.' };
  if (!getSettings().stt.autoStartLocal) {
    return { ok: false, error: 'El servidor local no responde y el arranque automatico esta desactivado.' };
  }

  // Si dos dictados coinciden, ambos esperan al mismo arranque.
  if (!localServerStarting) {
    localServerStarting = startLocalServer(url, notify).finally(() => {
      localServerStarting = null;
    });
  }
  return localServerStarting;
}

function stopLocalServer() {
  if (!localServer || !localServer.proc) return;
  const { pid } = localServer.proc;
  localServer = null;
  try {
    // taskkill /T porque uvicorn puede dejar descendencia; mismo cuidado que
    // con los PTY para no dejar procesos huerfanos.
    execFileSync(path.join(SYS32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5000,
    });
  } catch {
    /* ya habia terminado */
  }
}

// ---------------------------------------------------------------------------
// Ventana
// ---------------------------------------------------------------------------

let mainWindow = null;
const SELFTEST = process.argv.includes('--selftest');

/** Muestra, oculta o trae al frente la ventana (atajo global). */
function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function applyGlobalHotkey() {
  globalShortcut.unregisterAll();
  const s = getSettings();
  if (!s.globalHotkeyEnabled || !s.globalHotkey) return { ok: true, registered: false };
  try {
    return { ok: true, registered: globalShortcut.register(s.globalHotkey, toggleWindow) };
  } catch (err) {
    // Electron lanza si la combinacion no es valida (p.ej. "Ctrl+Foo").
    return { ok: false, registered: false, error: err.message };
  }
}

/** Solo reutiliza la geometria guardada si sigue cayendo en algun monitor. */
function usableBounds() {
  const s = getSettings();
  if (!s.rememberWindow || !s.bounds) return null;
  const b = s.bounds;
  if (!Number.isFinite(b.width) || !Number.isFinite(b.height) || b.width < 400 || b.height < 300) return null;
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x + b.width > a.x && b.x < a.x + a.width && b.y + b.height > a.y && b.y < a.y + a.height;
  });
  return visible ? b : null;
}

function createWindow() {
  const saved = usableBounds();
  mainWindow = new BrowserWindow({
    width: saved ? saved.width : 1180,
    height: saved ? saved.height : 760,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    minWidth: 620,
    minHeight: 380,
    show: false,
    title: elevated ? 'AdminTerm (Administrador)' : 'AdminTerm',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: true,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (!SELFTEST) mainWindow.show();
  });

  if (SELFTEST) runSelfTest(mainWindow);

  // El microfono es la unica capacidad web que necesitamos.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'clipboard-sanitized-write');
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // En --selftest la ventana se coloca fuera de pantalla para capturarla, y
  // esa geometria no debe quedar guardada.
  mainWindow.on('close', () => {
    if (SELFTEST || !getSettings().rememberWindow || mainWindow.isDestroyed()) return;
    try {
      saveSettings({ bounds: mainWindow.getNormalBounds() });
    } catch (err) {
      console.error('[bounds] no se pudo guardar:', err.message);
    }
  });

  mainWindow.on('closed', () => {
    killAllSessions();
    mainWindow = null;
  });

  applyGlobalHotkey();
}

// Se evalua dentro del renderer: ejerce arranque, PTY, pestanas, ajustes en
// vivo, temas e insercion de rutas, y devuelve una lista de comprobaciones.
const SELFTEST_SCRIPT = String.raw`
(async () => {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: String(detail) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bufferOf = (tab) => Array.from(
    { length: tab.term.buffer.active.length },
    (_, i) => tab.term.buffer.active.getLine(i).translateToString(true)
  ).join('\n');

  const deadline = Date.now() + 15000;
  while (!window.__adminTermReady && Date.now() < deadline) await sleep(120);

  const app = window.__adminTerm;
  add('arranque', !!window.__adminTermReady && !!app, window.__adminTermReady ? 'renderer listo' : 'no arranco');
  if (!app) return { checks };

  const snapshot = { theme: app.settings.theme, fontSize: app.settings.fontSize };

  add('xterm + addons',
    typeof window.Terminal === 'function' &&
      ['FitAddon','SearchAddon','Unicode11Addon','WebLinksAddon','WebglAddon'].every((n) => window[n] && window[n][n]),
    'xterm 6 + 5 addons');

  const t0 = app.tabs[0];
  add('primera pestana', !!t0, t0 ? t0.term.cols + 'x' + t0.term.rows + ' · ' + t0.term.options.fontFamily : 'sin pestana');
  if (!t0) return { checks };

  // ConPTY manda la ruta del .exe como titulo: la pestana no debe mostrarla.
  await sleep(600);
  add('titulo de pestana', !/\.exe/i.test(t0.title), 'muestra "' + t0.title + '"');

  // El titulo de la ventana debe delatar si hay privilegios de administrador.
  add('titulo de ventana', /AdminTerm/.test(document.title), document.title);

  // --- el PTY responde de verdad ---
  window.adminterm.ptyInput(t0.id, 'echo SELFTEST_MARKER_A\r');
  const echoDeadline = Date.now() + 12000;
  let echoed = false;
  while (Date.now() < echoDeadline && !echoed) {
    await sleep(200);
    echoed = (bufferOf(t0).match(/SELFTEST_MARKER_A/g) || []).length >= 2; // eco + salida
  }
  add('shell responde', echoed, echoed ? 'echo ejecutado y devuelto' : 'sin respuesta del shell');

  // --- fuentes monoespaciadas detectadas en el sistema ---
  add('fuentes detectadas', app.fonts.length > 0, app.fonts.join(', ') || 'ninguna');

  // --- paneles divididos ---
  const split = await app.splitActive('row');
  const splitOk = !!split && app.activeTab.panes.length === 2 && app.activeTab.direction === 'row';
  add('dividir panel', splitOk,
    splitOk ? '2 paneles en fila' : 'no se dividio: ' + (app.lastPaneError || 'motivo desconocido'));

  if (splitOk) {
    const second = app.activePane;
    app.movePaneFocus('arrowleft');
    const moved = app.activePane !== second;
    app.movePaneFocus('arrowright');
    add('foco entre paneles', moved && app.activePane === second, 'Alt+flechas cambia de panel');

    const dividers = app.activeTab.view.querySelectorAll('.pane-divider').length;
    add('divisor visible', dividers === 1, dividers + ' divisor(es) entre 2 paneles');

    // Los dos paneles deben tener PTY propio y ancho parecido.
    const ids = new Set(app.activeTab.panes.map((p) => p.id));
    const widths = app.activeTab.panes.map((p) => p.el.getBoundingClientRect().width);
    const balanced = Math.abs(widths[0] - widths[1]) < Math.max(widths[0], widths[1]) * 0.2;
    add('paneles independientes', ids.size === 2 && balanced,
      'PTYs distintos, anchos ' + widths.map((w) => Math.round(w)).join('/'));

    // Los paneles deben llenar el alto disponible, y el terminal el panel.
    const viewH = app.activeTab.view.getBoundingClientRect().height;
    const paneH = app.activeTab.panes.map((p) => p.el.getBoundingClientRect().height);
    // Un choque de clases CSS ya rompio esto una vez: si vuelve a fallar,
    // el detalle trae los estilos calculados para no tener que adivinar.
    const fullHeight = paneH.every((h) => h > viewH * 0.95);
    let detail = 'vista=' + Math.round(viewH) + ' paneles=' + paneH.map((h) => Math.round(h)).join('/');
    if (!fullHeight) {
      const cs = getComputedStyle(app.activeTab.view);
      const ps = getComputedStyle(app.activeTab.panes[0].el);
      detail += ' [view: ' + cs.display + '/' + cs.flexDirection + '/align-items:' + cs.alignItems +
        ' | pane: align-self:' + ps.alignSelf + ' height:' + ps.height + ' flex:' + ps.flex + ']';
    }
    add('paneles a toda altura', fullHeight, detail);

    const screenH = app.activeTab.panes.map((p) => {
      const s = p.el.querySelector('.xterm-screen');
      return s ? s.getBoundingClientRect().height : 0;
    });
    add('terminal llena el panel', screenH.every((h, i) => h > paneH[i] * 0.9),
      'terminal=' + screenH.map((h) => Math.round(h)).join('/') + ' filas=' +
      app.activeTab.panes.map((p) => p.term.rows).join('/'));

    app.destroyPane(app.activePane);
    await sleep(250);
    add('cerrar panel', app.activeTab.panes.length === 1, 'queda 1 panel');
  }

  // --- instantanea de sesion (lo que se reabrira al arrancar) ---
  const snap = app.layoutSnapshot();
  add('instantanea de sesion',
    Array.isArray(snap.tabs) && snap.tabs.length === app.tabs.length && !!snap.tabs[0].panes[0].shellKey,
    snap.tabs.length + ' pestana(s), shell=' + snap.tabs[0].panes[0].shellKey);

  // --- reapertura: reconstruir una disposicion guardada ---
  const before = app.tabs.length;
  await app.restoreSession({
    activeIndex: 0,
    tabs: [{ direction: 'column', panes: [{ shellKey: 'powershell', flex: 2 }, { shellKey: 'powershell', flex: 1 }] }],
  });
  const rebuilt = app.tabs[app.tabs.length - 1];
  const restoreOk =
    app.tabs.length === before + 1 && rebuilt.panes.length === 2 &&
    rebuilt.direction === 'column' && rebuilt.panes[0].flex === 2;
  add('reabrir sesion', restoreOk,
    restoreOk ? '2 paneles en columna con proporcion 2:1' : 'no se reconstruyo la disposicion');
  app.destroyTab(rebuilt);
  await sleep(200);

  // --- audio de prueba del microfono: debe ser un WAV valido ---
  const wav = app.probeAudioWav();
  const riff = String.fromCharCode(...wav.slice(0, 4)) + String.fromCharCode(...wav.slice(8, 12));
  add('audio de prueba', riff === 'RIFFWAVE' && wav.length === 44 + 16000 * 2,
    'WAV mono 16 kHz, ' + wav.length + ' bytes');

  // --- segunda pestana ---
  const t1 = await app.newTab();
  add('nueva pestana', !!t1 && app.tabs.length === 2, 'total=' + app.tabs.length);

  // --- ajustes en vivo sobre TODAS las pestanas ---
  await app.setFontSize(19);
  await sleep(150);
  const sizes = app.tabs.map((t) => t.term.options.fontSize);
  add('tamano de fuente', sizes.every((s) => s === 19), 'aplicado a ' + sizes.length + ' pestanas: ' + sizes.join('/'));

  await app.patchSettings({ theme: 'claro' });
  await sleep(150);
  const lightOk = app.tabs.every((t) => t.term.options.theme.background === '#ffffff') &&
    document.documentElement.getAttribute('data-ui') === 'claro';
  await app.patchSettings({ theme: 'oscuro' });
  await sleep(150);
  const darkOk = app.tabs.every((t) => t.term.options.theme.background === '#0b0e14');
  add('cambio de tema', lightOk && darkOk, 'claro y oscuro aplicados en vivo');

  // --- insercion de rutas de archivos (con espacios -> entrecomilladas) ---
  const probe = 'C:\\carpeta de prueba\\informe final.txt';
  app.insertPaths([probe]);
  // Margen amplio: con la maquina cargada, el eco de la shell tarda mas y
  // esta comprobacion daba falsos negativos.
  const pathDeadline = Date.now() + 15000;
  let pathOk = false;
  const activeTab = app.activeTab;
  while (Date.now() < pathDeadline && !pathOk) {
    await sleep(200);
    pathOk = bufferOf(activeTab).includes('"' + probe + '"');
  }
  add('insertar archivos', pathOk, pathOk ? 'ruta con espacios entrecomillada' : 'no aparecio en el prompt');
  window.adminterm.ptyInput(activeTab.id, '\u0003'); // Ctrl+C: limpia la linea

  // --- modal de ajustes (se comprueba el estilo calculado, no solo [hidden]) ---
  const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
  app.openSettings();
  const modalOpen = shown('settings-modal') && document.getElementById('set-fontSize').value === '19';
  app.closeSettings();
  const modalClosed = !shown('settings-modal');
  add('panel de ajustes', modalOpen && modalClosed, 'abre, refleja valores y cierra de verdad');

  // El aviso de "ruta insertada" debe desaparecer solo...
  const toastDeadline = Date.now() + 8000;
  while (shown('toast') && Date.now() < toastDeadline) await sleep(250);
  add('aviso se auto-oculta', !shown('toast'), 'el toast desaparece solo');

  // ...y en reposo no debe quedar ninguna capa superpuesta encima del terminal.
  const overlays = ['drop-overlay', 'mic-overlay', 'search-bar', 'toast', 'settings-modal'].filter(shown);
  add('capas en reposo', overlays.length === 0, overlays.length ? 'visibles por error: ' + overlays.join(', ') : 'todas ocultas');

  // --- portapapeles (copiar/pegar), preservando lo que tuviera el usuario ---
  const previousClip = await window.adminterm.readClipboard();
  await window.adminterm.writeClipboard('ADMINTERM_CLIP_PROBE');
  const clipOk = (await window.adminterm.readClipboard()) === 'ADMINTERM_CLIP_PROBE';
  await window.adminterm.writeClipboard(previousClip);
  add('portapapeles', clipOk, 'lectura/escritura via preload');

  // --- contrato IPC de transcripcion (sin key no debe llamar a la red) ---
  if (app.settings.stt.apiKey) {
    add('IPC transcripcion', true, 'omitido: hay una API key configurada');
  } else {
    const stt = await window.adminterm.transcribe(new Uint8Array([1, 2, 3]), 'audio/webm', 'probe.webm');
    add('IPC transcripcion', stt && stt.ok === false && stt.code === 'NO_KEY', 'error NO_KEY como se espera');

    // Regresion real: con endpoint local NO debe exigirse API key. Y el modo
    // prueba no debe arrancar el servidor, asi que se espera LOCAL_SERVER.
    const original = app.settings.stt.endpoint;
    await app.patchSettings({ stt: { endpoint: 'http://127.0.0.1:8756/v1/audio/transcriptions' } });
    const localRes = await window.adminterm.transcribe(new Uint8Array([1, 2, 3]), 'audio/webm', 'probe.webm');
    await app.patchSettings({ stt: { endpoint: original } });
    add('local sin API key', !!localRes && localRes.code !== 'NO_KEY',
      'devuelve ' + ((localRes && (localRes.code || (localRes.ok ? 'ok' : 'error'))) || 'nada') + ', no NO_KEY');
  }

  // --- cerrar pestana ---
  app.destroyTab(app.tabs[1]);
  await sleep(200);
  add('cerrar pestana', app.tabs.length === 1, 'total=' + app.tabs.length);

  await app.patchSettings(snapshot); // deja los ajustes como estaban
  return { checks };
})()
`;

/**
 * Con `--shot <ruta.png>` guarda una captura de la ventana. La coloca fuera
 * de la pantalla para no interrumpir lo que el usuario este haciendo.
 */
async function maybeScreenshot(win) {
  const i = process.argv.indexOf('--shot');
  if (i < 0 || !process.argv[i + 1]) return;
  const target = path.resolve(process.argv[i + 1]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  win.setPosition(-4000, 60);
  win.setSize(1280, 800);
  win.show();
  await wait(700);

  // Algo de salida real, y con la pestana dividida, para que la captura
  // muestre la app como se usa de verdad.
  const [first] = [...sessions.values()];
  if (first) {
    first.proc.write('Get-ChildItem $env:USERPROFILE | Select-Object -First 5 Mode,Length,Name\r');
    await wait(1500);
    first.proc.write('claude --version; node --version\r');
    await wait(2000);
  }

  // El valor devuelto viaja por IPC: hay que resolver a algo clonable.
  await win.webContents.executeJavaScript("window.__adminTerm.splitActive('row').then(() => true)");
  await wait(1500);
  const second = [...sessions.values()].pop();
  if (second && second !== first) {
    second.proc.write('git -C "' + process.cwd().replace(/\\/g, '\\\\') + '" log --oneline -3\r');
    await wait(2200);
  }

  const shoot = async (file) => {
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, image.toPNG());
    console.log(`  (captura guardada en ${file})`);
  };

  fs.mkdirSync(path.dirname(target), { recursive: true });
  await shoot(target);

  // Segunda toma: tema claro con el panel de ajustes abierto.
  await win.webContents.executeJavaScript(
    "window.__adminTerm.patchSettings({ theme: 'claro' }).then(() => window.__adminTerm.openSettings())"
  );
  await wait(900);
  await shoot(target.replace(/\.png$/i, '') + '-claro.png');
  await win.webContents.executeJavaScript(
    "window.__adminTerm.closeSettings(); window.__adminTerm.patchSettings({ theme: 'oscuro' })"
  );

  win.hide();
}

/**
 * Modo `--selftest`: arranca sin mostrar ventana, ejerce la app de punta a
 * punta, imprime el informe y sale. Valida sin abrir la GUI.
 */
function runSelfTest(win) {
  const logs = [];
  // La firma de 'console-message' cambio en Electron: soportamos ambas.
  win.webContents.on('console-message', (a, b, c) => {
    if (a && typeof a === 'object' && 'message' in a) logs.push(`  [console:${a.level}] ${a.message}`);
    else logs.push(`  [console:${b}] ${c}`);
  });

  let finished = false;
  const finish = (ok, report) => {
    if (finished) return;
    finished = true;
    console.log(report);
    if (logs.length) console.log('Mensajes del renderer:\n' + logs.join('\n'));

    // Imprescindible: los hijos del PTY heredan stdout, y si sobreviven la
    // tuberia del proceso que nos lanzo nunca se cierra.
    try {
      killAllSessions();
      stopLocalServer();
      console.log('  (sesiones PTY cerradas)');
    } catch (err) {
      console.log(`  (fallo al cerrar las sesiones PTY: ${err.message})`);
    }

    // Cerramos la ventana en vez de llamar a app.exit(): asi el propio
    // selftest ejerce el camino de cierre real de la app y comprueba que no
    // deja procesos colgados. app.exit() con la ventana viva se bloquea.
    setTimeout(() => {
      const hard = setTimeout(() => {
        console.log('  FALLO cierre de ventana....... no termino en 6s');
        process.exit(1);
      }, 6000);
      win.once('closed', () => {
        clearTimeout(hard);
        console.log(`  OK   cierre de ventana......... limpio (sesiones PTY vivas: ${sessions.size})`);
        pendingExitCode = ok && sessions.size === 0 ? 0 : 1;
        // 'window-all-closed' saldra con ese codigo; esto es solo la reserva.
        setTimeout(() => process.exit(pendingExitCode), 3000);
      });
      win.close();
    }, 400);
  };

  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(SELFTEST_SCRIPT);
      await maybeScreenshot(win);

      // Comprobaciones que viven en el proceso principal y no en el renderer.
      const localCases = [
        ['http://127.0.0.1:8756/v1/audio/transcriptions', true],
        ['http://localhost:8756/v1/audio/transcriptions', true],
        ['http://[::1]:8756/v1/audio/transcriptions', true],
        ['https://api.openai.com/v1/audio/transcriptions', false],
        ['https://api.groq.com/openai/v1/audio/transcriptions', false],
        // Trampa: empieza por 127.0.0.1 pero es un host ajeno. Si se colase
        // como local, se enviaria audio a un tercero sin exigir API key.
        ['https://127.0.0.1.ejemplo.com/v1/audio/transcriptions', false],
      ];
      const wrong = localCases.filter(([url, expected]) => endpointIsLocal(url) !== expected);
      result.checks.push({
        name: 'endpoint local o remoto',
        ok: wrong.length === 0,
        detail: wrong.length ? 'mal clasificados: ' + wrong.map(([u]) => u).join(', ')
          : `${localCases.length} casos, incluida la trampa 127.0.0.1.ejemplo.com`,
      });

      const python = findPython();
      result.checks.push({
        name: 'python para Whisper',
        ok: !!python,
        detail: python || 'no encontrado (el dictado local no arrancaria)',
      });

      const script = whisperScriptPath();
      result.checks.push({
        name: 'servidor Whisper presente',
        ok: fs.existsSync(script),
        detail: fs.existsSync(script) ? script : `falta ${script}`,
      });

      const lines = [`  elevado........... ${elevated}`, `  shells detectadas. ${SHELLS.map((s) => s.key).join(', ')}`];
      for (const check of result.checks) {
        lines.push(`  ${check.ok ? 'OK  ' : 'FALLO'} ${check.name.padEnd(24, '.')} ${check.detail}`);
      }
      const ok = result.checks.every((c) => c.ok);
      finish(ok, [`selftest: ${ok ? 'OK' : 'FALLO'}`, ...lines].join('\n'));
    } catch (err) {
      finish(false, `selftest: FALLO al evaluar el renderer -> ${err.message}`);
    }
  });

  setTimeout(() => finish(false, 'selftest: FALLO por timeout global (90s)'), 90000);
}

/**
 * `--stt-check` ejerce el camino real del dictado sin ventana ni microfono:
 * arranca el servidor local si hace falta, transcribe y mide.
 *
 * Los parametros llegan por entorno (ADMINTERM_STT_FILE / _ENDPOINT / _MODEL /
 * _LANGUAGE) y no por argv: Electron se come parte de la linea de comandos y
 * con varios pares "--flag valor" el proceso muere antes de arrancar.
 * Los ajustes se tocan solo en memoria, no se guardan.
 */
async function runSttCheck() {
  const file = process.env.ADMINTERM_STT_FILE;
  const stt = getSettings().stt;
  if (process.env.ADMINTERM_STT_ENDPOINT) stt.endpoint = process.env.ADMINTERM_STT_ENDPOINT;
  if (process.env.ADMINTERM_STT_MODEL) stt.model = process.env.ADMINTERM_STT_MODEL;
  if (process.env.ADMINTERM_STT_LANGUAGE) stt.language = process.env.ADMINTERM_STT_LANGUAGE;

  const done = (code, ...lines) => {
    for (const line of lines) console.log(line);
    stopLocalServer();
    setTimeout(() => process.exit(code), 300);
  };

  if (!file || !fs.existsSync(file)) return done(1, `stt-check: no se encontro el audio "${file}"`);

  console.log(`stt-check: ${path.basename(file)} -> ${stt.endpoint} (modelo ${stt.model})`);
  const t0 = Date.now();
  let ready = t0;
  const result = await transcribeAudio(
    {
      bytes: fs.readFileSync(file),
      mimeType: file.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/webm',
      filename: path.basename(file),
    },
    (message) => {
      console.log(`  · ${message}`);
      if (/listo/i.test(message)) ready = Date.now();
    }
  );

  if (!result.ok) return done(1, `stt-check: FALLO (${result.code || 'error'}) ${result.error}`);
  return done(
    0,
    `stt-check: OK`,
    `  arranque del servidor... ${((ready - t0) / 1000).toFixed(1)}s`,
    `  transcripcion........... ${((Date.now() - ready) / 1000).toFixed(1)}s`,
    `  texto................... "${result.text}"`
  );
}

app.whenReady().then(() => {
  if (process.argv.includes('--stt-check')) return runSttCheck();
  return createWindow();
});

// Codigo con el que saldra el proceso al cerrarse la ultima ventana.
let pendingExitCode = 0;

app.on('window-all-closed', () => {
  killAllSessions();
  stopLocalServer();
  // Salida directa en lugar de app.quit(): el apagado "elegante" de Electron
  // se bloquea esperando a que ConPTY libere sus handles y la app sobrevive
  // como proceso fantasma (reproducible en la build empaquetada). No hay nada
  // que vaciar: los ajustes se escriben de forma sincrona en cada cambio.
  process.exit(pendingExitCode);
});

app.on('before-quit', killAllSessions);

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('app:info', () => ({
  elevated,
  uacDenied,
  // En modo prueba no se reabre ni se guarda la sesion: el resultado debe
  // depender solo del codigo, no de lo que quedara guardado del run anterior.
  selftest: SELFTEST,
  version: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  shells: SHELLS.map(({ key, label }) => ({ key, label })),
  winBuild: Number((os.release().split('.')[2] || '0')) || undefined,
  defaultCwd: defaultCwd(),
  home: os.homedir(),
  userData: app.getPath('userData'),
  settingsFile: settingsPath(),
}));

ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (_e, patch) => saveSettings(patch));
ipcMain.handle('settings:reset', () => {
  settingsCache = null;
  try {
    fs.unlinkSync(settingsPath());
  } catch {
    /* no existia */
  }
  return getSettings();
});

ipcMain.handle('pty:create', (_e, opts) => {
  try {
    return { ok: true, ...createSession(mainWindow, opts || {}) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.on('pty:input', (_e, { id, data }) => {
  const s = sessions.get(id);
  if (s && s.alive) s.proc.write(data);
});

ipcMain.on('pty:resize', (_e, { id, cols, rows }) => {
  const s = sessions.get(id);
  if (!s || !s.alive) return;
  try {
    s.proc.resize(Math.max(2, cols | 0), Math.max(1, rows | 0));
  } catch {
    /* la sesion se cerro entre medias */
  }
});

ipcMain.on('pty:kill', (_e, { id }) => killSession(id));

ipcMain.handle('dialog:openFiles', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Seleccionar archivos',
    buttonLabel: 'Insertar ruta',
    properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Seleccionar carpeta',
    properties: ['openDirectory', 'dontAddToRecent'],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('sys:winH', () => {
  if (!IS_WIN) return { ok: false, error: 'Solo disponible en Windows.' };
  try {
    sendWinH();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('sys:relaunchElevated', () => {
  if (relaunchElevated()) {
    // Mismo motivo que arriba: app.exit() se queda colgado y dejaria este
    // proceso vivo junto al recien elevado.
    setTimeout(() => {
      killAllSessions();
      stopLocalServer();
      process.exit(0);
    }, 400);
    return { ok: true };
  }
  return { ok: false, error: 'UAC cancelado o bloqueado por politica del sistema.' };
});

ipcMain.handle('sys:applyHotkey', () => applyGlobalHotkey());

ipcMain.handle('sys:openExternal', (_e, url) => {
  if (/^https?:/i.test(url)) shell.openExternal(url);
});

// El modulo `clipboard` del renderer esta deprecado, asi que vive aqui.
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text ?? '')));

/**
 * Transcribe un audio. Camino unico para el microfono, el boton "Probar" y el
 * diagnostico `--stt-check`, para que los tres ejerzan exactamente lo mismo.
 */
async function transcribeAudio({ bytes, mimeType, filename }, notify = () => {}) {
  const stt = getSettings().stt;
  const isLocal = endpointIsLocal(stt.endpoint);

  // Con servidor local no hace falta credencial; con uno remoto, si.
  if (!stt.apiKey && !isLocal) {
    return { ok: false, code: 'NO_KEY', error: 'Falta la API key de transcripcion en Ajustes.' };
  }

  if (isLocal) {
    const ready = await ensureLocalServer(stt.endpoint, notify);
    if (!ready.ok) return { ok: false, code: 'LOCAL_SERVER', error: ready.error };
  }

  try {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType || 'audio/webm' }), filename || 'audio.webm');
    form.append('model', stt.model || 'whisper-1');
    if (stt.language) form.append('language', stt.language);
    form.append('response_format', 'json');

    const res = await fetch(stt.endpoint, {
      method: 'POST',
      headers: stt.apiKey ? { Authorization: `Bearer ${stt.apiKey}` } : {},
      body: form,
      // Un audio largo en CPU puede tardar; sin tope, un cuelgue seria eterno.
      signal: AbortSignal.timeout(180000),
    });

    const raw = await res.text();
    if (!res.ok) {
      let detail = raw.slice(0, 400);
      try {
        detail = JSON.parse(raw).error?.message || detail;
      } catch {
        /* respuesta no JSON */
      }
      return { ok: false, error: `HTTP ${res.status}: ${detail}` };
    }

    let text = raw.trim();
    try {
      const json = JSON.parse(raw);
      text = (json.text ?? json.transcript ?? '').trim();
    } catch {
      /* algunos endpoints devuelven texto plano */
    }
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

ipcMain.handle('stt:transcribe', (_e, payload) =>
  transcribeAudio(payload, (message) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('stt:status', message);
  })
);
