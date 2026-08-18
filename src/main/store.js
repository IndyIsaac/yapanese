'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// Settings and history live beside each other in the per-user data dir.
// Both are plain JSON so the user can read, back up, or delete them without
// this app being involved.
const dir = () => app.getPath('userData');
const settingsFile = () => path.join(dir(), 'settings.json');
const historyFile = () => path.join(dir(), 'history.json');

const DEFAULT_SETTINGS = {
  micDevice: null,            // null = first device ffmpeg reports
  combo: 'ctrl+win',          // see hotkeys.js COMBOS
  autoPaste: true,
  launchAtLogin: false,
  speed: 'balanced',          // 'accurate' | 'balanced' | 'fast'
  vad: true,                  // discard non-speech before transcribing
  language: 'en',
  threads: 0,                 // 0 = derive from CPU count
  model: '',                  // '' = the preset's model
  whisperPath: '',            // '' = resolve from PATH / LOCALAPPDATA
  yapPath: '',
  ffmpegPath: '',
};

/** JSON.parse throws on a leading byte-order mark, which Windows tools such
 *  as PowerShell's Set-Content happily write. Strip it before parsing so an
 *  externally edited settings file does not silently revert to defaults. */
function parseJSON(text) {
  return JSON.parse(text.replace(/^﻿/, ''));
}

function readJSON(file, fallback) {
  try {
    return { ...fallback, ...parseJSON(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { ...fallback };
  }
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write to a sibling then rename, so a crash mid-write cannot truncate the
  // file and lose a user's entire history.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

let settings = null;
let history = null;

const store = {
  settings() {
    if (!settings) settings = readJSON(settingsFile(), DEFAULT_SETTINGS);
    return settings;
  },

  updateSettings(patch) {
    settings = { ...store.settings(), ...patch };
    writeJSON(settingsFile(), settings);
    return settings;
  },

  history() {
    if (!history) {
      try {
        history = parseJSON(fs.readFileSync(historyFile(), 'utf8'));
        if (!Array.isArray(history)) history = [];
      } catch {
        history = [];
      }
    }
    return history;
  },

  /** Entries are written before delivery is attempted, so a failed paste
   *  is only an inconvenience and never a lost transcript. */
  addEntry(entry) {
    const list = store.history();
    list.unshift(entry);
    writeJSON(historyFile(), list);
    return entry;
  },

  updateEntry(id, patch) {
    const list = store.history();
    const i = list.findIndex((e) => e.id === id);
    if (i === -1) return null;
    list[i] = { ...list[i], ...patch };
    writeJSON(historyFile(), list);
    return list[i];
  },

  deleteEntry(id) {
    history = store.history().filter((e) => e.id !== id);
    writeJSON(historyFile(), history);
  },

  clearHistory() {
    history = [];
    writeJSON(historyFile(), history);
  },

  dataDir: dir,
};

module.exports = { store, DEFAULT_SETTINGS };
