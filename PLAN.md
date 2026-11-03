# PROJECT SPECIFICATION: VANGUARD DECK (Tauri v2 + React + Rust + Local Ollama Vision)

Act as a Principal Desktop Systems Architect and Staff Frontend Engineer. We are building Vanguard Deck, a cross-platform (macOS & Windows) AI-powered VIP Client Presentation Assistant built on Tauri v2 (Rust Backend) and React 19 + TypeScript + Tailwind CSS (Frontend).

## 1. STRICT GLOBAL CONSTRAINTS
1. ZERO EMOJIS: Never use emojis anywhere in the UI, code comments, placeholder text, status badges, or AI system prompts. 
2. ICON SYSTEM (`https://icones.js.org/collection/all`): Use @iconify/react exclusively. Standardize on clean, 1.5px stroke monochrome vector icons from the lucide and tabler collections on Icones.js.org (e.g., lucide:file-text, lucide:cpu, lucide:pin, lucide:sparkles, lucide:check, lucide:download, lucide:sliders-horizontal, lucide:maximize-2).
3. REVERSE-ENGINEERED NOTION AESTHETIC:
   - Light Mode Tokens: Primary BG #FFFFFF, Sidebar/Secondary BG #F7F7F5, Hover Surface #EFEFED, Primary Text #37352F, Secondary Text #787774, Muted Text #9B9A97, Hairline Border #E9E9E7 (1px solid), Primary Accent #2383E2.
   - Dark Mode Tokens: Primary BG #191919, Sidebar/Secondary BG #202020, Hover Surface #2C2C2B, Primary Text #D4D4D4, Secondary Text #9B9A97, Hairline Border #2F2F2F (1px solid), Primary Accent #2383E2.
   - Typography & Layout: Inter / system sans-serif UI (-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif), crisp 1px borders, subtle 4px to 6px border radii, zero heavy drop shadows (use 0 1px 2px rgba(0,0,0,0.04) for cards and 0 4px 12px rgba(0,0,0,0.08) for floating popovers), compact 28px height action buttons, and / slash-command or top-right subtle action bars.

---

## 2. SYSTEM ARCHITECTURE & TECH STACK

### Rust Backend (src-tauri)
- Framework: Tauri v2 (tauri = "2.2", @tauri-apps/api = "^2.2")
- Plugins: tauri-plugin-fs, tauri-plugin-shell, tauri-plugin-dialog, tauri-plugin-clipboard-manager, tauri-plugin-os, tauri-plugin-sql (SQLite for local project persistence).
- Hardware Detection Crate: sysinfo + platform-specific GPU inspection:
  - macOS: Execute sysctl -n hw.memsize and system_profiler SPDisplaysDataType to detect Apple Silicon (M1/M2/M3/M4) unified memory allocation.
  - Windows: Execute WMI / nvidia-smi --query-gpu=name,memory.total --format=csv,noheader or DirectX diagnostic fallback to read dedicated VRAM + System RAM.
- Ollama Orchestrator: reqwest async HTTP client with streaming (futures-util, tokio-stream) communicating with http://127.0.0.1:11434. Emits real-time Tauri events (ollama://pull-progress, ollama://stream-chunk) to the React UI.

### Frontend (src)
- Framework: React 19, TypeScript, Vite, Tailwind CSS.
- State Management: zustand (with local SQLite/JSON auto-save sync).
- Icons: @iconify/react (strictly no emojis).
- Canvas & Annotations: Custom SVG overlay engine using normalized percentage coordinates (0.0 to 100.0%) so pins and leader lines remain pixel-accurate across window resizing and presentation mode.
- Export Engine: html-to-image + jspdf / pptxgenjs for 1-click VIP PDF & PowerPoint export with baked-in SVG callouts.

---

## 3. CORE MODULE SPECIFICATIONS

### MODULE A: Hardware Inspector & Local AI Model Manager
Build a dedicated Notion-style Settings & AI Engine Modal accessible from the sidebar footer:
1. Live Machine Specs Banner:
   - Displays CPU architecture, Total System RAM, GPU Model, and Available VRAM / Unified Memory.
   - Calculates a Hardware Tier Badge (e.g., TIER 1: ENTRY (<8GB VRAM), TIER 2: PRO (8GB-16GB VRAM), TIER 3: ULTRA (24GB+ VRAM / Apple Unified)).
