# Vanguard Deck

Vanguard Deck turns a rough script into an annotated client presentation. It runs on your own machine: a local [Ollama](https://ollama.com) model structures the slides, a local vision model explains the details you pin on your screenshots, and nothing leaves your computer.

Built with Tauri v2, Rust, React 19, TypeScript and Tailwind CSS, for Windows and macOS.

## What it does

- **Script to slides.** Paste a script or notes, pick an audience and tone, and get structured slides with headlines, talking points, speaker notes and suggested visuals. Without AI, Build from outline turns blank-line-separated notes into slides.
- **Pin and explain.** Drop, paste or browse for an image, click to place numbered pins, and drag leader-line callouts into place. The sparkle button asks the vision model to describe that exact region.
- **Present.** `Ctrl/Cmd + Enter` opens a distraction-free fullscreen deck. Clicking a pin highlights its line and zooms smoothly into the detail.
- **Export.** One click produces a high-DPI PDF or a PowerPoint file with speaker notes, with every pin and callout rendered in place.
- **Hardware-aware models.** The app reads your CPU, RAM and GPU, recommends models that fit, and downloads them with live progress.

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 20 or newer | |
| Rust | stable | Install with [rustup](https://rustup.rs) |
| Windows | 10 or 11 | Needs the Visual Studio C++ build tools and WebView2 |
| macOS | 11 or newer | Needs the Xcode command line tools |
| Ollama | any recent version | Optional, for the AI features. The app can start it and links to the download |

## Getting started

```sh
npm install
npm start
```

This opens the desktop app in development mode. It uses dedicated port **17391**, so it will not collide with other local projects. If that port is taken, startup stops with a clear message.

To build an installer:

```sh
npm run build
```

Installers are written to `src-tauri/target/release/bundle/`.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + Enter` | Start or leave the presentation |
| `Ctrl/Cmd + S` | Save now (the app also saves automatically) |
| `Ctrl/Cmd + Z`, `Ctrl/Cmd + Shift + Z` | Undo and redo deck changes |
| `Ctrl/Cmd + \` | Show or hide the sidebar |
| `Ctrl/Cmd + ,` | Open Settings & AI Engine |
| `/` at the start of a script line | Open the command menu |
| `Ctrl/Cmd + V` over an image slot | Paste an image |
| Arrow keys on a focused pin | Nudge the pin (hold Shift for larger steps) |

In the presentation: arrow keys, Space, Page Up and Page Down change slides, `1` to `9` select pins, `N` toggles speaker notes, and `Esc` zooms out and then exits.

## Testing

```sh
npm test                 # spec rules, types, unit tests, browser end-to-end tests
npm run test:rust        # Rust unit tests
npm run build:exe        # needed once before the desktop tests
npm run test:e2e:tauri   # end-to-end tests against the real desktop app
npm run test:e2e:live    # end-to-end test against your real Ollama and models
```

The end-to-end suite runs in three layers. `web` tests the production bundle in Chromium. `tauri` drives the real executable, which covers the Rust commands, SQLite, the asset protocol and the security policy. Both use a mock daemon (`scripts/mock-ollama.mjs`) that speaks the Ollama protocol, so they are fast and repeatable. `live` uses your real local models and needs `llama3.2:3b` and `moondream`.

## Ports

| Port | Used by |
| --- | --- |
| 17391 | Development server and the desktop app in development |
| 17392 | Preview of the production web bundle, used by tests |
| 17393 | Mock Ollama, used by tests |
| 17394 | WebView2 debugging port, used only by the desktop tests |
| 11434 | Ollama itself |

## Where your data lives

Everything stays on your machine, in `vanguard-deck` under your user data folder (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS):

```text
vanguard-deck/
├── vanguard.db                    SQLite database with your projects and settings
└── projects/{project_id}/
    ├── project.json               Readable recovery copy of the project
    └── assets/{sha256}.{ext}      Your images
```

## Project layout

```text
src-tauri/src/
  hardware.rs     CPU, RAM, Apple unified memory and VRAM detection
  ollama.rs       Daemon checks, model pulls, script and vision pipelines
  storage.rs      Project and image file management
src/
  components/
    layout/       Sidebar and top bar
    script/       Script Studio
    canvas/       Slide cards, dropzones and the pin engine
    models/       Settings & AI Engine
    presentation/ Presenter and the slide stage shared with export
  lib/
    bridge/       Host interface, with Tauri and browser implementations
    leader.ts     Pin and leader-line geometry
    export.tsx    PDF and PowerPoint export
  store/          Application state and autosave
e2e/              Playwright tests
docs/             The review of PLAN.md and its requirement traceability
```

The original specification is [PLAN.md](PLAN.md). [docs/PLAN_REVIEW.md](docs/PLAN_REVIEW.md) records where the implementation deliberately differs from it, and why.
