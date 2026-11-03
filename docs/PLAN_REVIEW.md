# Review of PLAN.md

This document records what a line-by-line review of [PLAN.md](../PLAN.md) found, how each problem was resolved in the code, and how every requirement maps to an implementation and a test. Anyone changing the app or the plan should read section 1 first: those are the places where the code deliberately does not follow the plan's literal text.

## 1. Defects in the plan

The plan could not be implemented as written. These problems were found and resolved.

### Would not compile or run

| # | Where | Problem | Resolution |
| --- | --- | --- | --- |
| 1 | Blueprint 1, `handleCanvasClick` | `if (!isPinMode  draggingItem)` is missing its `\|\|` operator, so it is a syntax error. | Implemented with the intended logic. |
| 2 | Blueprint 2, `get_hardware_specs` | `.unwrap_or_else( "Generic Processor".to_string())` is missing its closure, so it does not compile. | Implemented with a closure. |
| 3 | Blueprint 1, leader lines | `<polyline points="x%,y%">` is invalid. SVG `points` does not accept percentages, so no line would render at all. | Lines are `<path>` elements in a `viewBox="0 0 100 100"` coordinate system with `vector-effect: non-scaling-stroke`, which keeps the coordinates normalized and the stroke a true 1.5px. |
| 4 | Module A, tier 3 | The model `qwen2.5-vl:14b` does not exist. The Ollama registry returns 404 for it, and for `qwen2.5vl:14b`. The published tags are `qwen2.5vl:3b`, `7b` and `32b`. | Uses `qwen2.5vl:7b`. The 32B tag needs 21 GB, more than the tier's 18 GB floor. |

All other model tags in the plan were checked against the registry and exist. The sizes shown in the app are the real manifest sizes.

### Contradictions within the plan

| # | Where | Conflict | Resolution |
| --- | --- | --- | --- |
| 5 | Section 2 and Phase 2 | The pull event is named `ollama://pull-progress` and also `ollama-pull-progress`. | Both are emitted. The app listens to the first. |
| 6 | Module A and Blueprint 2 | Tier names differ (ENTRY, PRO, ULTRA against COMPACT EFFICIENCY, PRO PERFORMANCE, EXECUTIVE WORKSTATION). | Module A's names, since it is the normative section. |
| 7 | Module A and Blueprint 2 | Module A leaves 16 to 24 GB undefined, and the blueprint uses 18 GB. | Tier 3 starts at 18 GB effective memory. That is the smallest budget that holds the Tier 3 pair (7.8 GB plus 9 GB) and it also admits 32 GB Apple unified memory (32 x 0.70 = 22.4 GB). |
| 8 | Module B | The heading says JSON Schema enforcement, while the text says `format: "json"`. | Sends the full JSON Schema, and falls back to `"json"` for daemons that reject a schema or for a repair retry. |
| 9 | Module B and Phase 4 | The button is "Analyze & Generate Slides" and also "Analyze & Structure Deck". | The label is the first and the tooltip is the second. |
| 10 | Module D and Blueprint 1 | Fields are `anchorXPercent` and also `anchorX`. | Module D's names. |
| 11 | Module D and Blueprint 1 | The badge is "monochrome" but the blueprint makes it blue. | Monochrome. It turns the accent blue only when selected in the presenter, as a highlight. |
| 12 | Module D and Blueprint 1 | The line is 1.5px but the blueprint uses 1.75px. The blueprint's "elbow" also has a diagonal segment and stops at the card's corner rather than its nearest edge. | 1.5px, two truly orthogonal segments, ending on the nearest edge. Bezier is available in Settings. |
| 13 | Module D and Blueprint 1 | The toolbar needs Add Pin, AI Vision Inspect, Replace Image and Reset Pins. The blueprint has only a pin toggle and a delete. | All four, plus remove and expand. |
| 14 | Module A and Blueprint 2 | The matrix names 11 models, the blueprint lists 6. | All 11. |
| 15 | Phase 2 and Module B | `analyze_script_to_slides` has no tone parameter, although Module B has a Tone control. | Added `tone`, and `request_id` for cancellation. |
| 16 | Module C and Tauri | The plan requires `AppData/vanguard-deck/`, but Tauri's app data folder is named after the identifier. | The path is built from the user data folder directly, so it matches the plan. |

### Gaps the plan does not specify

