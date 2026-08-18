<div align="center">

<img src="assets/icon.png" width="88" alt="">

# Yapanese

### Local dictation for Windows. Hold a key, talk, and the text lands where your cursor is.

No account. No cloud. No per-minute billing. Nothing leaves your machine.

[![Build](https://github.com/Vibeypirate/yapanese/actions/workflows/build.yml/badge.svg)](https://github.com/Vibeypirate/yapanese/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/Vibeypirate/yapanese?color=7c6cf0&label=download)](https://github.com/Vibeypirate/yapanese/releases/latest)
[![Licence](https://img.shields.io/badge/licence-MIT-7c6cf0)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-2a2a35)

<br>

<img src="assets/demo.gif" width="820" alt="Holding Ctrl+Win, speaking, and the text appearing in Notepad">

<sub><b>Real capture.</b> Audio through a webcam microphone, transcribed locally in 866&nbsp;ms.</sub>

</div>

<br>

## Why this exists

Dictation on Windows usually means a subscription and your voice on someone
else's server. The models that make it work are open, run locally, and are fast
enough on ordinary hardware. What's missing is the part that makes them
disappear into your workflow.

That's this: a tray app, one global shortcut, and your words in whatever window
you were already using.

## What it does

| | |
|---|---|
| **Hold to dictate** | Hold the shortcut, talk, let go. The text pastes into the focused app. |
| **Double tap to lock** | Locks recording on for long-form thinking aloud. Tap once to stop. |
| **Searchable history** | Every transcript is saved locally *before* delivery, so a failed paste is an inconvenience, never a lost thought. |
| **Ignores the room** | Voice activity detection discards background noise, so a desk or webcam mic doesn't produce invented sentences. |
| **Uses your GPU** | Runs on CUDA when a compatible whisper.cpp build is present, otherwise CPU. |

<br>

<div align="center">
<img src="assets/screenshot-history.png" width="49%" alt="History view with searchable transcripts">
<img src="assets/screenshot-settings.png" width="49%" alt="Settings view">
</div>

## Speed

Measured on an Intel i7-14700F with an RTX 5050, model `large-v3-turbo-q5_0`:

| audio length | CPU | GPU |
|---|---|---|
| 2 seconds | 2.0 s | **0.8 s** |
| 11 seconds | 2.6 s | **0.9 s** |

Whisper's encoder always processes a fixed 30-second window, so a two-second
clip costs the same as a thirty-second one unless you cap it. Yapanese sizes
that window to the actual clip — most of the distance between "instant" and
"why is this taking so long".

## Install

Download the installer from [**Releases**](https://github.com/Vibeypirate/yapanese/releases/latest), or build it:

```powershell
git clone https://github.com/Vibeypirate/yapanese.git
cd yapanese
npm install
npm run dist       # -> dist\Yapanese Setup <version>.exe
npm start          # or just run it from source
```

### One prerequisite

Yapanese needs [`whisper-cli`](https://github.com/ggml-org/whisper.cpp/releases)
from whisper.cpp, on your `PATH` or in `%LOCALAPPDATA%\yap\bin`.

For GPU acceleration, take one of the `cublas` release builds instead of the
plain one. The first run pays a one-time CUDA compilation cost — if it is slow
once and fast forever after, that is why.

Models download themselves on first use into `%LOCALAPPDATA%\yap\models`:
`large-v3-turbo-q5_0` (547 MB) for speech and Silero (865 KB) for voice
detection. After that, the app makes no network requests at all.

## Usage

Default shortcut is **Ctrl + Win**, changeable in Settings.

| gesture | result |
|---|---|
| **Hold** | Records while held, transcribes on release |
| **Double tap** | Locks recording on indefinitely |
| **Tap** while locked | Stops and transcribes |

## How it works

```
global keyboard hook
  └─ capture ............ Web Audio, 16 kHz mono, hidden renderer
      └─ WAV ............ written straight to temp — no conversion step
          └─ whisper-cli --vad ...... speech detection, then transcription
              └─ history ............ saved before delivery is attempted
                  └─ clipboard + Ctrl+V into the focused window
```

Three decisions worth explaining:

**The transcript is saved before it is delivered.** Delivery is allowed to be
best-effort because the record is already safe.

**Text is pasted, not typed.** Synthesised keystrokes mangle Unicode and
anything the Windows key API treats as syntax. A clipboard paste moves the whole
string verbatim in one keystroke; your previous clipboard is restored after.

**A keyboard hook, not a registered shortcut.** Windows global shortcuts only
report key-down and refuse modifier-only combinations, so neither hold nor
double-tap is possible with them.

## Settings

| Setting | Default | |
|---|---|---|
| Microphone | system default | Any input Windows exposes |
| Shortcut | Ctrl + Win | Also Alt+Win, Ctrl+Shift, Win |
| Ignore background noise | on | Voice activity detection |
| Transcription quality | Balanced | Accurate · Balanced · Fast |
| Paste automatically | on | Off copies to clipboard instead |
| Start with Windows | off | Launches hidden in the tray |

Transcripts live as plain JSON in `%APPDATA%\Yapanese` — readable, portable and
deletable without this app being involved.

## Honest limitations

- **Windows only.** The keyboard hook, paste path and tray behaviour are all
  platform-specific.
- **Yapanese sees every keystroke while running.** A low-level keyboard hook is
  the only way to detect hold and double-tap gestures. Non-shortcut keys are
  discarded immediately, nothing is logged or stored, and nothing is
  transmitted — but it is a real capability and you should know it is there.
- **The installer is unsigned.** SmartScreen will warn on first run until the
  binary builds reputation. Signing needs a certificate.
- **Accuracy depends on your microphone.** A far-field webcam mic works — that
  is what the demo was recorded with — but a close mic is better, as with any
  speech recognition.

## Contributing

Issues and pull requests are welcome. `npm start` runs it from source;
`tools/` holds the scripts used to test the capture, paste and gesture paths
without needing a human to speak into the microphone.

## Credits

Built on [whisper.cpp](https://github.com/ggml-org/whisper.cpp) by Georgi
Gerganov and contributors, and OpenAI's [Whisper](https://github.com/openai/whisper)
models. Started life while porting [finnvoor/yap](https://github.com/finnvoor/yap)
to Windows — hence the name.

Full attribution in [THIRD-PARTY.md](THIRD-PARTY.md).

## Licence

[MIT](LICENSE).