2. Smart Model Recommendation Matrix:
   - Tier 1 (<8GB VRAM / 8GB RAM): Recommends moondream:1.8b (Vision) + llama3.2:3b (Text) or qwen2.5:3b.
   - Tier 2 (8-16GB VRAM / 16GB RAM): Recommends minicpm-v:8b or llava:7b (Vision) + llama3.1:8b or qwen2.5:7b (Text).
   - Tier 3 (24GB+ VRAM / 32GB+ Unified Memory): Recommends llama3.2-vision:11b or qwen2.5-vl:14b (Vision) + qwen2.5:14b / deepseek-r1:14b (Text).
3. 1-Click Ollama Lifecycle Management:
   - Daemon Health Check: Pings GET /api/tags every 5 seconds. If offline, displays a clean banner with a button to launch ollama serve via tauri-plugin-shell or download Ollama if missing.
   - Model Downloader (`POST /api/pull`): Streams download progress (status, completed, total bytes) with a sleek monochrome progress bar, transfer speed (MB/s), and cancel support.
   - Model Switcher & Updater: Separate dropdown selectors in the top header for Active Text Model and Active Vision Model, plus a "Check for Model Updates" button that re-pulls the latest digest tag from Ollama.

### MODULE B: Script-to-Presentation AI Analyzer
1. Left Pane (Script & Narrative Studio):
   - Clean Notion-like editor where the user pastes a rough script, meeting notes, or bullet points.
   - Controls for Audience Persona (C-Suite Executive, Technical Stakeholder, Design Review, Investor Pitch) and Tone (Concise & Direct, Persuasive, Analytical).
2. AI Structuring Pipeline (`POST /api/chat` with JSON Schema Enforcement):
   - Clicking "Analyze & Generate Slides" sends the script to the local Ollama model using format: "json".
   - For each slide, the AI returns:
     - slideNumber: Integer
     - originalExcerpt: The raw text segment
     - refinedTitle: Client-friendly, high-impact headline
     - executiveSummary: 2-3 crisp talking points
     - speakerNotes: Refined verbal script for the presenter
     - layoutType: "single-visual" | "split-comparison" | "multi-grid" | "statement-only"
     - dropzones: Array of pre-configured image dropbox placeholders, each containing an aiVisualPrompt explaining what screenshot, chart, or mockup the user should drop there.

