'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Explicit surface only — the renderer never sees ipcRenderer itself. */
contextBridge.exposeInMainWorld('yapanese', {
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // history
  getHistory: () => ipcRenderer.invoke('history:get'),
  deleteEntry: (id) => ipcRenderer.invoke('history:delete', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  copyText: (text) => ipcRenderer.invoke('history:copy', text),
  transcribeEntry: (id) => ipcRenderer.invoke('history:transcribe', id),

  // recording
  toggleRecording: () => ipcRenderer.invoke('record:toggle'),
  getState: () => ipcRenderer.invoke('state:get'),

  // setup
  inspectSetup: () => ipcRenderer.invoke('setup:inspect'),
  runSetup: (choice) => ipcRenderer.invoke('setup:install', choice),
  cancelSetup: () => ipcRenderer.invoke('setup:cancel'),

  // updates
  getUpdate: () => ipcRenderer.invoke('update:get'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),

  // diagnostics
  diagnostics: () => ipcRenderer.invoke('diagnostics'),
  openDataDir: () => ipcRenderer.invoke('open:dataDir'),

  // hud chrome (HUD window only). The form is a name — 'rest' or 'active' —
  // and never a measurement: the window being resized to fit whatever the
  // renderer had drawn is what used to inflate it a pixel at a time on a
  // fractionally scaled display.
  hudForm: (form) => ipcRenderer.send('hud:form', form),
  hudDragStart: () => ipcRenderer.send('hud:drag-start'),
  hudDragEnd: () => ipcRenderer.send('hud:drag-end'),
  hudInteractive: (on) => ipcRenderer.send('hud:interactive', on),
  hudSettled: () => ipcRenderer.send('hud:settled'),
  hudOpen: () => ipcRenderer.send('hud:open'),

  // capture (HUD window only)
  sendChunk: (bytes) => ipcRenderer.send('capture:chunk', bytes),
  sendResult: (payload) => ipcRenderer.send('capture:result', payload),
  sendError: (message) => ipcRenderer.send('capture:error', { message }),
  sendLevel: (level) => ipcRenderer.send('capture:level', level),

  // events
  on: (channel, handler) => {
    const allowed = ['state', 'level', 'navigate', 'toast', 'history:changed', 'recovered', 'capture:start', 'capture:stop', 'lock', 'setup:progress', 'readiness', 'hud:linger', 'update:status'];
    if (!allowed.includes(channel)) return () => {};
    const wrapped = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
