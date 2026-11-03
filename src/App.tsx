import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SlideDeckCanvas } from './components/canvas/SlideDeckCanvas';
import { Sidebar } from './components/layout/Sidebar';
import { Topbar } from './components/layout/Topbar';
import { DaemonActions, ModelManagerModal } from './components/models/ModelManagerModal';
import { VipPresenterModal } from './components/presentation/VipPresenterModal';
import { ScriptStudioPane } from './components/script/ScriptStudioPane';
import { AppIcon } from './components/ui/AppIcon';
import { Toasts } from './components/ui/Toasts';
import { bridge } from './lib/bridge';
import { clamp, cn, isEditableTarget, nextFrame } from './lib/utils';
import { useDeckStore } from './store/useDeckStore';

const STACKED_QUERY = '(max-width: 899px)';
const OVERLAY_SIDEBAR_QUERY = '(max-width: 999px)';

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => matchMedia(query).matches,
  );
}

function useGlobalShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const store = useDeckStore.getState();
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;

      if (event.key === 'Enter') {
        event.preventDefault();
        if (store.presenterOpen) store.closePresenter();
        else store.openPresenter();
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        void store.flushSaves();
      } else if (event.key === '\\') {
        event.preventDefault();
        store.toggleSidebar();
      } else if (event.key === ',') {
        event.preventDefault();
        store.setModelManagerOpen(!store.modelManagerOpen);
      } else if (event.key.toLowerCase() === 'z' && !isEditableTarget(event.target) && !store.presenterOpen) {
        // Text fields keep their native undo. Everywhere else, undo affects the deck.
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

function DaemonBanner() {
  const ollama = useDeckStore((state) => state.ollama);

  if (!ollama) return null;

  if (!ollama.online) {
    return (
      <div role="status" data-testid="ollama-banner" data-kind="offline" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-warn-soft px-3 py-1.5 text-[13px]">
        <AppIcon icon="lucide:unplug" size={15} className="text-warn" />
        <span className="min-w-0 flex-1">
          {ollama.installed
            ? 'Ollama is not running. Start it to generate slides and inspect images.'
            : bridge.canLaunchOllama
              ? 'Ollama is not installed. It runs the AI models privately on this machine.'
              : 'Ollama is not reachable. Install it, or run "ollama serve" in a terminal.'}
        </span>
        <DaemonActions />
      </div>
    );
  }

  // The count comes from the status reply. The model list arrives a moment later, so using
  // its length here would flash this banner on every launch.
  if (ollama.modelCount === 0) {
    return (
      <div role="status" data-testid="ollama-banner" data-kind="no-models" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-accent-soft px-3 py-1.5 text-[13px]">
        <AppIcon icon="lucide:download" size={15} className="text-accent" />
        <span className="min-w-0 flex-1">Ollama is running, but no models are installed yet.</span>
        <button type="button" className="btn btn-outline" data-testid="banner-open-models" onClick={() => useDeckStore.getState().setModelManagerOpen(true)}>
          Choose a model
        </button>
      </div>
    );
  }

  return null;
}

function Workspace() {
  const stacked = useMediaQuery(STACKED_QUERY);
  const splitPercent = useDeckStore((state) => state.splitPercent);
  const mobilePane = useDeckStore((state) => state.mobilePane);
  const containerRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const latest = useRef(splitPercent);
  const frame = useRef<number | null>(null);
  const store = useDeckStore.getState;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    latest.current = splitPercent;
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    latest.current = clamp(((event.clientX - rect.left) / rect.width) * 100, 24, 70);
    if (frame.current === null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (leftRef.current) leftRef.current.style.width = `${latest.current}%`;
      });
    }
  };

  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    store().setSplitPercent(latest.current);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {stacked && (
        <div role="tablist" aria-label="Workspace" className="flex shrink-0 gap-1 border-b border-line p-1" data-testid="pane-tabs">
          {(['script', 'slides'] as const).map((pane) => (
            <button
              key={pane}
              type="button"
              role="tab"
              aria-selected={mobilePane === pane}
              data-testid={`pane-tab-${pane}`}
              className={cn('btn flex-1 font-normal text-ink-2', mobilePane === pane && 'bg-hover text-ink')}
              onClick={() => store().setMobilePane(pane)}
            >
              <AppIcon icon={pane === 'script' ? 'lucide:file-text' : 'lucide:presentation'} size={14} />
              {pane === 'script' ? 'Script' : 'Slides'}
            </button>
          ))}
        </div>
      )}
      <div ref={containerRef} className={cn('flex min-h-0 flex-1', dragging && 'cursor-col-resize select-none')} data-testid="workspace">
        <div
          ref={leftRef}
          className={cn('min-w-0 shrink-0', stacked && mobilePane !== 'script' && 'hidden')}
          style={{ width: stacked ? '100%' : `${splitPercent}%` }}
        >
          <ScriptStudioPane />
        </div>
        {!stacked && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panes"
            aria-valuenow={Math.round(splitPercent)}
            tabIndex={0}
            data-testid="split-handle"
            data-dragging={dragging}
            className="split-handle"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') store().setSplitPercent(clamp(splitPercent - 2, 24, 70));
              if (event.key === 'ArrowRight') store().setSplitPercent(clamp(splitPercent + 2, 24, 70));
            }}
          />
        )}
        <div className={cn('min-w-0 flex-1', stacked && mobilePane !== 'slides' && 'hidden')}>
          <SlideDeckCanvas />
        </div>
      </div>
    </div>
  );
}

