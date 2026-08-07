'use strict';

const api = window.adminterm;

// ---------------------------------------------------------------------------
// Temas del terminal (pensados para leer texto durante horas)
// ---------------------------------------------------------------------------

const THEMES = {
  oscuro: {
    background: '#0b0e14', foreground: '#e6edf3',
    cursor: '#ffb454', cursorAccent: '#0b0e14',
    selectionBackground: '#33415e', selectionForeground: '#ffffff',
    black: '#3d4451', red: '#ff6b6b', green: '#7ee787', yellow: '#ffd580',
    blue: '#73b8ff', magenta: '#d2a8ff', cyan: '#5ccfe6', white: '#e6edf3',
    brightBlack: '#7b8797', brightRed: '#ff9292', brightGreen: '#9ff3a8', brightYellow: '#ffe3a3',
    brightBlue: '#9ecbff', brightMagenta: '#e2c5ff', brightCyan: '#8ce6f4', brightWhite: '#ffffff',
  },
  'oscuro-suave': {
    background: '#1b1f27', foreground: '#dfe5ec',
    cursor: '#7ee787', cursorAccent: '#1b1f27',
    selectionBackground: '#3a4557', selectionForeground: '#ffffff',
    black: '#4a5262', red: '#ff7b7b', green: '#8ce99a', yellow: '#ffd88a',
    blue: '#82c0ff', magenta: '#d7b0ff', cyan: '#6fd7ea', white: '#dfe5ec',
    brightBlack: '#8792a3', brightRed: '#ff9d9d', brightGreen: '#a6f2b1', brightYellow: '#ffe7ae',
    brightBlue: '#a6d4ff', brightMagenta: '#e6ccff', brightCyan: '#96e6f2', brightWhite: '#ffffff',
  },
  claro: {
    background: '#ffffff', foreground: '#1c1f24',
    cursor: '#0b6a8c', cursorAccent: '#ffffff',
    selectionBackground: '#cfe4ff', selectionForeground: '#0d1117',
    black: '#24292f', red: '#b81f1f', green: '#116329', yellow: '#7a5000',
    blue: '#0a4fa8', magenta: '#6f2da8', cyan: '#0b6a8c', white: '#57606a',
    brightBlack: '#4b535e', brightRed: '#cf2020', brightGreen: '#16803a', brightYellow: '#8f6100',
    brightBlue: '#0d63cf', brightMagenta: '#8250df', brightCyan: '#0e7fa5', brightWhite: '#24292f',
  },
};

const FONT_CANDIDATES = [
  'Cascadia Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Hack',
  'IBM Plex Mono', 'Source Code Pro', 'DejaVu Sans Mono', 'Consolas',
  'Lucida Console', 'Courier New',
];

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

let settings = null;
let info = null;
let availableFonts = [];
const tabs = [];
window.__adminTermTabs = tabs; // usado por `npm run selftest`
let activeTab = null;
let toastTimer = null;

const $ = (id) => document.getElementById(id);
const els = {
  tabs: $('tabs'), terminals: $('terminals'), shellSelect: $('shell-select'),
  fontLabel: $('font-size-label'), statusPriv: $('status-priv'), statusShell: $('status-shell'),
  statusMsg: $('status-msg'), statusMic: $('status-mic'), statusVersions: $('status-versions'),
  dropOverlay: $('drop-overlay'), micOverlay: $('mic-overlay'), micTimer: $('mic-timer'),
  btnMic: $('btn-mic'), modal: $('settings-modal'), toast: $('toast'),
  searchBar: $('search-bar'), searchInput: $('search-input'),
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function toast(message, kind = '', action = null) {
  els.toast.textContent = message;
  els.toast.className = kind;
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      hideToast();
      action.run();
    });
    els.toast.appendChild(btn);
  }
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 12000 : 5000);
}

function hideToast() {
  els.toast.hidden = true;
  els.toast.textContent = '';
}

