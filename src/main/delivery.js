'use strict';

const { clipboard } = require('electron');
const { uIOhook, UiohookKey } = require('uiohook-napi');

/**
 * Deliver text into whatever window currently has focus.
 *
 * Text goes on the clipboard and a Ctrl+V is synthesised, rather than typing
 * character by character. Synthesised typing mangles Unicode and anything the
 * Windows key-event API treats as syntax; a paste moves the whole string
 * verbatim in one keystroke.
 *
 * The keystroke is sent through the same low-level hook used for the hotkeys.
 * The previous approach spawned PowerShell to call SendKeys, which cost
 * several hundred milliseconds of process startup and could disturb focus at
 * exactly the moment focus mattered.
 *
 * The previous clipboard contents are restored afterwards, so dictating does
 * not quietly destroy whatever the user had copied.
 */
async function pasteIntoFocusedApp(text) {
  const previous = clipboard.readText();
  clipboard.writeText(text);

  // Let the target window observe the new clipboard contents before the
  // paste arrives.
  await new Promise((r) => setTimeout(r, 90));

  try {
    uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl]);
  } catch (err) {
    return {
      ok: false,
      mode: 'copied',
      error: `Could not send the paste keystroke (${err.message}). The text is on your clipboard.`,
    };
  }

  // Restore only if nothing else claimed the clipboard in the meantime.
  setTimeout(() => {
    if (clipboard.readText() === text && previous) clipboard.writeText(previous);
  }, 700);

  return { ok: true, mode: 'pasted' };
}

function copyToClipboard(text) {
  clipboard.writeText(text);
  return { ok: true, mode: 'copied' };
}

module.exports = { pasteIntoFocusedApp, copyToClipboard };
