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
           ${isReady
             ? `<h3>Say something</h3>
                <p>Hold <kbd>${escapeHtml(COMBO_NAMES[settings.combo] || 'Ctrl + Win')}</kbd> anywhere in Windows and talk. What you say lands here, and in whatever app you were using.</p>`
             : `<h3>Setup is not finished</h3>
                <p>Yapanese cannot transcribe yet — whisper.cpp and the speech model still need to be installed. It takes about a minute.</p>
                <button class="btn btn-primary" data-goto="setup">Finish setup</button>`}
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
  const jump = ev.target.closest('button[data-goto]');
  if (jump) return showView(jump.dataset.goto);

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

// Chromium reports two aliases alongside the real devices — 'communications'
// and 'default', labelled "Default - <whatever Windows is using>". Neither is
// a device. 'default' is exactly what asking for no device gives you, so with
// "System default" in the list as its own option it would appear twice under
// two names, one of which silently changes meaning when Windows switches.
const audioInputs = async () => (await navigator.mediaDevices.enumerateDevices())
  .filter((d) => d.kind === 'audioinput'
    && d.deviceId !== 'communications' && d.deviceId !== 'default');

/**
 * The input devices, with their labels.
 *
 * Labels are blank until the page has been granted microphone access, and a
 * silent getUserMedia grants it. That grant only has to happen once, so it is
 * worth checking first: this runs again every time a device is plugged in or
 * removed, and opening the microphone lights up the system's "in use"
 * indicator — and can itself nudge a Bluetooth headset into changing profile.
 */
async function listInputs() {
  const first = await audioInputs();
  if (first.length && first.every((d) => d.label)) return first;

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
  return audioInputs();
}

async function loadDevices() {
  const select = el('mic');
  let devices = [];
  try {
    devices = await listInputs();
  } catch {
    select.innerHTML = '<option>Microphone access blocked</option>';
    select.disabled = true;
    return;
  }

  select.disabled = false;
  // A setting saved from an older build may name the 'default' alias, which is
  // no longer offered. It always meant "whatever Windows is using", so migrate
  // it to the option that says exactly that instead of reporting it missing.
  if (settings.micDevice && /^Default - /.test(settings.micDevice)) {
    settings = await api.setSettings({ micDevice: null });
  }
  const saved = settings.micDevice || '';
  // Only what the operating system currently offers can appear here. A
  // Bluetooth headset that is connected for audio *output* has no capture
  // endpoint until Windows brings up the hands-free profile, so it genuinely
  // is not in this list — that is the OS, not a filter of ours.
  const present = devices.some((d) => d.label === saved);

  // An explicit default beats an implicit one. Without this the first device
  // in the list looks chosen when nothing is, and picking "whatever Windows
  // is using" was impossible to express once you had chosen anything else.
  const options = ['<option value="">System default</option>'];
  for (const d of devices) {
    options.push(`<option value="${escapeHtml(d.label)}">${escapeHtml(d.label || 'Unnamed device')}</option>`);
  }
  // A saved device that has gone away stays in the list, selected. Dropping it
  // would silently re-point the setting at another microphone, and the user
  // would have no idea their choice had been thrown away when the headset
  // reconnected.
  if (saved && !present) {
    options.push(`<option value="${escapeHtml(saved)}">${escapeHtml(saved)} — not connected</option>`);
  }
  select.innerHTML = options.join('');
  select.value = saved;

  el('mic-missing').hidden = !saved || present;
  if (saved && !present) el('mic-missing-name').textContent = saved;
}

// Headsets connect and disconnect while this window is open, and the list was
// only ever built once at startup — so plugging in the thing you came here to
// select left you staring at a dropdown that did not contain it.
navigator.mediaDevices?.addEventListener('devicechange', () => { loadDevices(); });

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
  el('indicator').checked = settings.showIndicator !== false;
  el('indicator-pos').textContent = settings.hudPosition
    ? `Moved to ${settings.hudPosition.x}, ${settings.hudPosition.y}.`
    : 'Bottom centre of the main display.';
  el('indicator-reset').disabled = !settings.hudPosition;

  const name = COMBO_NAMES[settings.combo] || 'Ctrl + Win';
  el('g-hold').textContent = `Hold ${name}`;
  el('g-double').textContent = `Double tap ${name}`;
  el('g-single').textContent = `Tap ${name}`;
}

