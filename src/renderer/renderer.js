'use strict';

const api = window.adminterm;

// ---------------------------------------------------------------------------
// Temas del terminal (pensados para leer texto durante horas)
// ---------------------------------------------------------------------------

const THEMES = {
  oscuro: {
    background: '#0b0e14', foreground: '#e6edf3',
    cursor: '#39ff14', cursorAccent: '#0b0e14',
    selectionBackground: '#33415e', selectionForeground: '#ffffff',
    black: '#3d4451', red: '#ff6b6b', green: '#7ee787', yellow: '#ffd580',
    blue: '#73b8ff', magenta: '#d2a8ff', cyan: '#5ccfe6', white: '#e6edf3',
    brightBlack: '#7b8797', brightRed: '#ff9292', brightGreen: '#9ff3a8', brightYellow: '#ffe3a3',
    brightBlue: '#9ecbff', brightMagenta: '#e2c5ff', brightCyan: '#8ce6f4', brightWhite: '#ffffff',
  },
  'oscuro-suave': {
    background: '#1b1f27', foreground: '#dfe5ec',
    cursor: '#39ff14', cursorAccent: '#1b1f27',
    selectionBackground: '#3a4557', selectionForeground: '#ffffff',
    black: '#4a5262', red: '#ff7b7b', green: '#8ce99a', yellow: '#ffd88a',
    blue: '#82c0ff', magenta: '#d7b0ff', cyan: '#6fd7ea', white: '#dfe5ec',
    brightBlack: '#8792a3', brightRed: '#ff9d9d', brightGreen: '#a6f2b1', brightYellow: '#ffe7ae',
    brightBlue: '#a6d4ff', brightMagenta: '#e6ccff', brightCyan: '#96e6f2', brightWhite: '#ffffff',
  },
  claro: {
    background: '#ffffff', foreground: '#1c1f24',
    cursor: '#0f8a2e', cursorAccent: '#ffffff',
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

const STT_PRESETS = {
  openai: { endpoint: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1' },
  'openai-4o': { endpoint: 'https://api.openai.com/v1/audio/transcriptions', model: 'gpt-4o-mini-transcribe' },
  groq: { endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo' },
  local: { endpoint: 'http://127.0.0.1:8000/v1/audio/transcriptions', model: 'whisper-1' },
};

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
let sessionSaveTimer = null;
let lastPaneError = '';

const $ = (id) => document.getElementById(id);
const els = {
  tabs: $('tabs'), terminals: $('terminals'), shellSelect: $('shell-select'),
  fontLabel: $('font-size-label'), statusPriv: $('status-priv'), statusShell: $('status-shell'),
  statusMsg: $('status-msg'), statusMic: $('status-mic'), statusVersions: $('status-versions'),
  dropOverlay: $('drop-overlay'), micOverlay: $('mic-overlay'), micTimer: $('mic-timer'),
  btnMic: $('btn-mic'), modal: $('settings-modal'), toast: $('toast'),
  searchBar: $('search-bar'), searchInput: $('search-input'),
};

/** El panel que recibe teclado, archivos y dictado. */
const activePane = () => (activeTab ? activeTab.activePane : null);
const allPanes = () => tabs.flatMap((t) => t.panes);
const paneById = (id) => allPanes().find((p) => p.id === id);

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

function flashStatus(text, ms = 1400) {
  els.statusMsg.textContent = text;
  setTimeout(() => {
    if (els.statusMsg.textContent === text) els.statusMsg.textContent = '';
  }, ms);
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

/**
 * ConPTY anuncia como titulo la ruta completa del ejecutable de la shell, que
 * no dice nada util. En ese caso conservamos el nombre amigable; cuando una
 * CLI pone un titulo de verdad (Claude, Codex, vim...) lo mostramos.
 */
function prettyTitle(raw, fallback) {
  const title = String(raw || '').trim();
  if (!title) return fallback;
  if (/[\\/]/.test(title) && /\.exe$/i.test(title)) return fallback;
  return title.length > 40 ? title.slice(0, 39) + '…' : title;
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
    title.textContent = tab.panes.length > 1 ? `${tab.title} (${tab.panes.length})` : tab.title;
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

  const pane = activePane();
  const shellKey = pane ? pane.shellKey : settings.shell;
  const shellLabel = (info.shells.find((s) => s.key === shellKey) || {}).label || '';
  const size = pane ? `  ·  ${pane.term.cols}x${pane.term.rows}` : '';
  const panes = activeTab && activeTab.panes.length > 1
    ? `  ·  panel ${activeTab.panes.indexOf(pane) + 1}/${activeTab.panes.length}`
    : '';
  els.statusShell.textContent = shellLabel + size + panes;
  els.fontLabel.textContent = String(settings.fontSize);
  els.statusVersions.textContent = `AdminTerm ${info.version}  ·  Electron ${info.electron}`;
}

function fitPane(pane) {
  if (!pane || pane.el.offsetParent === null) return;
  try {
    pane.fit.fit();
    api.ptyResize(pane.id, pane.term.cols, pane.term.rows);
  } catch {
    /* el panel aun no tiene tamano */
  }
}

function fitTab(tab) {
  if (!tab) return;
  for (const pane of tab.panes) fitPane(pane);
  updateStatus();
}

// --- disposicion de paneles -------------------------------------------------

/** Reconstruye la fila/columna de paneles intercalando los divisores. */
function layoutTab(tab) {
  tab.view.textContent = '';
  tab.view.className = `tab-view dir-${tab.direction}` +
    (tab === activeTab ? ' active' : '') +
    (tab.panes.length > 1 ? ' split' : '');

  tab.panes.forEach((pane, i) => {
    if (i > 0) tab.view.appendChild(createDivider(tab, i - 1));
    pane.el.style.flexGrow = String(pane.flex);
    tab.view.appendChild(pane.el);
  });
  updatePaneFocusRing(tab);
}

function createDivider(tab, index) {
  const divider = document.createElement('div');
  divider.className = 'pane-divider';
  divider.addEventListener('mousedown', (e) => startDividerDrag(tab, index, divider, e));
  return divider;
}

function startDividerDrag(tab, index, divider, event) {
  event.preventDefault();
  const horizontal = tab.direction === 'row';
  const a = tab.panes[index];
  const b = tab.panes[index + 1];
  if (!a || !b) return;

  const rect = tab.view.getBoundingClientRect();
  const size = horizontal ? rect.width : rect.height;
  const total = tab.panes.reduce((sum, p) => sum + p.flex, 0);
  const start = horizontal ? event.clientX : event.clientY;
  const aStart = a.flex;
  const bStart = b.flex;
  const min = total * 0.12;

  divider.classList.add('dragging');
  document.body.classList.add('resizing-panes');

  const onMove = (e) => {
    const deltaPx = (horizontal ? e.clientX : e.clientY) - start;
    const delta = (deltaPx / size) * total;
    let na = aStart + delta;
    let nb = bStart - delta;
    if (na < min) { nb -= min - na; na = min; }
    if (nb < min) { na -= min - nb; nb = min; }
    a.flex = na;
    b.flex = nb;
    a.el.style.flexGrow = String(na);
    b.el.style.flexGrow = String(nb);
  };

  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    divider.classList.remove('dragging');
    document.body.classList.remove('resizing-panes');
    scheduleSessionSave();
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function updatePaneFocusRing(tab) {
  for (const pane of tab.panes) {
    pane.el.classList.toggle('focused', pane === tab.activePane);
  }
}

// --- creacion y destruccion -------------------------------------------------

function createTab() {
  const view = document.createElement('div');
  view.className = 'tab-view dir-row';
  els.terminals.appendChild(view);

  return {
    view,
    panes: [],
    direction: 'row',
    activePane: null,
    // Atajos para hablar de la pestana como si fuese su panel activo.
    get term() { return this.activePane ? this.activePane.term : null; },
    get id() { return this.activePane ? this.activePane.id : null; },
    get title() { return this.activePane ? this.activePane.title : ''; },
    get dead() { return this.panes.length > 0 && this.panes.every((p) => p.dead); },
  };
}

async function createPane(tab, shellKey) {
  const el = document.createElement('div');
  el.className = 'term-pane';
  // Debe estar en el DOM y visible antes de medir, o fit() da 80x24.
  tab.view.appendChild(el);

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

  term.open(el);

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
    el.remove();
    term.dispose();
    lastPaneError = res && res.error ? res.error : 'respuesta vacia de pty:create';
    toast(`No se pudo abrir la terminal: ${lastPaneError}`, 'error');
    return null;
  }

  const pane = {
    id: res.id, term, fit, search, el, tab,
    shellKey: res.shellKey, title: res.label, dead: false, flex: 1,
  };
  tab.panes.push(pane);

  term.onData((data) => api.ptyInput(pane.id, data));
  term.onTitleChange((t) => {
    const next = prettyTitle(t, res.label);
    if (next !== pane.title) {
      pane.title = next;
      renderTabs();
    }
  });
  term.attachCustomKeyEventHandler((e) => !(e.type === 'keydown' && isAppShortcut(e)));

  el.addEventListener('focusin', () => focusPane(pane));
  el.addEventListener('mousedown', () => focusPane(pane));

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    focusPane(pane);
    const selection = term.getSelection();
    if (selection) {
      api.writeClipboard(selection);
      term.clearSelection();
      flashStatus('Copiado');
    } else {
      pasteIntoPane(pane);
    }
  });

  pane.observer = new ResizeObserver(() => {
    clearTimeout(pane.resizeTimer);
    pane.resizeTimer = setTimeout(() => {
      fitPane(pane);
      if (pane === activePane()) updateStatus();
    }, 40);
  });
  pane.observer.observe(el);

  return pane;
}

async function newTab(shellKey) {
  const tab = createTab();
  tabs.push(tab);
  const pane = await createPane(tab, shellKey);
  if (!pane) {
    tab.view.remove();
    tabs.splice(tabs.indexOf(tab), 1);
    renderTabs();
    return null;
  }
  tab.activePane = pane;
  activateTab(tab);
  scheduleSessionSave();
  return tab;
}

/** Divide el panel activo. `direction`: 'row' = derecha, 'column' = abajo. */
async function splitActive(direction) {
  if (!activeTab) return null;

  if (activeTab.panes.length > 1 && activeTab.direction !== direction) {
    toast(
      `Esta pestana ya esta dividida en ${activeTab.direction === 'row' ? 'columnas' : 'filas'}. ` +
        'Los paneles anidados no estan soportados: usa una pestana nueva.',
      'error'
    );
    return null;
  }
  if (activeTab.panes.length >= 4) {
    toast('Maximo 4 paneles por pestana.', 'error');
    return null;
  }

  activeTab.direction = direction;
  const pane = await createPane(activeTab, settings.shell);
  if (!pane) return null;

  activeTab.activePane = pane;
  layoutTab(activeTab);
  requestAnimationFrame(() => {
    fitTab(activeTab);
    pane.term.focus();
  });
  renderTabs();
  scheduleSessionSave();
  return pane;
}

function focusPane(pane) {
  if (!pane || pane.tab.activePane === pane) return;
  pane.tab.activePane = pane;
  updatePaneFocusRing(pane.tab);
  updateStatus();
}

/** Mueve el foco al panel contiguo en la direccion dada. */
function movePaneFocus(key) {
  if (!activeTab || activeTab.panes.length < 2) return;
  const forward =
    (activeTab.direction === 'row' && key === 'arrowright') ||
    (activeTab.direction === 'column' && key === 'arrowdown');
  const backward =
    (activeTab.direction === 'row' && key === 'arrowleft') ||
    (activeTab.direction === 'column' && key === 'arrowup');
  if (!forward && !backward) return;

  const i = activeTab.panes.indexOf(activeTab.activePane);
  const next = activeTab.panes[i + (forward ? 1 : -1)];
  if (!next) return;
  focusPane(next);
  next.term.focus();
}

function activateTab(tab) {
  activeTab = tab;
  for (const t of tabs) {
    t.view.classList.toggle('active', t === tab);
  }
  layoutTab(tab);
  renderTabs();
  requestAnimationFrame(() => {
    fitTab(tab);
    if (tab.activePane) tab.activePane.term.focus();
  });
}

/** Cierra el panel activo; si es el ultimo, cierra la pestana. */
function closeActivePane() {
  const pane = activePane();
  if (!pane) return;
  if (activeTab.panes.length === 1) return closeTab(activeTab);
  if (!confirmClose(pane, () => destroyPane(pane))) return;
  destroyPane(pane);
}

function confirmClose(target, run) {
  if (!settings.confirmClose || target.dead) return true;
  if (target.pendingClose) return true;
  target.pendingClose = true;
  setTimeout(() => (target.pendingClose = false), 3000);
  toast(`Repite la accion para cerrar "${target.title}" (la sesion sigue viva).`, '', {
    label: 'Cerrar ahora',
    run,
  });
  return false;
}

function destroyPane(pane) {
  const tab = pane.tab;
  api.ptyKill(pane.id);
  if (pane.observer) pane.observer.disconnect();
  pane.term.dispose();
  pane.el.remove();

  const i = tab.panes.indexOf(pane);
  tab.panes.splice(i, 1);
  if (tab.activePane === pane) tab.activePane = tab.panes[Math.min(i, tab.panes.length - 1)] || null;
  for (const p of tab.panes) p.flex = 1;

  layoutTab(tab);
  renderTabs();
  requestAnimationFrame(() => {
    fitTab(tab);
    if (tab.activePane) tab.activePane.term.focus();
  });
  scheduleSessionSave();
}

function closeTab(tab) {
  if (!confirmClose(tab, () => destroyTab(tab))) return;
  destroyTab(tab);
}

function destroyTab(tab) {
  for (const pane of [...tab.panes]) {
    api.ptyKill(pane.id);
    if (pane.observer) pane.observer.disconnect();
    pane.term.dispose();
  }
  tab.panes.length = 0;
  tab.view.remove();

  const i = tabs.indexOf(tab);
  if (i >= 0) tabs.splice(i, 1);

  if (activeTab === tab) {
    activeTab = null;
    if (tabs.length) activateTab(tabs[Math.min(i, tabs.length - 1)]);
    else newTab();
  } else {
    renderTabs();
  }
  scheduleSessionSave();
}

api.onPtyData(({ id, data }) => {
  const pane = paneById(id);
  if (pane) pane.term.write(data);
});

api.onPtyExit(({ id, exitCode }) => {
  const pane = paneById(id);
  if (!pane) return;
  pane.dead = true;
  pane.term.write(
    `\r\n\x1b[38;5;244m[proceso finalizado - codigo ${exitCode}. Ctrl+Shift+W para cerrar el panel]\x1b[0m\r\n`
  );
  renderTabs();
});

// ---------------------------------------------------------------------------
// Sesion (que pestanas y paneles reabrir)
// ---------------------------------------------------------------------------

function layoutSnapshot() {
  return {
    activeIndex: Math.max(0, tabs.indexOf(activeTab)),
    tabs: tabs.map((tab) => ({
      direction: tab.direction,
      panes: tab.panes.map((p) => ({ shellKey: p.shellKey, flex: Number(p.flex.toFixed(3)) })),
    })),
  };
}

function scheduleSessionSave() {
  if (info && info.selftest) return;
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(async () => {
    // No pasa por patchSettings: guardar la disposicion no debe repintar nada.
    settings = await api.setSettings({ session: layoutSnapshot() });
  }, 600);
}

async function restoreSession(saved) {
  let restored = 0;
  for (const spec of saved.tabs) {
    const tab = createTab();
    tab.direction = spec.direction === 'column' ? 'column' : 'row';
    tabs.push(tab);

    for (const paneSpec of spec.panes) {
      const known = info.shells.some((s) => s.key === paneSpec.shellKey);
      const pane = await createPane(tab, known ? paneSpec.shellKey : settings.shell);
      if (pane) pane.flex = Number(paneSpec.flex) > 0 ? Number(paneSpec.flex) : 1;
    }

    if (!tab.panes.length) {
      tab.view.remove();
      tabs.splice(tabs.indexOf(tab), 1);
      continue;
    }
    tab.activePane = tab.panes[0];
    restored++;
  }
  if (!restored) return false;
  activateTab(tabs[Math.min(saved.activeIndex || 0, tabs.length - 1)]);
  return true;
}

// ---------------------------------------------------------------------------
// Portapapeles y archivos
// ---------------------------------------------------------------------------

async function pasteIntoPane(pane) {
  const text = await api.readClipboard();
  if (!text) return;
  api.ptyInput(pane.id, text.replace(/\r\n/g, '\r').replace(/\n/g, '\r'));
}

function insertPaths(paths) {
  const pane = activePane();
  if (!pane || !paths.length) return;
  api.ptyInput(pane.id, paths.map(quotePath).join(' ') + ' ');
  pane.term.focus();
  toast(`${paths.length} ruta(s) insertada(s).`, 'ok');
}

async function pickFiles() {
  insertPaths(await api.pickFiles());
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

function sttNeedsKey() {
  return !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(settings.stt.endpoint || '');
}

async function startMic() {
  if (mic.recorder) return;
  if (!settings.stt.apiKey && sttNeedsKey()) {
    toast('Configura una API key de transcripcion en Ajustes para dictar.', 'error', {
      label: 'Abrir ajustes',
      run: openSettings,
    });
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
    if (res.code === 'NO_KEY') toast(res.error, 'error', { label: 'Abrir ajustes', run: openSettings });
    else toast(`Transcripcion fallida. ${res.error}`, 'error');
    return;
  }
  if (!res.text) {
    toast('No se detecto voz en la grabacion.', 'error');
    return;
  }
  const pane = activePane();
  if (!pane) return;
  api.ptyInput(pane.id, res.text + (settings.stt.autoSend ? '\r' : ''));
  pane.term.focus();
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

/** WAV mono 16 kHz con un tono muy bajo: audio valido para probar el endpoint. */
function probeAudioWav(seconds = 1, rate = 16000) {
  const samples = seconds * rate;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);

  for (let i = 0; i < samples; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((i / rate) * 440 * 2 * Math.PI) * 600), true);
  }
  return new Uint8Array(buffer);
}

async function testTranscription() {
  const btn = $('btn-stt-test');
  const previous = btn.textContent;
  btn.textContent = 'Probando…';
  btn.disabled = true;
  try {
    const res = await api.transcribe(probeAudioWav(), 'audio/wav', 'prueba.wav');
    if (res.ok) toast('Conexion correcta: el endpoint respondio y acepto las credenciales.', 'ok');
    else if (res.code === 'NO_KEY') toast(res.error, 'error');
    else toast(`Fallo la prueba. ${res.error}`, 'error');
  } finally {
    btn.textContent = previous;
    btn.disabled = false;
  }
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
  const pane = activePane();
  if (pane) {
    pane.search.clearDecorations();
    pane.term.focus();
  }
}

function runSearch(back = false) {
  const pane = activePane();
  if (!pane || !els.searchInput.value) return;
  const opts = { decorations: { matchOverviewRuler: '#39ff14', activeMatchColorOverviewRuler: '#5ce68f' } };
  if (back) pane.search.findPrevious(els.searchInput.value, opts);
  else pane.search.findNext(els.searchInput.value, opts);
}

// ---------------------------------------------------------------------------
// Atajos
// ---------------------------------------------------------------------------

function isAppShortcut(e) {
  const k = e.key.toLowerCase();

  // Division de paneles y movimiento del foco: familia Alt.
  if (e.altKey && !e.ctrlKey) {
    if (e.shiftKey && ['+', '-', '=', '_'].includes(k)) return true;
    if (!e.shiftKey && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k)) return true;
    return false;
  }

  if (!e.ctrlKey || e.altKey) return false;
  if (e.shiftKey && ['t', 'w', 'c', 'v', 'f', 'm', 'o', 'tab'].includes(k)) return true;
  if (!e.shiftKey && (k === 'tab' || k === ',' || k === '+' || k === '-' || k === '=' || k === '0')) return true;
  if (!e.shiftKey && /^[1-9]$/.test(k)) return true;
  return false;
}

document.addEventListener('keydown', (e) => {
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

  if (e.altKey) {
    if (e.shiftKey) {
      if (k === '+' || k === '=') splitActive('row');
      if (k === '-' || k === '_') splitActive('column');
    } else {
      movePaneFocus(k);
    }
    return;
  }

  if (e.shiftKey) {
    switch (k) {
      case 't': newTab(); return;
      case 'w': closeActivePane(); return;
      case 'c': {
        const pane = activePane();
        if (pane && pane.term.hasSelection()) {
          api.writeClipboard(pane.term.getSelection());
          flashStatus('Copiado');
        }
        return;
      }
      case 'v': {
        const pane = activePane();
        if (pane) pasteIntoPane(pane);
        return;
      }
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
    const tab = tabs[Number(k) - 1];
    if (tab) activateTab(tab);
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
  for (const pane of allPanes()) {
    for (const [key, value] of Object.entries(opts)) {
      try {
        pane.term.options[key] = value;
      } catch (err) {
        console.warn(`opcion "${key}" no aplicada:`, err.message);
      }
    }
    fitPane(pane);
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
  const pane = activePane();
  if (pane) pane.term.focus();
}

function currentSttPreset() {
  for (const [name, preset] of Object.entries(STT_PRESETS)) {
    if (preset.endpoint === settings.stt.endpoint && preset.model === settings.stt.model) return name;
  }
  return 'custom';
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
  $('set-restoreSession').checked = !!settings.restoreSession;
  $('set-rememberWindow').checked = !!settings.rememberWindow;
  $('set-globalHotkeyEnabled').checked = !!settings.globalHotkeyEnabled;
  $('set-globalHotkey').value = settings.globalHotkey;
  $('set-stt-preset').value = currentSttPreset();
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
    'set-globalHotkey': ['globalHotkey', String],
  };
  for (const [id, [key, cast]] of Object.entries(simple)) {
    $(id).addEventListener('change', (e) => patchSettings({ [key]: cast(e.target.value) }));
  }

  const checks = {
    'set-cursorBlink': 'cursorBlink',
    'set-highContrast': 'highContrast',
    'set-autoElevate': 'autoElevate',
    'set-confirmClose': 'confirmClose',
    'set-restoreSession': 'restoreSession',
    'set-rememberWindow': 'rememberWindow',
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

  $('set-stt-preset').addEventListener('change', async (e) => {
    const preset = STT_PRESETS[e.target.value];
    if (!preset) return;
    await patchSettings({ stt: { endpoint: preset.endpoint, model: preset.model } });
    $('set-stt-endpoint').value = preset.endpoint;
    $('set-stt-model').value = preset.model;
  });

  $('btn-stt-test').addEventListener('click', (e) => {
    e.preventDefault();
    testTranscription();
  });

  $('set-globalHotkeyEnabled').addEventListener('change', async (e) => {
    await patchSettings({ globalHotkeyEnabled: e.target.checked });
    applyHotkey();
  });
  $('btn-hotkey-apply').addEventListener('click', async (e) => {
    e.preventDefault();
    await patchSettings({ globalHotkey: $('set-globalHotkey').value.trim() });
    applyHotkey();
  });

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

async function applyHotkey() {
  const res = await api.applyHotkey();
  if (res.error) toast(`Atajo global: ${res.error}`, 'error');
  else if (res.registered) toast(`Atajo global activo: ${settings.globalHotkey}`, 'ok');
  else if (settings.globalHotkeyEnabled) {
    toast(`Windows rechazo "${settings.globalHotkey}": ya lo usa otra aplicacion.`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

function bindToolbar() {
  $('btn-new-tab').addEventListener('click', () => newTab());
  $('btn-split-right').addEventListener('click', () => splitActive('row'));
  $('btn-split-down').addEventListener('click', () => splitActive('column'));
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
  els.shellSelect.value = info.shells.some((s) => s.key === settings.shell)
    ? settings.shell
    : info.shells[0].key;

  // El <title> del HTML pisa al de BrowserWindow, asi que el estado de
  // privilegios se marca aqui: se ve en la barra de tareas y en Alt+Tab.
  document.title = info.elevated ? 'AdminTerm — Administrador' : 'AdminTerm';

  document.documentElement.setAttribute('data-ui', settings.theme === 'claro' ? 'claro' : 'oscuro');
  bindToolbar();
  bindSettingsForm();
  updateStatus();

  const saved = settings.session;
  const canRestore =
    settings.restoreSession && !info.selftest && saved && Array.isArray(saved.tabs) && saved.tabs.length;
  if (!canRestore || !(await restoreSession(saved))) {
    await newTab(els.shellSelect.value);
  }

  if (settings.globalHotkeyEnabled) api.applyHotkey();

  if (info.uacDenied) {
    toast('Se cancelo el aviso de UAC: la terminal se abrio SIN privilegios de administrador.', 'error', {
      label: 'Reintentar como admin',
      run: () => api.relaunchElevated(),
    });
  }
  window.__adminTermReady = true;
}

// Superficie usada por `npm run selftest` para ejercer la UI sin raton.
window.__adminTerm = {
  tabs,
  newTab,
  splitActive,
  destroyTab,
  destroyPane,
  closeActivePane,
  movePaneFocus,
  patchSettings,
  insertPaths,
  openSettings,
  closeSettings,
  setFontSize,
  layoutSnapshot,
  restoreSession,
  probeAudioWav,
  get lastPaneError() { return lastPaneError; },
  get settings() { return settings; },
  get activeTab() { return activeTab; },
  get activePane() { return activePane(); },
  get panes() { return allPanes(); },
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
