'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
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
  stt: {
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'whisper-1',
    apiKey: '',
    language: 'es',
    deviceId: '',
    autoSend: false,
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

/** Relanza la app pidiendo UAC. Devuelve true si el proceso elevado arranco. */
function relaunchElevated() {
  const exe = process.execPath;
  const rest = process.defaultApp
    ? [path.resolve(process.argv[1] || '.'), ...process.argv.slice(2)]
    : process.argv.slice(1);
  const args = rest.filter((a) => a !== '--no-elevate' && a !== '--elevated');

  // Cada argumento va entrecomillado para sobrevivir rutas con espacios.
  const argList = args.map((a) => psQuote(`"${String(a).replace(/"/g, '\\"')}"`)).join(',');
  const parts = [`Start-Process -FilePath ${psQuote(exe)}`, '-Verb RunAs'];
  if (argList) parts.push(`-ArgumentList ${argList}`);
  parts.push(`-WorkingDirectory ${psQuote(process.cwd())}`);

  try {
    execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', parts.join(' ')], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 60000,
    });
    return true;
  } catch {
    return false; // UAC cancelado o bloqueado por politica
  }
}

const elevated = isElevated();
let uacDenied = false;

if (IS_WIN && !elevated && !process.argv.includes('--no-elevate') && getSettings().autoElevate) {
  if (relaunchElevated()) {
    app.exit(0);
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
// Ventana
// ---------------------------------------------------------------------------

let mainWindow = null;
const SELFTEST = process.argv.includes('--selftest');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
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

  mainWindow.on('closed', () => {
    killAllSessions();
    mainWindow = null;
  });
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
  const pathDeadline = Date.now() + 6000;
  let pathOk = false;
  const activeTab = app.activeTab;
  while (Date.now() < pathDeadline && !pathOk) {
    await sleep(200);
    pathOk = bufferOf(activeTab).includes('"' + probe + '"');
  }
  add('insertar archivos', pathOk, pathOk ? 'ruta con espacios entrecomillada' : 'no aparecio en el prompt');
  window.adminterm.ptyInput(activeTab.id, '\u0003'); // Ctrl+C: limpia la linea

  // --- modal de ajustes ---
  app.openSettings();
  const modalOpen = !document.getElementById('settings-modal').hidden &&
    document.getElementById('set-fontSize').value === '19';
  app.closeSettings();
  const modalClosed = document.getElementById('settings-modal').hidden;
  add('panel de ajustes', modalOpen && modalClosed, 'abre, refleja valores y cierra');

  // --- cerrar pestana ---
  app.destroyTab(app.tabs[1]);
  await sleep(200);
  add('cerrar pestana', app.tabs.length === 1, 'total=' + app.tabs.length);

  await app.patchSettings(snapshot); // deja los ajustes como estaban
  return { checks };
})()
`;

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
      console.log('  (sesiones PTY cerradas)');
    } catch (err) {
      console.log(`  (fallo al cerrar las sesiones PTY: ${err.message})`);
    }

    setTimeout(() => {
      console.log('  (saliendo)');
      app.exit(ok ? 0 : 1);
      // Red de seguridad: si el apagado de Electron se queda esperando a
      // ConPTY, forzamos la salida del proceso.
      setTimeout(() => process.exit(ok ? 0 : 1), 1500);
    }, 400);
  };

  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(SELFTEST_SCRIPT);

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  killAllSessions();
  app.quit();
  // El apagado de Electron puede quedarse esperando a que ConPTY libere sus
  // handles; sin esto la app sobreviviria como proceso fantasma.
  setTimeout(() => process.exit(0), 2500).unref();
});

app.on('before-quit', killAllSessions);

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('app:info', () => ({
  elevated,
  uacDenied,
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
    setTimeout(() => app.exit(0), 400);
    return { ok: true };
  }
  return { ok: false, error: 'UAC cancelado o bloqueado por politica del sistema.' };
});

ipcMain.handle('sys:openExternal', (_e, url) => {
  if (/^https?:/i.test(url)) shell.openExternal(url);
});

ipcMain.handle('stt:transcribe', async (_e, { bytes, mimeType, filename }) => {
  const stt = getSettings().stt;
  if (!stt.apiKey) {
    return { ok: false, code: 'NO_KEY', error: 'Falta la API key de transcripcion en Ajustes.' };
  }
  try {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType || 'audio/webm' }), filename || 'audio.webm');
    form.append('model', stt.model || 'whisper-1');
    if (stt.language) form.append('language', stt.language);
    form.append('response_format', 'json');

    const res = await fetch(stt.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${stt.apiKey}` },
      body: form,
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
});