async function renderDiagnostics() {
  const d = await api.diagnostics();
  el('datadir-path').textContent = d.dataDir;
  el('update-version').textContent = `Yapanese ${d.version}`;
  renderUpdateSetting(await api.getUpdate());
  el('diag').innerHTML = `
    <div><span>whisper-cli</span><code class="${d.whisperCli ? '' : 'missing'}">${d.whisperCli ? escapeHtml(d.whisperCli) : 'not installed — open Setup'}</code></div>
    <div><span>yap</span><code>${d.yap ? escapeHtml(d.yap) : 'not found — optional fallback'}</code></div>
    <div><span>ffmpeg</span><code>${d.ffmpeg ? escapeHtml(d.ffmpeg) : 'not found — optional'}</code></div>
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
  // '' is the "System default" option; store it as null, which is what the
  // settings default already means, rather than inventing a second empty value.
  settings = await api.setSettings({ micDevice: e.target.value || null });
  await loadDevices();
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
el('indicator').addEventListener('change', async (e) => {
  settings = await api.setSettings({ showIndicator: e.target.checked });
});
el('indicator-reset').addEventListener('click', async () => {
  settings = await api.setSettings({ hudPosition: null });
  renderSettings();
  toast('good', 'Indicator moved back to the bottom of the screen.');
});
el('open-data').addEventListener('click', () => api.openDataDir());
el('clear-history').addEventListener('click', async () => {
  entries = await api.clearHistory();
  renderHistory();
  toast('good', 'History cleared.');
});

// ---------------------------------------------------------------- updates

/**
 * One bar, one button.
 *
 * Most people running this will never look at a changelog or a releases page.
 * The whole interaction is: something is available, press this, press it once
 * more to restart. Dismissing it hides the bar for this session only — the
 * next launch offers it again, because an update that fixes the bug you are
 * about to hit should keep asking.
 */
let updateDismissed = false;

function renderUpdate(status) {
  const bar = el('update-bar');
  const action = el('update-action');
  const progress = el('update-progress');

  const showFor = ['available', 'downloading', 'ready'];
  if (updateDismissed || !showFor.includes(status.state)) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.dataset.state = status.state;
  progress.hidden = status.state !== 'downloading';

  if (status.state === 'available') {
    el('update-title').textContent = `Version ${status.version} is available`;
    el('update-note').textContent = status.notes || 'Improvements and fixes.';
    action.textContent = 'Update';
    action.disabled = false;
  } else if (status.state === 'downloading') {
    el('update-title').textContent = `Downloading version ${status.version}`;
    el('update-note').textContent = 'You can keep using Yapanese while this finishes.';
    el('update-fill').style.width = `${status.percent || 0}%`;
    action.textContent = `${status.percent || 0}%`;
    action.disabled = true;
  } else {
    el('update-title').textContent = `Version ${status.version} is ready`;
    el('update-note').textContent = 'Restart to finish. It takes a couple of seconds.';
    action.textContent = 'Restart now';
    action.disabled = false;
  }
}

el('update-action').addEventListener('click', async () => {
  const status = await api.getUpdate();
  if (status.state === 'ready') return void api.installUpdate();
  if (status.state === 'available') {
    const res = await api.downloadUpdate();
    if (!res.ok) toast('error', res.error || 'The update could not be downloaded.');
  }
});

el('update-dismiss').addEventListener('click', () => {
  updateDismissed = true;
  el('update-bar').hidden = true;
});

/** The Settings row, which says the same thing in the place people go
 *  looking for it when they have not seen the bar. */
function renderUpdateSetting(status) {
  const note = el('update-state');
  const button = el('update-check');
  if (!note) return;

  // Kept to a few words. This row exists to answer "am I current?" — the bar
  // at the top of the window is where an actual update gets explained.
  note.textContent =
    status.state === 'checking' ? 'Checking…'
    : status.state === 'available' ? `${status.version} available.`
    : status.state === 'downloading' ? `Downloading ${status.version} — ${status.percent || 0}%`
    : status.state === 'ready' ? `${status.version} ready — restart to finish.`
    : status.state === 'error' ? 'Could not reach GitHub.'
    : status.unsupported ? 'Installed copies only.'
    : status.state === 'none' ? 'Up to date.'
    : 'Checked automatically.';

  button.disabled = status.state === 'checking' || status.state === 'downloading';
}

el('update-check').addEventListener('click', async () => {
  el('update-check').disabled = true;
  // A dismissal was about the last thing offered, not about a check the user
  // has just explicitly asked for.
  updateDismissed = false;
  const status = await api.checkUpdate();
  renderUpdate(status);
  renderUpdateSetting(status);
});

api.on('update:status', (status) => {
  renderUpdate(status);
  renderUpdateSetting(status);
});

// ------------------------------------------------------------------ setup

let setupState = null;
let chosenEngine = null;
const extras = new Set();
let installing = false;

function formatBytes(n) {
  if (!n) return '';
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  // Rounding to whole megabytes turns the 865 KB voice model into "1 MB",
  // which reads like a rounding error rather than a size.
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n / 1048576)} MB`;
}