### MODULE C: Smart Image Dropboxes & Clipboard Pipeline
1. Multi-Input Ingestion:
   - Each slide card contains structured dropzone containers styled with a subtle dashed border (border-dashed border-[#D3D1CB] dark:border-[#373737]).
   - Supports Drag-and-Drop (from Finder/Explorer), File Picker Dialog, and Direct Clipboard Paste (`Cmd+V` / `Ctrl+V`) when hovering or focusing a dropzone.
2. Local Asset Optimization:
   - Pasted or dropped images are saved into the app's local project directory (AppData/vanguard-deck/projects/{project_id}/assets/) via Rust, generating a fast local asset URL (convertFileSrc) and a Base64 buffer when needed for Ollama Vision inference.

### MODULE D: Interactive Pinpoint & Leader-Line Annotation Canvas
When an image is inside a dropzone, hovering reveals a sleek Notion-style floating toolbar (Add Pin, AI Vision Inspect, Replace Image, Reset Pins).
1. Adding & Positioning Pins:
   - Clicking anywhere on the image creates an Anchor Pin at normalized coordinates (anchorXPercent, anchorYPercent) and a connected Callout Card initially offset by (calloutXPercent, calloutYPercent).
   - Both the Anchor Pin on the image and the Callout Card are independently draggable.
2. SVG Leader-Line Renderer:
   - Render a responsive <svg className="pointer-events-none absolute inset-0 w-full h-full"> layer over the image container.
   - Draw a crisp 1.5px stroke leader line (either 2-segment orthogonal elbow line or smooth cubic Bezier curve) from (anchorXPercent%, anchorYPercent%) to the nearest edge of the Callout Card at (calloutXPercent%, calloutYPercent%).
   - Render a numbered monochrome badge (1, 2, 3) at the pin origin with a subtle pulse ring on hover.
3. Editable Callout Descriptions & AI Vision Assist:
   - Each Callout Card features an inline-editable title and description box styled like a Notion comment block.
   - AI Vision Auto-Describe: Clicking the lucide:sparkles icon on a Callout Card crops a region around (anchorXPercent, anchorYPercent) (along with the full image context) and sends it to the active Ollama Vision model (POST /api/chat with images: [base64]), prompting it to write a concise, client-friendly explanation of that specific UI element, chart spike, or architectural detail.


   ### MODULE E: VIP Presentation & Export Mode
- Fullscreen Presentation View (`Cmd/Ctrl + Enter`): Hides the Notion sidebar and script editor, presenting slides in a distraction-free, ultra-clean executive deck view. Clicking numbered callouts highlights the leader line and zooms smoothly into the pinned detail.
- PDF / PPTX Export: Exports the entire deck with high-DPI rendered SVG leader lines and callout boxes intact.

---

## 4. DIRECTORY STRUCTURE TO SCAFFOLD
```text
vanguard-deck/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   └── src/
│       ├── main.rs
│       ├── lib.rs
│       ├── hardware.rs       # RAM, CPU, Apple Unified Memory & NVIDIA VRAM detection
│       ├── ollama.rs         # Daemon check, model pull streaming, vision & JSON chat IPC
│       └── storage.rs        # Local project & image asset file management
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── styles/globals.css    # Notion CSS variables (Light/Dark tokens)
│   ├── types/deck.ts         # Slide, Dropzone, PinAnnotation, HardwareSpecs interfaces
│   ├── store/useDeckStore.ts # Zustand state for project, slides, pins, and AI settings
│   └── components/
│       ├── layout/
│       │   ├── Sidebar.tsx           # Notion-style collapsible project tree + AI status footer
│       │   └── Topbar.tsx            # Breadcrumbs, active model pills, Present & Export buttons
│       ├── script/
│       │   └── ScriptStudioPane.tsx  # Raw script input, tone selectors, AI refinement diff
│       ├── canvas/
│       │   ├── SlideDeckCanvas.tsx   # Vertical scrollable slide cards
│       │   ├── ImageDropzone.tsx     # Drag/drop + Clipboard Cmd+V handler
│       │   └── AnnotatedImage.tsx    # Interactive SVG pin & leader-line callout engine
│       ├── models/
│       │   └── ModelManagerModal.tsx # Hardware specs badge, recommended models, 1-click pull
│       └── presentation/
│           └── VipPresenterModal.tsx # Fullscreen interactive client presentation mode

5. STEP-BY-STEP EXECUTION PLAN FOR ANTIGRAVITY
Execute this build systematically in 5 sequential phases:

Phase 1: Foundation, Tauri v2 Config & Notion Design System
Initialize the Vite + React + TypeScript + Tailwind CSS project and configure src-tauri with tauri.conf.json (enable macOS & Windows window decorations, clipboard, shell, and fs capabilities).

Install @iconify/react, zustand, clsx, and tailwind-merge.

Create src/styles/globals.css with exact Notion Light & Dark CSS custom properties (--bg-primary, --bg-sidebar, --bg-hover, --text-primary, --text-secondary, --border-hairline, --accent-blue). Verify zero emojis exist anywhere.

Phase 2: Rust Backend — Hardware Detection & Ollama Bridge
Implement src-tauri/src/hardware.rs using sysinfo and shell probes (sysctl on macOS, nvidia-smi/wmic on Windows) exposing #[tauri::command] fn get_hardware_specs() -> HardwareProfile.

Implement src-tauri/src/ollama.rs exposing:

check_ollama_status()

list_local_models()

pull_model_stream(app: AppHandle, model_name: String) (streams progress via app.emit("ollama-pull-progress", payload))

analyze_script_to_slides(model: String, script: String, persona: String)

analyze_image_pin(vision_model: String, image_base64: String, pin_x: f32, pin_y: f32, user_hint: String)

Register all commands in src-tauri/src/lib.rs.

Phase 3: Hardware-Aware Model Manager UI
Build ModelManagerModal.tsx showing the detected CPU, RAM, GPU/VRAM, and calculated Hardware Tier.

Render the curated list of Vision and Text models with "Recommended for your hardware" badges, download size, installed status (lucide:check), and 1-click Pull/Update buttons with live progress bars.

Phase 4: Script Studio & Slide Generation Flow
Build the split-screen workspace (ScriptStudioPane.tsx on the left, SlideDeckCanvas.tsx on the right).

Wire the "Analyze & Structure Deck" button to send the user's raw script to Ollama, parse the structured JSON response, and populate editable Notion-style slide cards with pre-configured ImageDropzone slots.

Phase 5: Interactive Pin & SVG Leader-Line Callout Engine + VIP Presenter
Build ImageDropzone.tsx supporting file drag-and-drop and onPaste clipboard binary image capture.

Build AnnotatedImage.tsx:

Capture click coordinates as percentages (x%, y%).

Render the SVG overlay with orthogonal/bezier leader lines connecting each numbered image pin to its draggable floating Callout Card.

Connect the Callout Card's "AI Inspect Pin" (lucide:sparkles) button to the local Ollama Vision endpoint so the AI inspects the pinned region and auto-fills the client-friendly callout description.

Build VipPresenterModal.tsx for fullscreen client walkthroughs and PDF export.

Begin immediately with Phase 1 and Phase 2, outputting complete, production-ready, fully typed Rust and TypeScript files without placeholders.


---

## Part 3: Reference Implementation Blueprints (For Fast Debugging)

If you want to inspect or feed specific core implementations into Antigravity during the build, use these two architectural blueprints for the trickiest parts of your app: the SVG Pin/Leader-Line Canvas and the Rust Hardware + Ollama Streaming Backend.

### 1. Interactive SVG Pin & Leader-Line Component (src/components/canvas/AnnotatedImage.tsx)
This component handles placing pins on dropped/pasted images, drawing dynamic SVG leader lines, dragging callout boxes, and triggering local Ollama Vision analysis on a specific pin—using strictly Iconify icons (@iconify/react) and Notion styling.

```tsx
import React, { useState, useRef } from 'react';
import { Icon } from '@iconify/react';

export interface PinAnnotation {
  id: string;
  index: number;
  anchorX: number; // Percentage 0-100 on image
  anchorY: number; // Percentage 0-100 on image
  calloutX: number; // Percentage 0-100 for floating label box
  calloutY: number; // Percentage 0-100 for floating label box
  title: string;
  description: string;
  isAnalyzing?: boolean;
}

interface AnnotatedImageProps {
  imageUrl: string;
  pins: PinAnnotation[];
  onChangePins: (pins: PinAnnotation[]) => void;
  onRequestAiPinAnalysis: (pin: PinAnnotation) => Promise<void>;
  onRemoveImage: () => void;
}

export const AnnotatedImage: React.FC<AnnotatedImageProps> = ({
  imageUrl,
  pins,
  onChangePins,
  onRequestAiPinAnalysis,
  onRemoveImage,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPinMode, setIsPinMode] = useState<boolean>(true);
  const [draggingItem, setDraggingItem] = useState<{
    id: string;
    type: 'anchor' | 'callout';
  } | null>(null);

  const getRelativePercentage = (clientX: number, clientY: number) => {
    if (!containerRef.current) return { x: 50, y: 50 };
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(2, Math.min(98, ((clientX - rect.left) / rect.width) * 100));
    const y = Math.max(2, Math.min(98, ((clientY - rect.top) / rect.height) * 100));
    return { x, y };
  };
  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isPinMode  draggingItem) return;
    if ((e.target as HTMLElement).closest('[data-interactive="true"]')) return;

    const { x, y } = getRelativePercentage(e.clientX, e.clientY);
    // Offset the callout card toward the nearest spacious quadrant
    const calloutX = x > 55 ? Math.max(8, x - 28) : Math.min(72, x + 16);
    const calloutY = y > 55 ? Math.max(8, y - 18) : Math.min(82, y + 12);

    const newPin: PinAnnotation = {
      id: crypto.randomUUID(),
      index: pins.length + 1,
      anchorX: x,
      anchorY: y,
      calloutX,
      calloutY,
      title: `Key Detail ${pins.length + 1}`,
      description: 'Add client notes or click the AI icon to inspect this area.',
    };

    onChangePins([...pins, newPin]);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingItem) return;
    const { x, y } = getRelativePercentage(e.clientX, e.clientY);
    onChangePins(
      pins.map((pin) => {
        if (pin.id !== draggingItem.id) return pin;
        return draggingItem.type === 'anchor'
          ? { ...pin, anchorX: x, anchorY: y }
          : { ...pin, calloutX: x, calloutY: y };
      })
    );
  };

  const handlePointerUp = () => {
    setDraggingItem(null);
  };

  const updatePinField = (id: string, field: 'title' | 'description', value: string) => {
    onChangePins(pins.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  };

  const deletePin = (id: string) => {
    const filtered = pins
      .filter((p) => p.id !== id)
      .map((p, idx) => ({ ...p, index: idx + 1 }));
    onChangePins(filtered);
  };

  return (
    <div className="group relative rounded-[6px] border border-[#E9E9E7] dark:border-[#2F2F2F] bg-[#F7F7F5] dark:bg-[#202020] overflow-hidden select-none">
      {/* Notion-Style Floating Action Bar */}
      <div
        data-interactive="true"
        className="absolute top-2.5 right-2.5 z-30 flex items-center gap-1 rounded-[5px] border border-[#E9E9E7] dark:border-[#2F2F2F] bg-white/95 dark:bg-[#191919]/95 px-1.5 py-1 opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
      >
        <button
          type="button"
          onClick={() => setIsPinMode(!isPinMode)}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-[4px] text-xs font-medium transition-colors ${
            isPinMode
              ? 'bg-[#2383E2]/10 text-[#2383E2]'
              : 'text-[#37352F] dark:text-[#D4D4D4] hover:bg-[#EFEFED] dark:hover:bg-[#2C2C2B]'
          }`}
        >
          <Icon icon="lucide:map-pin" className="w-3.5 h-3.5" />
          <span>{isPinMode ? 'Pin Mode Active' : 'Enable Pinning'}</span>
        </button>

        <div className="h-3.5 w-[1px] bg-[#E9E9E7] dark:bg-[#2F2F2F]" />

        <button
          type="button"
          onClick={onRemoveImage}
          className="flex items-center gap-1 px-2 py-1 rounded-[4px] text-xs text-[#787774] hover:text-red-600 hover:bg-[#EFEFED] dark:hover:bg-[#2C2C2B] transition-colors"
          title="Remove Image"
        >
          <Icon icon="lucide:trash-2" className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Main Interactive Canvas */}
      <div
        ref={containerRef}
        onClick={handleCanvasClick}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        className={`relative w-full ${isPinMode ? 'cursor-crosshair' : 'cursor-default'}`}
      >
        <img
          src={imageUrl}
          alt="Slide Visual"
          className="w-full h-auto block pointer-events-none"
        />

        {/* SVG Leader Lines Overlay */}
        <svg className="pointer-events-none absolute inset-0 w-full h-full z-10">
          {pins.map((pin) => {
            // Draw an elbow leader line from Anchor (anchorX, anchorY) to Callout (calloutX, calloutY)
            const midX = (pin.anchorX + pin.calloutX) / 2;
            return (
              <g key={`line-${pin.id}`}>
                {/* Outer contrast stroke for visibility over any image */}
                <polyline
                  points={`${pin.anchorX}%,${pin.anchorY}% ${midX}%,${pin.calloutY}% ${pin.calloutX}%,${pin.calloutY}%`}
                  fill="none"
                  stroke="rgba(255,255,255,0.85)"
                  strokeWidth="3.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {/* Crisp inner leader line */}
                <polyline
                  points={`${pin.anchorX}%,${pin.anchorY}% ${midX}%,${pin.calloutY}% ${pin.calloutX}%,${pin.calloutY}%`}
                  fill="none"
                  stroke="#2383E2"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            );
          })}
        </svg>

        {/* Pin Anchor Points */}
        {pins.map((pin) => (
          <div
            key={`anchor-${pin.id}`}
            data-interactive="true"
            onPointerDown={(e) => {
              e.stopPropagation();
              setDraggingItem({ id: pin.id, type: 'anchor' });
            }}
            style={{ left: `${pin.anchorX}%`, top: `${pin.anchorY}%` }}
            className="absolute z-20 -translate-x-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-[#2383E2] text-white border-2 border-white dark:border-[#191919] flex items-center justify-center text-[11px] font-semibold cursor-grab active:cursor-grabbing shadow-sm"
          >
            {pin.index}
          </div>
        ))}

        {/* Floating Callout Comment Boxes */}
        {pins.map((pin) => (
          <div
            key={`callout-${pin.id}`}
            data-interactive="true"
            style={{ left: `${pin.calloutX}%`, top: `${pin.calloutY}%` }}
            className="absolute z-20 -translate-y-1/2 w-60 rounded-[6px] border border-[#E9E9E7] dark:border-[#2F2F2F] bg-white/95 dark:bg-[#191919]/95 backdrop-blur-sm p-2.5 shadow-sm"
          >
            {/* Callout Header / Drag Handle */}
            <div
              onPointerDown={(e) => {
                e.stopPropagation();
                setDraggingItem({ id: pin.id, type: 'callout' });
              }}
              className="flex items-center justify-between gap-1.5 pb-1.5 mb-1.5 border-b border-[#E9E9E7] dark:border-[#2F2F2F] cursor-grab active:cursor-grabbing"
            >
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-[3px] bg-[#2383E2]/15 text-[#2383E2] text-[10px] font-semibold shrink-0">
                  {pin.index}
                </span>
                <input
                  type="text"
                  value={pin.title}
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) => updatePinField(pin.id, 'title', e.target.value)}
                  className="w-full bg-transparent text-xs font-semibold text-[#37352F] dark:text-[#D4D4D4] focus:outline-none"
                />
              </div>

              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onRequestAiPinAnalysis(pin)}
                  disabled={pin.isAnalyzing}
                  title="Analyze this pinned region with Local Vision AI"
                  className="p-1 rounded-[4px] text-[#787774] hover:text-[#2383E2] hover:bg-[#EFEFED] dark:hover:bg-[#2C2C2B] transition-colors"
                >
                  <Icon
                    icon={pin.isAnalyzing ? 'lucide:loader-2' : 'lucide:sparkles'}
                    className={`w-3.5 h-3.5 ${pin.isAnalyzing ? 'animate-spin text-[#2383E2]' : ''}`}
                  />
                </button>
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => deletePin(pin.id)}
                  title="Delete Callout"
                  className="p-1 rounded-[4px] text-[#787774] hover:text-red-600 hover:bg-[#EFEFED] dark:hover:bg-[#2C2C2B] transition-colors"
                >
                  <Icon icon="lucide:x" className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Editable Description */}
            <textarea
              rows={2}
              value={pin.description}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => updatePinField(pin.id, 'description', e.target.value)}
              className="w-full resize-none bg-transparent text-[11px] leading-relaxed text-[#787774] dark:text-[#9B9A97] focus:text-[#37352F] dark:focus:text-[#D4D4D4] focus:outline-none"
            />
          </div>
        ))}
      </div>
    </div>
  );
};
2. Rust Hardware Inspector & Model Recommender (src-tauri/src/hardware.rs)
This Rust module inspects the user's Mac or Windows machine, detects available Unified Memory or dedicated GPU VRAM, and returns tailored local Ollama Vision & Text model recommendations.

Rust
use serde::Serialize;
use std::process::Command;
use sysinfo::System;

#[derive(Debug, Serialize, Clone)]
pub struct ModelRecommendation {
    pub id: String,
    pub display_name: String,
    pub role: String, // "vision" | "text"
    pub size_gb: f32,
    pub reason: String,
    pub recommended: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct HardwareProfile {
    pub os_name: String,
    pub cpu_brand: String,
    pub total_ram_gb: f32,
    pub gpu_name: String,
    pub vram_gb: f32,
    pub is_unified_memory: bool,
    pub tier: String,
    pub recommendations: Vec<ModelRecommendation>,
}

#[tauri::command]
pub fn get_hardware_specs() -> HardwareProfile {
    let mut sys = System::new_all();
    sys.refresh_all();

    let total_ram_gb = (sys.total_memory() as f64 / 1_073_741_824.0) as f32;
    let cpu_brand = sys
        .cpus()
        .first()
        .map(|cpu| cpu.brand().to_string())
        .unwrap_or_else( "Generic Processor".to_string());
    let os_name = std::env::consts::OS.to_string();

    let (gpu_name, vram_gb, is_unified_memory) = detect_gpu(&os_name, &cpu_brand, total_ram_gb);

    // Determine effective AI memory budget
    let effective_vram = if is_unified_memory {
        total_ram_gb * 0.70 // macOS Metal allows ~70-75% unified RAM allocation
    } else if vram_gb > 0.0 {
        vram_gb
    } else {
        total_ram_gb * 0.45 // CPU fallback
    };

    let tier = if effective_vram >= 18.0 {
        "TIER 3: EXECUTIVE WORKSTATION".to_string()
    } else if effective_vram >= 8.0 {
        "TIER 2: PRO PERFORMANCE".to_string()
    } else {
        "TIER 1: COMPACT EFFICIENCY".to_string()
    };

    let recommendations = build_recommendations(effective_vram);

    HardwareProfile {
        os_name,
        cpu_brand,
        total_ram_gb: (total_ram_gb * 10.0).round() / 10.0,
        gpu_name,
        vram_gb: (effective_vram * 10.0).round() / 10.0,
        is_unified_memory,
        tier,
        recommendations,
    }
}

fn detect_gpu(os_name: &str, cpu_brand: &str, total_ram_gb: f32) -> (String, f32, bool) {
    if os_name == "macos" && cpu_brand.contains("Apple") {
        return (
            format!("{} Integrated Metal GPU", cpu_brand),
            total_ram_gb,
            true,
        );
    }

    if os_name == "windows" {
        // Attempt NVIDIA SMI first for exact VRAM
        if let Ok(output) = Command::new("nvidia-smi")
            .args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(first_line) = stdout.lines().next() {
                    let parts: Vec<&str> = first_line.split(',').collect();
                    if parts.len() == 2 {
                        let name = parts[0].trim().to_string();
                        let vram_mb: f32 = parts[1].trim().parse().unwrap_or(0.0);
                        return (name, vram_mb / 1024.0, false);
                    }
                }
            }
        }
    }

    ("System Accelerated Graphics".to_string(), 0.0, false)
}

fn build_recommendations(effective_vram: f32) -> Vec<ModelRecommendation> {
    vec![
        ModelRecommendation {
            id: "moondream:1.8b".to_string(),
            display_name: "Moondream 2 (1.8B Vision)".to_string(),
            role: "vision".to_string(),
            size_gb: 1.7,
            reason: "Ultra-fast UI & image pin analysis for lightweight machines.".to_string(),
            recommended: effective_vram < 8.0,
        },
        ModelRecommendation {
            id: "minicpm-v:8b".to_string(),
            display_name: "MiniCPM-V 2.6 (8B Vision)".to_string(),
            role: "vision".to_string(),
            size_gb: 5.5,
            reason: "Superior OCR, chart reading, and UI pin description accuracy.".to_string(),
            recommended: (8.0..18.0).contains(&effective_vram),
        },
        ModelRecommendation {
            id: "llama3.2-vision:11b".to_string(),
            display_name: "Llama 3.2 Vision (11B)".to_string(),
            role: "vision".to_string(),
            size_gb: 7.9,
            reason: "Flagship executive visual reasoning and diagram analysis.".to_string(),
            recommended: effective_vram >= 18.0,
        },
        ModelRecommendation {
            id: "qwen2.5:3b".to_string(),
            display_name: "Qwen 2.5 (3B Text)".to_string(),
            role: "text".to_string(),
            size_gb: 2.0,
            reason: "Fast script-to-slide JSON structuring on low memory.".to_string(),
            recommended: effective_vram < 8.0,
        },
        ModelRecommendation {
            id: "qwen2.5:7b".to_string(),
            display_name: "Qwen 2.5 (7B Text)".to_string(),
            role: "text".to_string(),
            size_gb: 4.7,
            reason: "Balanced executive copywriting and reliable JSON slide generation.".to_string(),
            recommended: (8.0..18.0).contains(&effective_vram),
        },
        ModelRecommendation {
            id: "qwen2.5:14b".to_string(),
            display_name: "Qwen 2.5 (14B Text)".to_string(),
            role: "text".to_string(),
            size_gb: 9.0,
            reason: "Near-cloud quality narrative restructuring for VIP pitches.".to_string(),
            recommended: effective_vram >= 18.0,
        },
    ]
}