| # | Gap | Resolution |
| --- | --- | --- |
| 17 | No dark muted text token. | `#7F7E7B`. |
| 18 | "AI refinement diff" appears only in the file tree, undefined. | A word-level diff of each slide's original text against its refined text. |
| 19 | AI Vision Inspect on an image with no pins is undefined. | Creates a centered Overview pin, then describes it. |
| 20 | Whether Replace Image keeps pins is undefined. | Keeps them, since replacing a screenshot with a newer version is the usual reason. Reset Pins is one click away. |
| 21 | Dropzone counts per layout are undefined. | 1, 2, 3 to 4, and 0. |
| 22 | Whether export follows the app theme is undefined. | Always light, since a deck is printed and shared. |
| 23a | What happens to a running analysis when the user switches projects is undefined. | It keeps running. The result fills an empty project, or becomes a new "(new draft)" project if the original has slides, so finished pin work can never be overwritten unseen. |
| 23b | What undo covers is undefined. | The deck only. Script text, persona, tone and project names are never rolled back. |

### Would have caused lag, flicker or failure in practice

These follow the plan's letter but would have broken its goals, so the code avoids them.

| # | Trap | Consequence | What the app does |
| --- | --- | --- | --- |
| 23 | Default `@iconify/react` component | Fetches icons from a public API at runtime and renders nothing until they arrive. Fails offline and flashes on every load. | A build step bundles only the used icons, rewrites them to the required 1.5px stroke, and renders them synchronously through the offline component. |
| 24 | Blueprint drag handling | Writes to state on every pointer move, re-rendering every pin and triggering autosave. It has no pointer capture, so drags break outside the image. | Pointer capture, with geometry written to the DOM once per frame. React and the store only hear about a drag when it ends. |
| 25 | Blueprint click handling | The click that follows a drag can create a stray pin. | The click after a drag is suppressed. |
| 26 | Fixed 240px callouts | Overflow small images and do not scale in presentation mode. | Cards scale with the canvas through container units, and are kept inside it at display time without altering stored positions. |
| 27 | Blueprint hardware detection | `System::new_all()` on a synchronous command blocks the UI thread. | Async command on a blocking worker, reading only what it needs, with deadlines on every probe. |
| 28 | Spawning `nvidia-smi` from a GUI app on Windows | Flashes a console window. | Every probe sets `CREATE_NO_WINDOW`. |
| 29 | `wmic` on Windows | Removed from current Windows versions. | Reads WMI through PowerShell. |
| 30 | `Win32_VideoController.AdapterRAM` | A 32-bit value that caps at 4 GB, so any larger GPU is misreported. | Prefers the driver's 64-bit registry value. |
| 31 | Reporting an integrated GPU's memory as VRAM | Would misclassify a machine with an Intel GPU. | Integrated GPUs use the system RAM budget. |
| 32 | Tauri's default `dragDropEnabled` | Swallows HTML5 file drops, so Module C's drag and drop would never fire. | Disabled in the window config. |
| 33 | `convertFileSrc` | Blocked without `protocol-asset`, a configured scope and a matching CSP. | All three are configured. |
| 34 | Ollama resets `completed` per layer and reveals each layer's size only when it starts | The progress bar and speed jump backward. | Bytes are tracked per layer, the known model size is the denominator, and the bar can only move forward. Events are limited to 10 per second. |
| 35 | Paste events go to the focused element | "Paste while hovering" would never fire. | A document listener routes pasted images to the hovered or focused zone. |
| 36 | Multiple images to `llama3.2-vision` | Models limited to one image reject the `[crop, full]` request. | Detects the rejection and retries with a single composite image. |
| 37 | Models that ignore the no-emoji rule | Would break the rule through generated text. | AI output is sanitized in Rust and again in the UI. |
| 38 | Models that add reasoning tags or code fences | Would break JSON parsing. | A tolerant parser, then one repair retry. |
| 39 | GUI apps launched from Finder or Explorer | Often have no `ollama` on their PATH, so launching fails. | Also checks the standard install locations. |
| 40 | A system proxy | Could intercept traffic to the loopback daemon. | The HTTP client disables proxies. |
| 41 | `project_id` used directly in a file path | Path traversal. | Ids and asset names are validated in Rust. |
| 42 | White flash when the window opens | A visible flash in dark mode. | The window stays hidden until the first frame is painted, the theme is set before any bundle loads, and the UI font loads before first paint. |
| 43 | EXIF orientation on phone photos | The webview shows the photo upright, but its raw size and pixels are rotated, so the image is squashed and an AI crop comes from the wrong region. | Stored dimensions and vision crops both honor the orientation tag. |
| 44 | Clipboards holding both text and an image, as spreadsheets and word processors produce | Pasting into a text field could replace the slide image instead. | Text fields keep the text. |
| 45 | Bullet stripping without requiring a space | `-12% revenue` would become `12% revenue` in a client deck. | A marker counts as a bullet only when a space follows it. |
| 46 | Long scripts and the model's context window | The reply repeats and rewrites the script, so a generous-looking window still truncates, then fails as a confusing parse error. | A larger window, a clear message when `done_reason` is `length`, and an upfront limit on script size. |
| 47 | Closing the window inside the autosave delay | The last edits would be lost. | The close request waits for pending saves, with a limit so that a stuck write cannot block closing. |
| 48 | Concurrent IPC calls can reach SQLite out of order | Toggling a setting twice quickly could save the older value. | Settings are written one at a time, in order. |