const MARKS = {
  done: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>',
  pending: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="7.5" stroke-dasharray="3 3"/></svg>',
  working: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4.5a7.5 7.5 0 1 1-5.3 2.2"/></svg>',
  failed: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7.5"/><path d="M12 8.5v4.5"/><circle cx="12" cy="16" r=".8" fill="currentColor" stroke="none"/></svg>',
};

/** The rows the install will actually work through, in the order it does. */
function setupRows() {
  if (!setupState) return [];
  const rows = [];
  const engine = setupState.engine;

  if (engine.installed) {
    rows.push({
      id: 'engine',
      name: 'whisper.cpp',
      note: engine.kind === 'external'
        ? `Found at ${engine.path}`
        : `${engine.kind === 'cuda' ? 'NVIDIA GPU' : 'CPU'} build${engine.release ? `, release ${engine.release}` : ''}`,
      installed: true,
      bytes: 0,
    });
  } else {
    const pick = setupState.engines.find((e) => e.id === chosenEngine);
    rows.push({
      id: 'engine',
      name: `whisper.cpp — ${pick ? pick.label : 'engine'} build`,
      note: 'The transcription program itself, plus the libraries it needs to run.',
      installed: false,
      bytes: pick ? pick.bytes : 0,
    });
  }

  for (const m of setupState.models) {
    if (!m.required) continue;
    rows.push({ id: m.id, name: m.label, note: m.note, installed: m.installed, bytes: m.bytes });
  }
  return rows;
}

function componentHtml(row, { optional = false } = {}) {
  const status = row.installed ? 'done' : 'pending';
  const wanted = optional ? extras.has(row.id) : true;
  const size = row.installed ? 'Installed' : formatBytes(row.bytes);

  const name = optional
    ? `<label class="c-head"><input type="checkbox" data-extra="${row.id}" ${extras.has(row.id) ? 'checked' : ''} ${row.installed ? 'disabled' : ''}><span class="c-name">${escapeHtml(row.name)}</span></label>`
    : `<div class="c-name">${escapeHtml(row.name)}</div>`;

  return `
    <div class="component" data-id="${row.id}" data-status="${status}" data-wanted="${wanted}">
      <span class="mark">${MARKS[status]}</span>
      <div>
        ${name}
        <div class="c-note">${escapeHtml(row.note || '')}</div>
      </div>
      <span class="c-size">${escapeHtml(size)}</span>
    </div>`;
}

function pendingBytes() {
  let total = setupRows().filter((r) => !r.installed).reduce((n, r) => n + r.bytes, 0);
  for (const m of setupState.models) {
    if (!m.required && extras.has(m.id) && !m.installed) total += m.bytes;
  }
  return total;
}