function ExportProgress() {
  const job = useDeckStore((state) => state.exportJob);
  if (!job) return null;
  const finishing = job.current >= job.total;
  return (
    <div role="status" data-testid="export-progress" className="popover fade-in fixed top-14 right-3 z-[90] w-[280px] p-3">
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <AppIcon icon="lucide:loader-circle" size={14} className="spin" />
        {finishing ? `Saving ${job.format === 'pdf' ? 'PDF' : 'PowerPoint'}` : `Rendering slide ${job.current + 1} of ${job.total}`}
      </div>
      <div className="progress-track mt-2">
        <div className="progress-fill" style={{ transform: `scaleX(${job.total ? job.current / job.total : 0})` }} />
      </div>
    </div>
  );
}

export default function App() {
  const ready = useDeckStore((state) => state.ready);
  const sidebarCollapsed = useDeckStore((state) => state.sidebarCollapsed);
  const modelManagerOpen = useDeckStore((state) => state.modelManagerOpen);
  const presenterOpen = useDeckStore((state) => state.presenterOpen);
  const overlaySidebar = useMediaQuery(OVERLAY_SIDEBAR_QUERY);
  const ollamaOnline = useDeckStore((state) => state.ollama?.online ?? false);
  const textModel = useDeckStore((state) => state.activeTextModel);

  useGlobalShortcuts();

  useEffect(() => {
    void useDeckStore
      .getState()
      .bootstrap()
      .then(async () => {
        // Reveal the native window only after a fully painted frame exists.
        await nextFrame();
        await nextFrame();
        await bridge.showWindow().catch(() => undefined);
        document.documentElement.dataset.windowShown = 'true';
      });
  }, []);

  useEffect(() => {
    if (overlaySidebar) useDeckStore.setState({ sidebarCollapsed: true });
  }, [overlaySidebar]);

  if (!ready) return null;

  return (
    <>
      <div className={cn('flex h-full', presenterOpen && 'invisible')} data-testid="app-shell" data-ollama-online={ollamaOnline} data-text-model={textModel ?? ''}>
        {!sidebarCollapsed &&
          (overlaySidebar ? (
            <>
              <div className="overlay-in fixed inset-0 z-30" style={{ background: 'var(--overlay)' }} onClick={() => useDeckStore.getState().setSidebarCollapsed(true)} data-testid="sidebar-scrim" />
              <div className="fixed inset-y-0 left-0 z-40" style={{ boxShadow: 'var(--shadow-popover)' }}>
                <Sidebar />
              </div>
            </>
          ) : (
            <Sidebar />
          ))}
        <main className="flex h-full min-w-0 flex-1 flex-col">
          <Topbar />
          <DaemonBanner />
          <Workspace />
        </main>
      </div>
      {modelManagerOpen && <ModelManagerModal />}
      {presenterOpen && <VipPresenterModal />}
      <ExportProgress />
      <Toasts />
    </>
  );
}