## 2. Additions beyond the plan

Small additions made in service of the plan's "user friendly" goal: Build from outline for working without AI, a sample script, undo and redo, an expanded annotation view, cancellable analysis, collision-aware callout placement, keyboard control of pins, and a responsive layout down to phone widths. Browser mode exists mainly so the interface can be tested without the native shell.

## 3. Traceability

Tests are in [e2e/](../e2e), with Rust unit tests in `src-tauri/src` and TypeScript unit tests beside their modules in `src/lib`. Static rules are enforced by `scripts/check-spec.mjs`.

### Section 1: global constraints

| Requirement | Implementation | Verified by |
| --- | --- | --- |
| Zero emoji in UI, code, placeholders, badges and prompts | `stripEmoji`, `strip_emoji` | `check-spec.mjs`, `design-system.spec.ts`, `script-studio.spec.ts`, Rust and TS unit tests |
| Iconify only, lucide and tabler, 1.5px | `scripts/generate-icons.mjs`, `AppIcon.tsx` | `check-spec.mjs`, `design-system.spec.ts` |
| Exact light and dark tokens | `globals.css` | `check-spec.mjs`, `design-system.spec.ts` |
| Inter with the system stack, 1px borders, 4 to 6px radii, specified shadows, 28px buttons | `globals.css` | `design-system.spec.ts` |
| Slash commands and top-right action bar | `ScriptStudioPane.tsx`, `Topbar.tsx` | `script-studio.spec.ts` |

### Section 2: architecture

| Requirement | Implementation | Verified by |
| --- | --- | --- |
| Tauri v2 with fs, shell, dialog, clipboard, os and sql plugins | `Cargo.toml`, `lib.rs`, `capabilities/default.json` | `tauri` Playwright project |
| sysinfo with macOS and Windows GPU probes | `hardware.rs` | Rust parser tests with sample output, `ai-engine.spec.ts` |
| Streaming reqwest client and Tauri events | `ollama.rs` | Rust tests, `tauri` project |
| zustand with SQLite and JSON sync | `useDeckStore.ts`, `tauriBridge.ts`, `storage.rs` | `projects.spec.ts` |
| Normalized percentage coordinates | `AnnotatedImage.tsx`, `leader.ts` | `annotation.spec.ts`, `leader.test.ts` |
| html-to-image with jsPDF and pptxgenjs | `export.tsx` | `presenter-export.spec.ts` |

### Section 3: modules

| Requirement | Implementation | Verified by |
| --- | --- | --- |
| A1: live specs and tier badge | `ModelManagerModal.tsx`, `hardware.rs` | `ai-engine.spec.ts`, Rust tier tests |
| A2: recommendation matrix | `hardware.rs`, `modelCatalog.ts` | `ai-engine.spec.ts`, `catalog_*` Rust tests, `deck.test.ts` |
| A3: 5 second health check, offline banner, launch and download | `useDeckStore.ts`, `App.tsx`, `ollama.rs` | `ai-engine.spec.ts` |
| A3: pull with progress, speed and cancel | `ollama.rs`, `ModelManagerModal.tsx` | `ai-engine.spec.ts`, `pull_tracker_*` Rust tests |
| A3: header switchers and model updates | `Topbar.tsx`, `useDeckStore.ts` | `ai-engine.spec.ts` |
| B1: script editor, persona and tone | `ScriptStudioPane.tsx` | `script-studio.spec.ts` |
| B2: structuring pipeline and every slide field | `ollama.rs`, `deck.ts` | `script-studio.spec.ts`, `parse_slides_*` Rust tests, `live.spec.ts` |
| C1: dashed zones with drop, picker and paste | `ImageDropzone.tsx` | `annotation.spec.ts`, `design-system.spec.ts` |
| C2: local assets, asset URLs and Base64 | `storage.rs`, `tauriBridge.ts` | `annotation.spec.ts`, Rust storage tests |
| D: hover toolbar | `AnnotatedImage.tsx` | `annotation.spec.ts` |
| D1: click to pin, independent dragging | `AnnotatedImage.tsx` | `annotation.spec.ts` |
| D2: SVG leader lines to the nearest edge, numbered badge, pulse | `AnnotatedImage.tsx`, `leader.ts`, `globals.css` | `annotation.spec.ts`, `leader.test.ts`, `design-system.spec.ts` |
| D3: inline editing and AI Vision with crop and full image | `AnnotatedImage.tsx`, `ollama.rs` | `annotation.spec.ts`, `vision_*` Rust tests, `live.spec.ts` |
| E: fullscreen presenter, highlight and smooth zoom | `VipPresenterModal.tsx`, `SlideStage.tsx` | `presenter-export.spec.ts` |
| E: PDF and PPTX with lines and callouts intact | `export.tsx` | `presenter-export.spec.ts` |