/** document.fonts.check miente con familias inexistentes: medimos el ancho. */
function detectFonts(names) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const sample = 'mmmmmmmmmmlliWWQ@1Il0O';
  const baseline = {};
  for (const generic of ['monospace', 'serif']) {
    ctx.font = `72px ${generic}`;
    baseline[generic] = ctx.measureText(sample).width;
  }
  return names.filter((name) => {
    for (const generic of ['monospace', 'serif']) {
      ctx.font = `72px "${name}", ${generic}`;
      if (Math.abs(ctx.measureText(sample).width - baseline[generic]) > 0.5) return true;
    }
    return false;
  });
}

function fontStack(primary) {
  const stack = [primary, 'Cascadia Mono', 'Consolas', 'Courier New', 'monospace'];
  return stack
    .filter((f, i) => f && stack.indexOf(f) === i)
    .map((f) => (/\s/.test(f) ? `"${f}"` : f))
    .join(', ');
}

function quotePath(p) {
  return /[\s&()^%!,;=`'{}[\]]/.test(p) ? `"${p}"` : p;
}

// ---------------------------------------------------------------------------
// Terminales
// ---------------------------------------------------------------------------

function termOptions() {
  const winBuild = info && info.winBuild ? info.winBuild : undefined;
  const opts = {
    fontFamily: fontStack(settings.fontFamily),
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    letterSpacing: settings.letterSpacing,
    fontWeight: String(settings.fontWeight || 400),
    fontWeightBold: '700',
    cursorStyle: settings.cursorStyle,
    cursorBlink: !!settings.cursorBlink,
    scrollback: settings.scrollback,
    theme: THEMES[settings.theme] || THEMES.oscuro,
    minimumContrastRatio: settings.highContrast ? 4.5 : 1,
    drawBoldTextInBrightColors: true,
    allowProposedApi: true,
    convertEol: false,
    scrollOnUserInput: true,
    smoothScrollDuration: 0,
    rightClickSelectsWord: false,
  };
  if (winBuild) opts.windowsPty = { backend: 'conpty', buildNumber: winBuild };
  return opts;
}

function renderTabs() {
  els.tabs.textContent = '';
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab === activeTab ? ' active' : '') + (tab.dead ? ' dead' : '');
    el.setAttribute('role', 'tab');

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title;
    el.appendChild(title);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Cerrar pestana';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab);
    });
    el.appendChild(close);

    el.addEventListener('click', () => activateTab(tab));
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) closeTab(tab);
    });
    els.tabs.appendChild(el);
  }
  updateStatus();
}

function updateStatus() {
  if (!info) return;
  els.statusPriv.className = 'badge ' + (info.elevated ? 'admin' : 'user');
  els.statusPriv.textContent = info.elevated ? 'Administrador' : 'Usuario normal';
  if (!info.elevated) {
    const btn = document.createElement('button');
    btn.textContent = 'Reiniciar como admin';
    btn.addEventListener('click', async () => {
      const res = await api.relaunchElevated();
      if (!res.ok) toast(res.error, 'error');
    });
    els.statusPriv.appendChild(btn);
  }

  const shellLabel = (info.shells.find((s) => s.key === (activeTab ? activeTab.shellKey : settings.shell)) || {}).label || '';
  els.statusShell.textContent = shellLabel + (activeTab ? `  ·  ${activeTab.term.cols}x${activeTab.term.rows}` : '');
  els.fontLabel.textContent = String(settings.fontSize);
  els.statusVersions.textContent = `AdminTerm ${info.version}  ·  Electron ${info.electron}`;
}

function fitTab(tab) {
  if (!tab || tab.dead || tab.pane.offsetParent === null) return;
  try {
    tab.fit.fit();
    api.ptyResize(tab.id, tab.term.cols, tab.term.rows);
  } catch {
    /* pane sin tamano todavia */
  }
  updateStatus();
}

async function newTab(shellKey) {
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  els.terminals.appendChild(pane);

  const term = new Terminal(termOptions());
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => api.openExternal(uri)));

  try {
    const uni = new Unicode11Addon.Unicode11Addon();
    term.loadAddon(uni);
    term.unicode.activeVersion = '11';
  } catch (err) {
    console.warn('unicode11 no disponible:', err);
  }

  term.open(pane);

  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch (err) {
    console.warn('WebGL no disponible, se usa el renderer DOM:', err);
  }

  try { fit.fit(); } catch { /* aun sin layout */ }

  const res = await api.ptyCreate({
    shellKey: shellKey || settings.shell,
    cols: term.cols,
    rows: term.rows,
  });

  if (!res || !res.ok) {
    pane.remove();
    term.dispose();
    toast(`No se pudo abrir la terminal: ${res ? res.error : 'error desconocido'}`, 'error');
    return null;
  }

  const tab = {
    id: res.id, term, fit, search, pane,
    title: res.label, shellKey: res.shellKey, dead: false,
  };
  tabs.push(tab);

  term.onData((data) => api.ptyInput(tab.id, data));
  term.onTitleChange((t) => {
    const clean = String(t || '').trim();
    if (clean) {
      tab.title = clean.length > 40 ? clean.slice(0, 39) + '…' : clean;
      renderTabs();
    }
  });
  term.attachCustomKeyEventHandler((e) => !(e.type === 'keydown' && isAppShortcut(e)));

  pane.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const selection = term.getSelection();
    if (selection) {
      api.writeClipboard(selection);
      term.clearSelection();
      els.statusMsg.textContent = 'Copiado';
      setTimeout(() => (els.statusMsg.textContent = ''), 1200);
    } else {
      pasteIntoTerm(tab);
    }
  });

  const ro = new ResizeObserver(() => {
    clearTimeout(tab.resizeTimer);
    tab.resizeTimer = setTimeout(() => fitTab(tab), 40);
  });
  ro.observe(pane);
  tab.observer = ro;

  activateTab(tab);
  return tab;
}

function activateTab(tab) {
  activeTab = tab;
  for (const t of tabs) t.pane.classList.toggle('active', t === tab);
  renderTabs();
  requestAnimationFrame(() => {
    fitTab(tab);
    tab.term.focus();
  });
}

function closeTab(tab) {
  if (settings.confirmClose && !tab.dead) {
    // Confirmacion barata: doble pulsacion en 3 segundos.
    if (!tab.pendingClose) {
      tab.pendingClose = true;
      setTimeout(() => (tab.pendingClose = false), 3000);
      toast(`Vuelve a pulsar la X para cerrar "${tab.title}" (hay una sesion activa).`, '', {
        label: 'Cerrar ahora',
        run: () => destroyTab(tab),
      });
      return;
    }
  }
  destroyTab(tab);
}

function destroyTab(tab) {
  api.ptyKill(tab.id);
  if (tab.observer) tab.observer.disconnect();
  tab.term.dispose();
  tab.pane.remove();
  const i = tabs.indexOf(tab);
  if (i >= 0) tabs.splice(i, 1);
  if (activeTab === tab) {
    activeTab = null;
    if (tabs.length) activateTab(tabs[Math.min(i, tabs.length - 1)]);
    else newTab();
  } else {
    renderTabs();
  }
}

function tabById(id) {
  return tabs.find((t) => t.id === id);
}

api.onPtyData(({ id, data }) => {
  const tab = tabById(id);
  if (tab) tab.term.write(data);
});

api.onPtyExit(({ id, exitCode }) => {
  const tab = tabById(id);
  if (!tab) return;
  tab.dead = true;
  tab.term.write(`\r\n\x1b[38;5;244m[proceso finalizado - codigo ${exitCode}. Ctrl+Shift+W para cerrar la pestana]\x1b[0m\r\n`);
  renderTabs();
});

// ---------------------------------------------------------------------------
// Portapapeles y archivos
// ---------------------------------------------------------------------------

function pasteIntoTerm(tab) {
  const text = api.readClipboard();
  if (!text) return;
  api.ptyInput(tab.id, text.replace(/\r\n/g, '\r').replace(/\n/g, '\r'));
}

function insertPaths(paths) {
  if (!activeTab || !paths.length) return;
  const text = paths.map(quotePath).join(' ') + ' ';
  api.ptyInput(activeTab.id, text);
  activeTab.term.focus();
  toast(`${paths.length} ruta(s) insertada(s).`, 'ok');
}

async function pickFiles() {
  const paths = await api.pickFiles();
  insertPaths(paths);
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  els.dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    els.dropOverlay.hidden = true;
  }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  const paths = [...(e.dataTransfer.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
  if (paths.length) insertPaths(paths);
  else toast('No se pudo leer la ruta de lo soltado. Usa el boton Archivos.', 'error');
});

// ---------------------------------------------------------------------------
// Microfono
// ---------------------------------------------------------------------------

const mic = { stream: null, recorder: null, chunks: [], startedAt: 0, timer: null, cancelled: false };

function micUi(active) {
  els.micOverlay.hidden = !active;
  els.btnMic.classList.toggle('recording', active);
  els.statusMic.hidden = !active;
  els.statusMic.textContent = active ? '● Grabando' : '';
}

function pickMimeType() {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

async function startMic() {
  if (mic.recorder) return;
  if (!settings.stt.apiKey) {
    toast(
      'Configura una API key de transcripcion en Ajustes para dictar dentro de AdminTerm.',
      'error',
      { label: 'Abrir ajustes', run: openSettings }
    );
    return;
  }
  try {
    const constraints = {
      audio: settings.stt.deviceId
        ? { deviceId: { exact: settings.stt.deviceId }, echoCancellation: true, noiseSuppression: true }
        : { echoCancellation: true, noiseSuppression: true },
    };
    mic.stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    toast(`No se pudo abrir el microfono: ${err.message}`, 'error');
    return;
  }

  const mimeType = pickMimeType();
  mic.chunks = [];
  mic.cancelled = false;
  mic.recorder = new MediaRecorder(mic.stream, mimeType ? { mimeType } : undefined);
  mic.recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) mic.chunks.push(e.data);
  };
  mic.recorder.onstop = onMicStop;
  mic.recorder.start();

  mic.startedAt = Date.now();
  els.micTimer.textContent = ' 0:00';
  mic.timer = setInterval(() => {
    const s = Math.floor((Date.now() - mic.startedAt) / 1000);
    els.micTimer.textContent = ` ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);

  micUi(true);
}

function stopMic(cancel = false) {
  if (!mic.recorder) return;
  mic.cancelled = cancel;
  clearInterval(mic.timer);
  try {
    mic.recorder.stop();
  } catch {
    /* ya parado */
  }
  micUi(false);
}

async function onMicStop() {
  const chunks = mic.chunks;
  const type = mic.recorder ? mic.recorder.mimeType : 'audio/webm';
  const cancelled = mic.cancelled;

  for (const track of mic.stream.getTracks()) track.stop();
  mic.recorder = null;
  mic.stream = null;
  mic.chunks = [];

  if (cancelled || !chunks.length) return;

  const blob = new Blob(chunks, { type });
  if (blob.size < 1200) {
    toast('Grabacion demasiado corta.', 'error');
    return;
  }

  els.statusMsg.textContent = 'Transcribiendo…';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
  const res = await api.transcribe(bytes, type.split(';')[0], `dictado.${ext}`);
  els.statusMsg.textContent = '';

  if (!res.ok) {
    if (res.code === 'NO_KEY') {
      toast(res.error, 'error', { label: 'Abrir ajustes', run: openSettings });
    } else {
      toast(`Transcripcion fallida. ${res.error}`, 'error');
    }
    return;
  }
  if (!res.text) {
    toast('No se detecto voz en la grabacion.', 'error');
    return;
  }
  if (!activeTab) return;
  api.ptyInput(activeTab.id, res.text + (settings.stt.autoSend ? '\r' : ''));
  activeTab.term.focus();
}

async function refreshMicDevices() {
  const select = $('set-stt-device');
  if (!select) return;
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  } catch {
    devices = [];
  }
  select.textContent = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'Predeterminado del sistema';
  select.appendChild(def);
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microfono ${select.length}`;
    select.appendChild(opt);
  }
  select.value = settings.stt.deviceId || '';
}

// ---------------------------------------------------------------------------
// Busqueda
// ---------------------------------------------------------------------------

function openSearch() {
  els.searchBar.hidden = false;
  els.searchInput.select();
  els.searchInput.focus();
}

function closeSearch() {
  els.searchBar.hidden = true;
  if (activeTab) {
    activeTab.search.clearDecorations();
    activeTab.term.focus();
  }
}

function runSearch(back = false) {
  if (!activeTab || !els.searchInput.value) return;
  const opts = { decorations: { matchOverviewRuler: '#ffb454', activeMatchColorOverviewRuler: '#5ccfe6' } };
  if (back) activeTab.search.findPrevious(els.searchInput.value, opts);
  else activeTab.search.findNext(els.searchInput.value, opts);
}

// ---------------------------------------------------------------------------
// Atajos
// ---------------------------------------------------------------------------

function isAppShortcut(e) {
  if (!e.ctrlKey || e.altKey) return false;
  const k = e.key.toLowerCase();
  if (e.shiftKey && ['t', 'w', 'c', 'v', 'f', 'm', 'o'].includes(k)) return true;
  if (!e.shiftKey && (k === 'tab' || k === ',' || k === '+' || k === '-' || k === '=' || k === '0')) return true;
  if (e.shiftKey && k === 'tab') return true;
  if (!e.shiftKey && /^[1-9]$/.test(k)) return true;
  return false;
}

document.addEventListener('keydown', (e) => {
  // Esc cierra lo que este abierto encima.
  if (e.key === 'Escape') {
    if (mic.recorder) return stopMic(false);
    if (!els.searchBar.hidden) return closeSearch();
    if (!els.modal.hidden) return closeSettings();
    if (!els.toast.hidden) return hideToast();
    return;
  }

  if (!els.searchBar.hidden && document.activeElement === els.searchInput && e.key === 'Enter') {
    e.preventDefault();
    runSearch(e.shiftKey);
    return;
  }

  if (!isAppShortcut(e)) return;
  const k = e.key.toLowerCase();
  e.preventDefault();

  if (e.shiftKey) {
    switch (k) {
      case 't': newTab(); return;
      case 'w': if (activeTab) closeTab(activeTab); return;
      case 'c':
        if (activeTab && activeTab.term.hasSelection()) {
          api.writeClipboard(activeTab.term.getSelection());
          els.statusMsg.textContent = 'Copiado';
          setTimeout(() => (els.statusMsg.textContent = ''), 1200);
        }
        return;
      case 'v': if (activeTab) pasteIntoTerm(activeTab); return;
      case 'f': openSearch(); return;
      case 'm': mic.recorder ? stopMic(false) : startMic(); return;
      case 'o': pickFiles(); return;
      case 'tab': cycleTab(-1); return;
    }
    return;
  }

  if (k === 'tab') return cycleTab(1);
  if (k === ',') return openSettings();
  if (k === '+' || k === '=') return setFontSize(settings.fontSize + 1);
  if (k === '-') return setFontSize(settings.fontSize - 1);
  if (k === '0') return setFontSize(15);
  if (/^[1-9]$/.test(k)) {
    const idx = Number(k) - 1;
    if (tabs[idx]) activateTab(tabs[idx]);
  }
});

function cycleTab(delta) {
  if (tabs.length < 2 || !activeTab) return;
  const i = tabs.indexOf(activeTab);
  activateTab(tabs[(i + delta + tabs.length) % tabs.length]);
}

els.terminals.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setFontSize(settings.fontSize + (e.deltaY < 0 ? 1 : -1));
  },
  { passive: false }
);

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

async function patchSettings(patch) {
  settings = await api.setSettings(patch);
  applySettings();
}

function setFontSize(size) {
  const clamped = Math.min(40, Math.max(8, Math.round(size)));
  if (clamped === settings.fontSize) return Promise.resolve();
  return patchSettings({ fontSize: clamped });
}

function applySettings() {
  document.documentElement.setAttribute('data-ui', settings.theme === 'claro' ? 'claro' : 'oscuro');
  const opts = termOptions();
  for (const tab of tabs) {
    for (const [key, value] of Object.entries(opts)) {
      try {
        tab.term.options[key] = value;
      } catch (err) {
        console.warn(`opcion "${key}" no aplicada:`, err.message);
      }
    }
    fitTab(tab);
  }
  updateStatus();
}

function openSettings() {
  fillSettingsForm();
  els.modal.hidden = false;
  refreshMicDevices();
}

function closeSettings() {
  els.modal.hidden = true;
  if (activeTab) activeTab.term.focus();
}

function fillSettingsForm() {
  const fontSel = $('set-fontFamily');
  fontSel.textContent = '';
  for (const f of availableFonts) {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f;
    fontSel.appendChild(opt);
  }
  if (!availableFonts.includes(settings.fontFamily)) {
    const opt = document.createElement('option');
    opt.value = settings.fontFamily;
    opt.textContent = `${settings.fontFamily} (no instalada)`;
    fontSel.appendChild(opt);
  }
  fontSel.value = settings.fontFamily;

  const shellSel = $('set-shell');
  shellSel.textContent = '';
  for (const s of info.shells) {
    const opt = document.createElement('option');
    opt.value = s.key;
    opt.textContent = s.label;
    shellSel.appendChild(opt);
  }
  shellSel.value = settings.shell;

  $('set-fontSize').value = settings.fontSize;
  $('set-lineHeight').value = settings.lineHeight;
  $('set-letterSpacing').value = settings.letterSpacing;
  $('set-fontWeight').value = String(settings.fontWeight);
  $('set-theme').value = settings.theme;
  $('set-cursorStyle').value = settings.cursorStyle;
  $('set-cursorBlink').checked = !!settings.cursorBlink;
  $('set-highContrast').checked = !!settings.highContrast;
  $('set-startCwd').value = settings.startCwd;
  $('set-scrollback').value = settings.scrollback;
  $('set-autoElevate').checked = !!settings.autoElevate;
  $('set-confirmClose').checked = !!settings.confirmClose;
  $('set-stt-endpoint').value = settings.stt.endpoint;
  $('set-stt-model').value = settings.stt.model;
  $('set-stt-apiKey').value = settings.stt.apiKey;
  $('set-stt-language').value = settings.stt.language;
  $('set-stt-autoSend').checked = !!settings.stt.autoSend;
  $('paths-hint').textContent = `Ajustes guardados en: ${info.settingsFile}`;
}

function bindSettingsForm() {
  const simple = {
    'set-fontFamily': ['fontFamily', String],
    'set-fontSize': ['fontSize', Number],
    'set-lineHeight': ['lineHeight', Number],
    'set-letterSpacing': ['letterSpacing', Number],
    'set-fontWeight': ['fontWeight', Number],
    'set-theme': ['theme', String],
    'set-cursorStyle': ['cursorStyle', String],
    'set-startCwd': ['startCwd', String],
    'set-scrollback': ['scrollback', Number],
    'set-shell': ['shell', String],
  };
  for (const [id, [key, cast]] of Object.entries(simple)) {
    $(id).addEventListener('change', (e) => patchSettings({ [key]: cast(e.target.value) }));
  }

  const checks = {
    'set-cursorBlink': 'cursorBlink',
    'set-highContrast': 'highContrast',
    'set-autoElevate': 'autoElevate',
    'set-confirmClose': 'confirmClose',
  };
  for (const [id, key] of Object.entries(checks)) {
    $(id).addEventListener('change', (e) => patchSettings({ [key]: e.target.checked }));
  }

  const stt = {
    'set-stt-endpoint': 'endpoint',
    'set-stt-model': 'model',
    'set-stt-apiKey': 'apiKey',
    'set-stt-language': 'language',
    'set-stt-device': 'deviceId',
  };
  for (const [id, key] of Object.entries(stt)) {
    $(id).addEventListener('change', (e) => patchSettings({ stt: { [key]: e.target.value } }));
  }
  $('set-stt-autoSend').addEventListener('change', (e) =>
    patchSettings({ stt: { autoSend: e.target.checked } })
  );

  $('btn-pick-cwd').addEventListener('click', async (e) => {
    e.preventDefault();
    const dirs = await api.pickFolder();
    if (dirs.length) {
      await patchSettings({ startCwd: dirs[0] });
      $('set-startCwd').value = dirs[0];
    }
  });

  $('btn-mic-perm').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of s.getTracks()) t.stop();
      await refreshMicDevices();
      toast('Microfono autorizado.', 'ok');
    } catch (err) {
      toast(`Permiso denegado: ${err.message}`, 'error');
    }
  });

  $('settings-close').addEventListener('click', closeSettings);
  $('settings-done').addEventListener('click', closeSettings);
  els.modal.querySelector('.modal-backdrop').addEventListener('click', closeSettings);
  $('settings-reset').addEventListener('click', async () => {
    settings = await api.resetSettings();
    applySettings();
    fillSettingsForm();
    toast('Ajustes restablecidos.', 'ok');
  });
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

function bindToolbar() {
  $('btn-new-tab').addEventListener('click', () => newTab());
  $('btn-files').addEventListener('click', pickFiles);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-font-plus').addEventListener('click', () => setFontSize(settings.fontSize + 1));
  $('btn-font-minus').addEventListener('click', () => setFontSize(settings.fontSize - 1));
  els.btnMic.addEventListener('click', () => (mic.recorder ? stopMic(false) : startMic()));
  $('mic-stop').addEventListener('click', () => stopMic(false));
  $('mic-cancel').addEventListener('click', () => stopMic(true));
  els.shellSelect.addEventListener('change', (e) => patchSettings({ shell: e.target.value }));
  $('search-next').addEventListener('click', () => runSearch(false));
  $('search-prev').addEventListener('click', () => runSearch(true));
  $('search-close').addEventListener('click', closeSearch);
  els.searchInput.addEventListener('input', () => runSearch(false));
  window.addEventListener('resize', () => fitTab(activeTab));
}

async function boot() {
  info = await api.info();
  settings = await api.getSettings();

  availableFonts = detectFonts(FONT_CANDIDATES);
  if (!availableFonts.includes(settings.fontFamily) && availableFonts.length) {
    const preferred = ['Cascadia Mono', 'JetBrains Mono', 'Cascadia Code', 'Consolas'];
    settings.fontFamily = preferred.find((f) => availableFonts.includes(f)) || availableFonts[0];
  }

  els.shellSelect.textContent = '';
  for (const s of info.shells) {
    const opt = document.createElement('option');
    opt.value = s.key;
    opt.textContent = s.label;
    els.shellSelect.appendChild(opt);
  }
  els.shellSelect.value = info.shells.some((s) => s.key === settings.shell) ? settings.shell : info.shells[0].key;

  document.documentElement.setAttribute('data-ui', settings.theme === 'claro' ? 'claro' : 'oscuro');
  bindToolbar();
  bindSettingsForm();
  updateStatus();

  await newTab(els.shellSelect.value);

  if (info.uacDenied) {
    toast(
      'Se cancelo el aviso de UAC: la terminal se abrio SIN privilegios de administrador.',
      'error',
      { label: 'Reintentar como admin', run: () => api.relaunchElevated() }
    );
  }
  window.__adminTermReady = true;
}

// Superficie usada por `npm run selftest` para ejercer la UI sin raton.
window.__adminTerm = {
  tabs,
  newTab,
  destroyTab,
  patchSettings,
  insertPaths,
  openSettings,
  closeSettings,
  setFontSize,
  get settings() { return settings; },
  get activeTab() { return activeTab; },
  get fonts() { return availableFonts; },
};

window.addEventListener('error', (e) => {
  console.error('[adminterm] error no capturado:', e.error || e.message);
});

boot().catch((err) => {
  console.error('[adminterm] fallo el arranque:', err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div style="padding:20px;color:#ff6b6b;font-family:monospace">Fallo el arranque: ${String(err && err.message)}</div>`
  );
});
