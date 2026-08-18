<div align="center">

<img src="assets/icon.png" width="96" alt="Murmur">

# Murmur

**Local dictation for Windows. Hold a key, talk, and the text lands where your cursor is.**

No account, no cloud, no per-minute billing. Nothing leaves your machine.

</div>

---

## Why

Good dictation on Windows generally means paying a subscription and sending your
voice to someone else's server. The models that make it work are open, run
locally, and are fast enough on ordinary hardware — the missing piece is the
thing that makes them feel invisible.

Murmur is that piece: a tray app, a global hotkey, and your words in whatever
window you were already using.

## What it does

- **Hold** your shortcut, talk, let go. The transcript pastes into the focused app.
- **Double tap** to lock recording on for long-form thinking aloud; **tap once** to stop.
- Every transcript is saved to a **searchable local history** before it is delivered
  anywhere, so a failed paste is an inconvenience, never a lost thought.
- **Voice activity detection** discards room noise, so a desk or webcam microphone
  does not produce invented sentences.
- Runs on the **GPU** when a CUDA build of whisper.cpp is present, otherwise CPU.

## Speed

Measured on an Intel i7-14700F with an RTX 5050, using `large-v3-turbo-q5_0`:

| audio length | CPU | GPU |
|---|---|---|
| 2 seconds | 2.0s | **0.8s** |
| 11 seconds | 2.6s | **0.9s** |

Whisper's encoder always processes a fixed 30-second window, so a two-second clip
costs the same as a thirty-second one unless you cap it. Murmur sizes that window
to the actual clip, which is most of the difference between "instant" and
"why is this taking so long".

## Requirements

- Windows 10 or 11
- [Node.js](https://nodejs.org/) 18+
- [`whisper-cli`](https://github.com/ggml-org/whisper.cpp/releases) from whisper.cpp,
  on your `PATH` or in `%LOCALAPPDATA%\yap\bin`

For GPU acceleration, use one of whisper.cpp's `cublas` release builds instead of
the plain one. The first run pays a one-time CUDA JIT compilation cost — if it
seems slow once and fast afterwards, that is why.

## Install

```powershell
git clone https://github.com/<you>/murmur.git
cd murmur
npm install
npm start
```

The speech model (`large-v3-turbo-q5_0`, 547MB) and the Silero VAD model (865KB)
download automatically on first use into `%LOCALAPPDATA%\yap\models`. After that
the app makes no network requests.

To get a desktop shortcut:

```powershell
powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
```

## Usage

Default shortcut is **Ctrl + Win**, changeable in Settings.

| gesture | what happens |
|---|---|
| Hold | Records while held, transcribes on release |
| Double tap | Locks recording on indefinitely |
| Tap (while locked) | Stops and transcribes |

## How it works

```
hotkey (low-level keyboard hook)
   └─> capture     Web Audio, 16 kHz mono, in a hidden renderer
        └─> WAV    written straight to a temp file — no conversion step
             └─> whisper-cli --vad          speech detection, then transcription
                  └─> history               written before delivery is attempted
                       └─> clipboard + Ctrl+V into the focused window
```

Two decisions worth explaining:

**The transcript is written to history before it is delivered.** Delivery can be
best-effort because the record is already safe.

**Text is pasted rather than typed.** Synthesising keystrokes mangles Unicode and
anything the Windows key-event API treats as syntax. A clipboard paste moves the
whole string verbatim in one keystroke, and the previous clipboard contents are
restored afterwards.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Microphone | system default | Any input device Windows exposes |
| Shortcut | Ctrl + Win | Also Alt+Win, Ctrl+Shift, Win |
| Ignore background noise | on | Voice activity detection |
| Transcription quality | Balanced | Accurate / Balanced / Fast |
| Paste automatically | on | Off copies to clipboard instead |
| Start with Windows | off | Launches hidden in the tray |

Transcripts are stored as plain JSON in `%APPDATA%\murmur`, readable and
deletable without this app being involved.

## Honest limitations

- **Windows only.** The keyboard hook, the paste path and the tray behaviour are
  all platform-specific.
- **Murmur sees every keystroke** while running, because a low-level keyboard
  hook is the only way to detect hold and double-tap gestures. Non-shortcut keys
  are discarded immediately, nothing is logged or stored, and nothing is
  transmitted — but it is a real capability and you should know it is there.
- **No installer yet.** It runs from a clone.
- **Accuracy depends on your microphone.** A far-field webcam mic works, but a
  close mic is better, as with any speech recognition.

## Credits

Built on [whisper.cpp](https://github.com/ggml-org/whisper.cpp) by Georgi
Gerganov and contributors, and OpenAI's [Whisper](https://github.com/openai/whisper)
models. Started life while porting [finnvoor/yap](https://github.com/finnvoor/yap)
to Windows.

Full attribution in [THIRD-PARTY.md](THIRD-PARTY.md).

## Licence

MIT. See [LICENSE](LICENSE).
