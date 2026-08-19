'use strict';

/**
 * Display names for the shortcut combos.
 *
 * Kept free of any native dependency so the main process can name a combo
 * without loading uiohook-napi — the hook lives in its own process now, and
 * this is the only part of it main still needs.
 */
const COMBO_NAMES = {
  'ctrl+win': 'Ctrl + Win',
  'ctrl+shift': 'Ctrl + Shift',
  'alt+win': 'Alt + Win',
  'win': 'Win',
};

const DEFAULT_COMBO = 'ctrl+win';

function comboName(id) {
  return COMBO_NAMES[id] || COMBO_NAMES[DEFAULT_COMBO];
}

module.exports = { COMBO_NAMES, DEFAULT_COMBO, comboName };
