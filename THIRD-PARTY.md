# Third-party components

Murmur is MIT licensed. It builds on the following work.

## Bundled

| Component | Licence | Notes |
|---|---|---|
| [Electron](https://github.com/electron/electron) | MIT | Application shell |
| [uiohook-napi](https://github.com/SnosMe/uiohook-napi) | MIT | Global keyboard hook and input synthesis |
| [Inter](https://github.com/rsms/inter) via [@fontsource/inter](https://github.com/fontsource/fontsource) | SIL OFL 1.1 | Bundled locally so the app makes no network requests at runtime |

Inter is used under the SIL Open Font License 1.1. The font files are
redistributed unmodified. The full licence text ships with the
`@fontsource/inter` package in `node_modules`.

## Invoked, not bundled

These are separate programs Murmur runs. They are not redistributed as part of
this repository, and users install them themselves.

| Component | Licence | Notes |
|---|---|---|
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | MIT | Speech recognition engine (`whisper-cli`) and the Silero VAD model |
| [Whisper](https://github.com/openai/whisper) models | MIT | Weights published by OpenAI, distributed in GGML format by the whisper.cpp project |
| [ffmpeg](https://ffmpeg.org/) | LGPL-2.1+ / GPL-2+ | Optional. Only used by the `yap` fallback path; Murmur's own capture path does not need it |

## Origin

Murmur began while porting [finnvoor/yap](https://github.com/finnvoor/yap)
(CC0-1.0) to Windows. yap is a macOS CLI built on Apple's Speech framework;
that port replaced the recognition engine with whisper.cpp.

Murmur is a separate program with a different purpose, and it no longer
depends on yap: it invokes `whisper-cli` directly. yap remains supported as a
fallback when `whisper-cli` is not present, which is why it is credited here.