function renderSetup() {
  if (!setupState) return;

  el('setup-dot').hidden = setupState.ready;
  el('setup-state-label').textContent = setupState.ready ? 'Ready' : 'Incomplete';
  el('setup-bindir').textContent = setupState.binDir;
  el('setup-modeldir').textContent = setupState.modelsDir;

  const lede = el('setup-lede');
  if (setupState.ready) {
    lede.innerHTML = `
      <h3>Everything is installed</h3>
      <p>Yapanese can transcribe. Nothing here needs the network again — the models
         are on this machine and stay there.</p>`;
  }

  // The choice only exists while there is a choice to make. Once a build is
  // installed, offering it again as a radio implies switching is a normal
  // thing to do, which for a gigabyte of CUDA libraries it is not.
  const engineGroup = el('setup-engine-group');
  engineGroup.hidden = setupState.engine.installed;
  if (!setupState.engine.installed) {
    el('setup-engines').innerHTML = setupState.engines.map((e) => `
      <div class="choice" data-engine="${e.id}" data-selected="${chosenEngine === e.id}">
        <span class="radio"></span>
        <div class="choice-text">
          <div class="choice-title">
            ${escapeHtml(e.label)}
            ${e.id === setupState.recommended ? '<span class="pill">Recommended</span>' : ''}
            <span class="choice-size">${formatBytes(e.bytes)} download</span>
          </div>
          <div class="choice-note">${escapeHtml(e.note)}</div>
        </div>
      </div>`).join('');
  }

  el('setup-components').innerHTML = setupRows().map((r) => componentHtml(r)).join('');

  const optional = setupState.models.filter((m) => !m.required);
  el('setup-extras-group').hidden = optional.length === 0;
  el('setup-extras').innerHTML = optional.map((m) => componentHtml({
    id: m.id, name: m.label, note: m.note, installed: m.installed, bytes: m.bytes,
  }, { optional: true })).join('');

  const outstanding = pendingBytes();
  const run = el('setup-run');
  run.hidden = installing;
  run.disabled = outstanding === 0;
  run.textContent = outstanding === 0 ? 'Nothing to download' : 'Download and set up';
  el('setup-cancel').hidden = !installing;
  el('setup-total').textContent = installing
    ? ''
    : outstanding > 0 ? `${formatBytes(outstanding)} to download` : '';
}

/**
 * Update one row in place.
 *
 * Rebuilding the list on every chunk of a 640 MB download would reset the
 * checkboxes and thrash the DOM a few thousand times, so progress writes to
 * the nodes that are already there.
 */
function applySetupProgress(p) {
  const node = document.querySelector(`.component[data-id="${p.id}"]`);
  if (!node) return;

  if (p.phase === 'done') {
    node.dataset.status = 'done';
    node.querySelector('.mark').innerHTML = MARKS.done;
    node.querySelector('.c-size').textContent = 'Installed';
    node.querySelector('.track')?.remove();
    return;
  }
  if (p.phase === 'failed') {
    node.dataset.status = 'failed';
    node.querySelector('.mark').innerHTML = MARKS.failed;
    node.querySelector('.c-size').textContent = p.error === 'cancelled' ? 'Cancelled' : 'Failed';
    node.querySelector('.track')?.remove();
    return;
  }

  node.dataset.status = 'working';
  node.querySelector('.mark').innerHTML = MARKS.working;

  let track = node.querySelector('.track');
  if (!track) {
    track = document.createElement('div');
    track.className = 'track';
    track.innerHTML = '<div class="fill" style="width:0%"></div>';
    node.appendChild(track);
  }
  const fill = track.querySelector('.fill');

  if (p.phase === 'install') {
    fill.dataset.indeterminate = 'true';
    node.querySelector('.c-size').textContent = 'Unpacking…';
    return;
  }
  if (p.phase === 'download' && p.total) {
    delete fill.dataset.indeterminate;
    const pct = Math.min(100, (p.received / p.total) * 100);
    fill.style.width = `${pct}%`;
    node.querySelector('.c-size').textContent =
      `${formatBytes(p.received)} of ${formatBytes(p.total)}`;
  }
}

async function refreshSetup() {
  setupState = await api.inspectSetup();
  if (!chosenEngine) chosenEngine = setupState.recommended;
  applyReadiness({ ready: setupState.ready });
  renderSetup();
}