### Non-functional goals

| Goal | How it is checked in `performance.spec.ts` |
| --- | --- |
| No flash on startup | First-frame colors in both themes, and layout shift below 0.02 |
| No flicker from polling | Zero DOM mutations across multiple 5 second polls |
| Smooth dragging | 120 pointer moves, with no long task above 120 ms, p95 frame under 50 ms, and no mutation in other slides |
| Responsive typing | No mutation in the deck while typing in the script |
| Smooth downloads | High-frequency progress with no long task above 150 ms |
| Responsive layout | `responsive.spec.ts`, from 1920px down to 420px with no horizontal overflow |

## 4. Verification results

Results for the final code, on Windows 10 with an Intel i5-7400, 7.9 GB RAM and an Intel HD 630 (Tier 1, CPU inference).

| Layer | What it runs against | Result |
| --- | --- | --- |
| Spec rules | Source tree | Pass: zero emoji, lucide and tabler only at 1.5px, all 21 plan files present, all 15 tokens exact |
| TypeScript unit tests | Geometry, deck logic, diff, catalog | 39 of 39 passed |
| Rust unit tests | Hardware parsers, NDJSON, pulls, parsing, vision, storage | 51 of 51 passed |
| Playwright `web` | Production bundle in Chromium, mock daemon | 125 passed, 5 skipped as desktop-only |
| Playwright `tauri` | Release executable, mock daemon, real Windows file dialogs | 119 passed, 2 skipped as browser-only |
| Playwright `live` | Release executable, real Ollama 0.40.13 | 1 of 1 passed: `llama3.2:3b` built a deck in 120 s, `moondream` described a pin in 100 s |

### REA audit of the shipped build

REA cannot review a Markdown specification, and its own guidance is to skip it for ordinary source review, so the plan itself was reviewed by reading it. REA was used where it has authority: the shipped executable and the running app.

| Question | Finding | Evidence |
| --- | --- | --- |
| Is the executable what it should be? | 64-bit PE, 9.3 MB, with an icon group from 16 to 256px. SHA-256 `ad5fb1e3...66bf0f`. | `ev_66e7a31b...` |
| What loads at startup? | Three local scripts only: the 421 KB main bundle, a small runtime and the theme script. The export libraries are not among them, so they do not slow startup. | `ev_a0916f7d...` |
| Does the bundle call any remote API? | No endpoint candidates were found, and all three scripts parsed. REA notes that string-built URLs can escape this check. A separate search of the bundle found only the Ollama download link and React's error-page URL. | `ev_a0916f7d...` |
| Is the app quiet at runtime? | No console events during a 6 second attach window that includes a health poll, and no service workers. The attach window cannot see anything before it started. | `ev_4d62049c...` |

A byte search of the same executable found all 14 Tauri command names, both pull event names, the stream event name and the default Ollama address.

Bugs that testing found in this implementation, all now fixed: a download bar that jumped backward, a no-models banner that flashed on launch and shifted the whole workspace by 41px, model pills that briefly showed a placeholder, settings written out of order on the desktop, callouts landing on top of each other, and a slash menu that could misplace the caret.

## 5. Known limits

- **macOS is implemented but untested.** All development and testing happened on Windows. The macOS parsers are unit tested against sample output and the code compiles behind platform guards, but the app has never run on a Mac. Run the test suite on a Mac before relying on it there.
- **Local models vary in quality.** The deck structure is enforced, but the writing quality of small models on modest hardware is what it is. Tier 1 machines should expect slower and plainer results. In the live test, `moondream` was given a plain grid image and partly described the blue ring the app draws to mark the pin, rather than the content. Real screenshots and larger vision models have not been evaluated for quality.
- **One unexplained test failure.** "Deleting a pin renumbers the rest" failed once on the desktop, then passed in all 5 later runs, including 4 repeats. No cause was identified, so it may be test timing or an intermittent bug.
- **Vision detection on old daemons.** Ollama 0.40 reports each model's capabilities. For daemons that do not, the app guesses vision support from the model name and can miss some models.
- **Number keys in the presenter** count pins across the whole slide, while badges restart at 1 on each image, so on a multi-image slide the key and the badge can differ.
