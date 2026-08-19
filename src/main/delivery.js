'use strict';

const { clipboard } = require('electron');

/**
 * Deliver text into whatever window currently has focus.
 *
 * Text goes on the clipboard and a Ctrl+V is synthesised, rather than typing
 * character by character. Synthesised typing mangles Unicode and anything the
 * Windows key-event API treats as syntax; a paste moves the whole string
 * verbatim in one keystroke.
 *
 * The keystroke itself is sent by the hook process rather than from here.
 * Ctrl is part of the default shortcut, so a paste fired from this process
 * used to land back in the hotkey state machine through the app's own hook
 * and corrupt it. `sendPaste` asks the process that owns the hook to do it,
 * which is the only place that can tell its own keystrokes apart from yours.
 *
 * The previous clipboard contents are restored afterwards, so dictating does
 * not quietly destroy whatever the user had copied.
 */
async function pasteIntoFocusedApp(text, sendPaste) {
  const previous = clipboard.readText();
  clipboard.writeText(text);

  // Let the target window observe the new clipboard contents before the
  // paste arrives.
  await new Promise((r) => setTimeout(r, 90));

  const res = await sendPaste();
  if (!res.ok) {
    // Deliberately leaves the text on the clipboard: the user is being told
    // it is there, so taking it away again would make that a lie.
    return {
      ok: false,
      mode: 'copied',
      error: `Could not send the paste keystroke (${res.error}). The text is on your clipboard.`,
    };
  }

  // Restore only if nothing else claimed the clipboard in the meantime.
  //
  // The dictated text must come off the clipboard either way. Leaving it
  // there exposes it to every process on the machine, and to Windows
  // Clipboard History, which syncs to the user's Microsoft account when that
  // is switched on — so an empty prior clipboard means clear, not skip.
  setTimeout(() => {
    if (clipboard.readText() !== text) return;
    if (previous) clipboard.writeText(previous);
    else clipboard.clear();
  }, 700);

  return { ok: true, mode: 'pasted' };
}

function copyToClipboard(text) {
  clipboard.writeText(text);
  return { ok: true, mode: 'copied' };
}

module.exports = { pasteIntoFocusedApp, copyToClipboard };