el('setup-engines').addEventListener('click', (ev) => {
  const choice = ev.target.closest('.choice');
  if (!choice || installing) return;
  chosenEngine = choice.dataset.engine;
  renderSetup();
});

el('setup-extras').addEventListener('change', (ev) => {
  const box = ev.target.closest('input[data-extra]');
  if (!box) return;
  if (box.checked) extras.add(box.dataset.extra);
  else extras.delete(box.dataset.extra);
  renderSetup();
});

el('setup-run').addEventListener('click', async () => {
  installing = true;
  renderSetup();

  const res = await api.runSetup({
    engine: setupState.engine.installed ? null : chosenEngine,
    extras: [...extras],
  });

  installing = false;
  setupState = res.state || (await api.inspectSetup());
  renderSetup();

  if (res.ok) {
    toast('good', 'Setup complete — Yapanese is ready to transcribe.');
    if (setupState.ready) showView('history');
  } else if (res.cancelled) {
    toast('warn', 'Setup cancelled. Nothing incomplete was kept.');
  } else {
    toast('error', res.error || 'Setup could not finish.');
  }
});

el('setup-cancel').addEventListener('click', () => api.cancelSetup());

api.on('setup:progress', applySetupProgress);

// ------------------------------------------------------------------ state

let lastState = 'idle';

function applyState({ state, error, elapsedMs }) {
  lastState = state;
  if (elapsedMs) {
    const secs = (elapsedMs / 1000).toFixed(1);
    const note = el('last-timing');
    if (note) note.textContent = `${secs}s to transcribe.`;
  }
  statusEl.dataset.state = state;
  statusText.textContent =
    !isReady ? 'Setup needed' :
    state === 'recording' ? 'Recording' :
    state === 'transcribing' ? 'Transcribing' :
    'Ready';

  recordLabel.textContent = state === 'recording' ? 'Stop' : state === 'transcribing' ? 'Working…' : 'Record';
  recordBtn.classList.toggle('btn-live', state === 'recording');
  recordBtn.classList.toggle('btn-primary', state !== 'recording');
  // Nothing can be recorded until there is something to transcribe it with,
  // and a button that starts a doomed recording is worse than one that says
  // it is unavailable.
  recordBtn.disabled = state === 'transcribing' || !isReady;
  recordBtn.title = isReady ? '' : 'Finish setup before dictating';
}

/**
 * The gate, in the window.
 *
 * The main process refuses to record regardless of what is on screen — this
 * is so the reason is visible rather than the app appearing to ignore a
 * click. History stays reachable throughout: a user whose model went missing
 * should never be locked away from transcripts they already have.
 */
let isReady = true;

function applyReadiness({ ready }) {
  const changed = isReady !== ready;
  isReady = ready;
  el('setup-dot').hidden = ready;
  // The rail's status lamp reads as normal-and-idle otherwise, next to a
  // label saying the app cannot work yet.
  statusEl.dataset.ready = String(ready);
  document.querySelector('.nav button[data-view="setup"]')
    ?.classList.toggle('needs-attention', !ready);
  applyState({ state: lastState });
  // The empty history reads differently either side of this, so it has to be
  // redrawn — otherwise finishing setup leaves "Setup is not finished" on screen.
  if (changed) renderHistory();
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
  // Re-read rather than trusting the copy from boot: the indicator's position
  // is changed by dragging it, which this window never hears about.
  if (name === 'settings') {
    api.getSettings().then((s) => { settings = s; renderSettings(); });
    renderDiagnostics();
  }
  // Re-read on the way in: a component may have been installed by hand, or
  // by the install that ran the last time this view was open.
  if (name === 'setup' && !installing) refreshSetup();
}

// ------------------------------------------------------------------- boot

api.on('state', applyState);
api.on('readiness', applyReadiness);
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
  // Before the microphone prompt: the rail badge should be right from the
  // first frame, and loadDevices waits on a permission dialog.
  await refreshSetup();
  // An update found before this window opened still has to be offered.
  renderUpdate(await api.getUpdate());
  await loadDevices();
  applyState({ state: await api.getState() });
})();
