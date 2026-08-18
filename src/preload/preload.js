'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Explicit surface only — the renderer never sees ipcRenderer itself. */
contextBridge.exposeInMainWorld('murmur', {
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // history
  getHistory: () => ipcRenderer.invoke('history:get'),
  deleteEntry: (id) => ipcRenderer.invoke('history:delete', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  copyText: (text) => ipcRenderer.invoke('history:copy', text),

  // recording
  toggleRecording: () => ipcRenderer.invoke('record:toggle'),
  getState: () => ipcRenderer.invoke('state:get'),

  // diagnostics
  diagnostics: () => ipcRenderer.invoke('diagnostics'),
  openDataDir: () => ipcRenderer.invoke('open:dataDir'),

  // capture (HUD window only)
  sendResult: (payload) => ipcRenderer.send('capture:result', payload),
  sendError: (message) => ipcRenderer.send('capture:error', { message }),
  sendLevel: (level) => ipcRenderer.send('capture:level', level),

  // events
  on: (channel, handler) => {
    const allowed = ['state', 'level', 'navigate', 'toast', 'history:changed', 'capture:start', 'capture:stop', 'lock'];
    if (!allowed.includes(channel)) return () => {};
    const wrapped = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
