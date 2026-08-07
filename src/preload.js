'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listeners = { data: new Set(), exit: new Set() };

ipcRenderer.on('pty:data', (_e, payload) => {
  for (const fn of listeners.data) fn(payload);
});
ipcRenderer.on('pty:exit', (_e, payload) => {
  for (const fn of listeners.exit) fn(payload);
});

contextBridge.exposeInMainWorld('adminterm', {
  // --- info y ajustes ---
  info: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  // --- terminal ---
  ptyCreate: (opts) => ipcRenderer.invoke('pty:create', opts),
  ptyInput: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.send('pty:kill', { id }),
  onPtyData: (fn) => {
    listeners.data.add(fn);
    return () => listeners.data.delete(fn);
  },
  onPtyExit: (fn) => {
    listeners.exit.add(fn);
    return () => listeners.exit.delete(fn);
  },

  // --- archivos ---
  pickFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  pickFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  // Electron >= 32 ya no expone File.path; esta es la via oficial.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  // --- microfono / dictado ---
  transcribe: (bytes, mimeType, filename) =>
    ipcRenderer.invoke('stt:transcribe', { bytes, mimeType, filename }),
  windowsDictation: () => ipcRenderer.invoke('sys:winH'),

  // --- sistema ---
  relaunchElevated: () => ipcRenderer.invoke('sys:relaunchElevated'),
  applyHotkey: () => ipcRenderer.invoke('sys:applyHotkey'),
  openExternal: (url) => ipcRenderer.invoke('sys:openExternal', url),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
});
