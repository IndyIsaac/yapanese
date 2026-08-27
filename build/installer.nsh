; Custom NSIS fragment, merged into the installer electron-builder generates.
;
; Yapanese is a front end for whisper.cpp, and the installer does not carry
; whisper.cpp or the speech model — together they are far larger than the app
; and the right build depends on the machine. That is a reasonable trade, but
; only if the person running the installer is told about it before they finish
; rather than after they try to dictate. Hence this page.

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Install Yapanese"
  !define MUI_WELCOMEPAGE_TEXT "Local dictation for Windows. Hold a key, talk, and the text lands where your cursor is.$\r$\n$\r$\nOne thing to know before you start:$\r$\n$\r$\nThis installer sets up the app itself. The first time you open it, Yapanese will walk you through a one-time download of the transcription engine and the speech model — roughly 560 MB, or 1.2 GB if you choose the faster NVIDIA GPU build. It picks the right one for your machine and you can change it.$\r$\n$\r$\nDictation is unavailable until that finishes. After it does, everything runs on this computer and nothing is sent anywhere."
  !insertmacro MUI_PAGE_WELCOME
!macroend
