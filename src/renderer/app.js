'use strict';

const api = window.yapanese;

const el = (id) => document.getElementById(id);
const entriesEl = el('entries');
const searchEl = el('search');
const statusEl = el('status');
const statusText = el('status-text');
const recordBtn = el('record-btn');
const recordLabel = el('record-label');

let entries = [];
let settings = {};
let query = '';

// ------------------------------------------------------------------ utils

const ICONS = {
  copy: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13"/></svg>',
  check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>',
  warn:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8.5v5"/><circle cx="12" cy="16.8" r=".9" fill="currentColor" stroke="none"/><path d="M10.3 3.9L2.6 17.2A1.9 1.9 0 0 0 4.3 20h15.4a1.9 1.9 0 0 0 1.7-2.8L13.7 3.9a1.9 1.9 0 0 0-3.4 0z"/></svg>',
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function highlight(text, q) {
  const safe = escapeHtml(text);
  if (!q) return safe;
  const rx = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return safe.replace(rx, '<mark>$1</mark>');
}

function formatTime(iso) {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} · ${time}`;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function toast(kind, message) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.kind = kind;
  node.innerHTML = `${kind === 'good' ? ICONS.check : ICONS.warn}<div>${escapeHtml(message)}</div>`;
  el('toasts').appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity 200ms, transform 200ms';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 220);
  }, kind === 'error' ? 6000 : 3600);
}

// ---------------------------------------------------------------- history

function renderHistory() {
  const q = query.trim().toLowerCase();
  const list = q ? entries.filter((e) => (e.text || '').toLowerCase().includes(q)) : entries;

  el('entry-count').textContent =
    entries.length === 0 ? '' : q ? `${list.length} of ${entries.length}` : `${entries.length}`;

  if (list.length === 0) {
    entriesEl.innerHTML = entries.length === 0
      ? `<div class="empty">
           <span class="glyph"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4"/></svg></span>
           <h3>Say something</h3>
           <p>Hold <kbd>${escapeHtml(COMBO_NAMES[settings.combo] || 'Ctrl + Win')}</kbd> anywhere in Windows and talk. What you say lands here, and in whatever app you were using.</p>
         </div>`
      : `<div class="empty">
           <h3>No matches</h3>
           <p>Nothing in your history contains &ldquo;${escapeHtml(query)}&rdquo;.</p>
         </div>`;
    return;
  }

  entriesEl.innerHTML = list.map((e) => {
    // An entry that holds audio but no text yet: a recording interrupted by a
    // crash, or one whose transcription failed. It sits in the list like
    // anything else so nothing that was said is invisible.
    const pending = e.state === 'unfinished';
    const lost = e.state === 'lost';

    return `
    <article class="entry${pending ? ' entry-pending' : ''}" data-id="${e.id}">
      <div class="entry-meta">
        <span>${formatTime(e.startedAt)}</span>
        <span>${formatDuration(e.durationMs)}</span>
        ${pending ? `<span class="tag tag-pending">${ICONS.warn} Not transcribed</span>`
          : lost ? `<span class="tag tag-pending">${ICONS.warn} Audio missing</span>`
          : e.delivered === 'pasted' ? `<span class="tag">${ICONS.check} Pasted</span>`
          : e.delivered === 'copied' ? `<span class="tag">${ICONS.check} Copied</span>`
          : ''}
      </div>
      <div class="entry-body">${
        pending ? '<span class="pending-note">This recording was interrupted before it could be transcribed. The audio is safe — transcribe it to get the text.</span>'
        : lost ? '<span class="pending-note">The audio for this recording is no longer on disk.</span>'
        : highlight(e.text || '', query.trim())
      }</div>
      <div class="entry-actions">
        ${pending
          ? `<button class="btn btn-primary" data-act="transcribe">Transcribe</button>`
          : lost ? ''
          : `<button class="btn btn-ghost" data-act="copy">${ICONS.copy} Copy</button>`}
        <button class="btn btn-ghost btn-danger" data-act="delete">${ICONS.trash} Delete</button>
      </div>
    </article>`;
  }).join('');
}

entriesEl.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.entry').dataset.id;
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;

  if (btn.dataset.act === 'copy') {
    await api.copyText(entry.text);
    toast('good', 'Copied to clipboard.');
    return;
  }

  if (btn.dataset.act === 'transcribe') {
    // Can take minutes on a long recording, so the button says so rather
    // than looking like nothing happened.
    btn.disabled = true;
    btn.textContent = 'Transcribing…';
    const res = await api.transcribeEntry(id);
    if (res.history) entries = res.history;
    renderHistory();
    if (res.ok) toast('good', 'Transcribed and saved to your history.');
    else toast('error', res.error || 'Could not transcribe that recording.');
    return;
  }

  entries = await api.deleteEntry(id);
  renderHistory();
});

searchEl.addEventListener('input', () => { query = searchEl.value; renderHistory(); });

// --------------------------------------------------------------- settings

async function loadDevices() {
  const select = el('mic');
  let devices = [];
  try {
    // Labels require permission; a silent getUserMedia grants it once.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    devices = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  } catch {
    select.innerHTML = '<option>Microphone access blocked</option>';
    select.disabled = true;
    return;
  }

  select.innerHTML = devices
    .map((d) => `<option value="${escapeHtml(d.label)}">${escapeHtml(d.label || 'Unnamed device')}</option>`)
    .join('');
  if (settings.micDevice) select.value = settings.micDevice;
}

const COMBO_NAMES = {
  'ctrl+win': 'Ctrl + Win',
  'alt+win': 'Alt + Win',
  'ctrl+shift': 'Ctrl + Shift',
  win: 'Win',
};

function renderSettings() {
  el('speed').value = settings.speed || 'balanced';
  el('combo').value = settings.combo || 'ctrl+win';
  el('vad').checked = settings.vad !== false;
  el('autopaste').checked = !!settings.autoPaste;
  el('autostart').checked = !!settings.launchAtLogin;

  const name = COMBO_NAMES[settings.combo] || 'Ctrl + Win';
  el('g-hold').textContent = `Hold ${name}`;
  el('g-double').textContent = `Double tap ${name}`;
  el('g-single').textContent = `Tap ${name}`;
}

async function renderDiagnostics() {
  const d = await api.diagnostics();
  el('datadir-path').textContent = d.dataDir;
  el('diag').innerHTML = `
    <div><span>yap</span><code class="${d.yap ? '' : 'missing'}">${d.yap ? escapeHtml(d.yap) : 'not found — transcription will fail'}</code></div>
    <div><span>ffmpeg</span><code class="${d.ffmpeg ? '' : 'missing'}">${d.ffmpeg ? escapeHtml(d.ffmpeg) : 'not found'}</code></div>
    <div><span>Shortcut</span><code class="${d.hotkeyRegistered ? '' : 'missing'}">${d.hotkeyRegistered ? 'registered' : 'not registered — may be taken by another app'}</code></div>
    <div><span>Version</span><code>${escapeHtml(d.version)} · Electron ${escapeHtml(d.electron)}</code></div>
  `;
}

el('speed').addEventListener('change', async (e) => {
  settings = await api.setSettings({ speed: e.target.value });
});
el('combo').addEventListener('change', async (e) => {
  settings = await api.setSettings({ combo: e.target.value });
  renderSettings();
});
el('mic').addEventListener('change', async (e) => {
  settings = await api.setSettings({ micDevice: e.target.value });
});
el('vad').addEventListener('change', async (e) => {
  settings = await api.setSettings({ vad: e.target.checked });
});
el('autopaste').addEventListener('change', async (e) => {
  settings = await api.setSettings({ autoPaste: e.target.checked });
});
el('autostart').addEventListener('change', async (e) => {
  settings = await api.setSettings({ launchAtLogin: e.target.checked });
});
el('open-data').addEventListener('click', () => api.openDataDir());
el('clear-history').addEventListener('click', async () => {
  entries = await api.clearHistory();
  renderHistory();
  toast('good', 'History cleared.');
});

// ------------------------------------------------------------------ state

function applyState({ state, error, elapsedMs }) {
  if (elapsedMs) {
    const secs = (elapsedMs / 1000).toFixed(1);
    const note = el('last-timing');
    if (note) note.textContent = `${secs}s to transcribe.`;
  }
  statusEl.dataset.state = state;
  statusText.textContent =
    state === 'recording' ? 'Recording' :
    state === 'transcribing' ? 'Transcribing' :
    error ? 'Ready' : 'Ready';

  recordLabel.textContent = state === 'recording' ? 'Stop' : state === 'transcribing' ? 'Working…' : 'Record';
  recordBtn.classList.toggle('btn-live', state === 'recording');
  recordBtn.classList.toggle('btn-primary', state !== 'recording');
  recordBtn.disabled = state === 'transcribing';
}

recordBtn.addEventListener('click', () => api.toggleRecording());

// ------------------------------------------------------------------- nav

document.querySelectorAll('.nav button').forEach((b) => {
  b.addEventListener('click', () => showView(b.dataset.view));
});

function showView(name) {
  document.querySelectorAll('.nav button').forEach((b) =>
    b.setAttribute('aria-current', String(b.dataset.view === name)));
  document.querySelectorAll('.view').forEach((v) =>
    v.classList.toggle('on', v.id === `view-${name}`));
  if (name === 'settings') renderDiagnostics();
}

// ------------------------------------------------------------------- boot

api.on('state', applyState);
api.on('navigate', showView);
api.on('toast', ({ kind, message }) => toast(kind, message));
api.on('history:changed', async () => { entries = await api.getHistory(); renderHistory(); });

/**
 * A recording recovered from an interrupted session. The notice leads
 * somewhere — the list scrolls to the entry and marks it — rather than being
 * a message the user has to go looking for afterwards.
 */
api.on('recovered', async ({ ids, message }) => {
  entries = await api.getHistory();
  showView('history');
  renderHistory();
  toast('good', message);

  const node = ids?.[0] && entriesEl.querySelector(`.entry[data-id="${ids[0]}"]`);
  if (!node) return;
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.classList.add('found');
  setTimeout(() => node.classList.remove('found'), 2600);
});

(async function boot() {
  settings = await api.getSettings();
  entries = await api.getHistory();
  renderSettings();
  renderHistory();
  await loadDevices();
  applyState({ state: await api.getState() });
})();
