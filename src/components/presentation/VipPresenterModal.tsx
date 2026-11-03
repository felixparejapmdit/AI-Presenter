import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../../lib/bridge';
import { zoomToBox, type Rect } from '../../lib/leader';
import { cn } from '../../lib/utils';
import { selectActiveProject, useDeckStore } from '../../store/useDeckStore';
import type { ImageAsset } from '../../types/deck';
import { AppIcon } from '../ui/AppIcon';
import { STAGE_HEIGHT, STAGE_WIDTH, SlideStage } from './SlideStage';

const CONTROLS_IDLE_MS = 2600;
const NOTES_WIDTH = 340;
const ZOOM_MAX_SCALE = 2.6;
const ZOOM_MARGIN = 28;

/** Offsets within the zoom layer are unaffected by transforms, so they stay exact mid-zoom. */
function offsetWithin(element: HTMLElement, ancestor: HTMLElement): { left: number; top: number } {
  let left = 0;
  let top = 0;
  let current: HTMLElement | null = element;
  while (current && current !== ancestor) {
    left += current.offsetLeft;
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return { left, top };
}

export function VipPresenterModal() {
  const project = useDeckStore(selectActiveProject);
  const rawIndex = useDeckStore((state) => state.presenterIndex);
  const leaderStyle = useDeckStore((state) => state.leaderStyle);
  const exporting = useDeckStore((state) => state.exportJob !== null);
  const store = useDeckStore.getState;

  const [activePinId, setActivePinId] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);

  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const idleTimer = useRef<number | null>(null);

  const slides = useMemo(() => project?.slides ?? [], [project]);
  // The deck can shrink while presenting, when an analysis finishes or a project is removed.
  const index = Math.min(rawIndex, Math.max(0, slides.length - 1));
  const slide = slides[index] ?? null;
  const projectId = project?.id ?? '';
  const pins = useMemo(() => slide?.dropzones.flatMap((zone) => zone.pins) ?? [], [slide]);

  const resolveUrl = useCallback((asset: ImageAsset) => bridge.assetUrl(projectId, asset), [projectId]);

  // Fitting the stage is written straight to style, so resizing does not re-render the slide.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const stage = stageRef.current;
    if (!viewport || !stage) return;
    const fit = () => {
      const scale = Math.min(viewport.clientWidth / STAGE_WIDTH, viewport.clientHeight / STAGE_HEIGHT);
      const left = (viewport.clientWidth - STAGE_WIDTH * scale) / 2;
      const top = (viewport.clientHeight - STAGE_HEIGHT * scale) / 2;
      stage.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
      stage.dataset.scale = scale.toFixed(4);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  // Zooming animates only a transform, which the compositor can run without layout work.
  useLayoutEffect(() => {
    const layer = zoomRef.current;
    if (!layer) return;
    if (!activePinId) {
      layer.style.transform = 'translate(0px, 0px) scale(1)';
      layer.dataset.zoomed = 'false';
      return;
    }
    const anchor = layer.querySelector<HTMLElement>(`[data-testid="pin-anchor"][data-pin-id="${activePinId}"]`);
    const card = layer.querySelector<HTMLElement>(`[data-testid="callout-card"][data-pin-id="${activePinId}"]`);
    const canvas = anchor?.closest<HTMLElement>('.annotated-canvas');
    if (!anchor || !card || !canvas) return;

    const origin = offsetWithin(canvas, layer);
    const pin = pins.find((candidate) => candidate.id === activePinId);
    if (!pin) return;
    const anchorX = origin.left + (pin.anchorXPercent / 100) * canvas.clientWidth;
    const anchorY = origin.top + (pin.anchorYPercent / 100) * canvas.clientHeight;
    const cardX = origin.left + (pin.calloutXPercent / 100) * canvas.clientWidth;
    const cardY = origin.top + (pin.calloutYPercent / 100) * canvas.clientHeight;

    const left = Math.min(anchorX, cardX);
    const top = Math.min(anchorY, cardY);
    const box: Rect = {
      left,
      top,
      width: Math.max(anchorX, cardX + card.offsetWidth) - left,
      height: Math.max(anchorY, cardY + card.offsetHeight) - top,
    };
    const zoom = zoomToBox(box, STAGE_WIDTH, STAGE_HEIGHT, ZOOM_MAX_SCALE, ZOOM_MARGIN);
    layer.style.transform = `translate(${zoom.translateX}px, ${zoom.translateY}px) scale(${zoom.scale})`;
    layer.dataset.zoomed = 'true';
  }, [activePinId, pins]);

  useEffect(() => {
    if (slides.length === 0) store().closePresenter();
    else if (rawIndex !== index) store().setPresenterIndex(index);
  }, [slides.length, rawIndex, index, store]);

  const goTo = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(slides.length - 1, next));
      if (clamped !== useDeckStore.getState().presenterIndex) {
        setActivePinId(null);
        store().setPresenterIndex(clamped);
      }
    },
    [slides.length, store],
  );

  const togglePin = useCallback((pinId: string) => setActivePinId((current) => (current === pinId ? null : pinId)), []);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS);
  }, []);

  useEffect(() => {
    rootRef.current?.focus();
    showControls();
    return () => {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    };
  }, [showControls]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
          event.preventDefault();
          goTo(useDeckStore.getState().presenterIndex + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
          event.preventDefault();
          goTo(useDeckStore.getState().presenterIndex - 1);
          break;
        case 'Home':
          event.preventDefault();
          goTo(0);
          break;
        case 'End':
          event.preventDefault();
          goTo(slides.length - 1);
          break;
        case 'n':
        case 'N':
          setNotesOpen((value) => !value);
          break;
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          setActivePinId((current) => {
            if (!current) store().closePresenter();
            return null;
          });
          break;
        default:
          if (/^[1-9]$/.test(event.key)) {
            const pin = pins[Number(event.key) - 1];
            if (pin) togglePin(pin.id);
          }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [goTo, pins, slides.length, store, togglePin]);

  // In browser mode the Escape key leaves fullscreen before the page can see it.
  useEffect(() => {
    if (bridge.kind !== 'web') return;
    let wasFullscreen = Boolean(document.fullscreenElement);
    const onChange = () => {
      if (wasFullscreen && !document.fullscreenElement) store().closePresenter();
      wasFullscreen = Boolean(document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [store]);

  // Decoding the neighbouring slides ahead of time makes the next transition instant.
  useEffect(() => {
    for (const neighbour of [slides[index + 1], slides[index - 1]]) {
      for (const zone of neighbour?.dropzones ?? []) {
        if (zone.image) {
          const preload = new Image();
          preload.src = resolveUrl(zone.image);
          void preload.decode().catch(() => undefined);
        }
      }
    }
  }, [index, slides, resolveUrl]);

  if (!slide) return null;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="VIP presentation"
      data-testid="presenter"
      data-controls={controlsVisible}
      className={cn('fixed inset-0 z-50 flex bg-surface outline-none', !controlsVisible && 'cursor-none')}
      onPointerMove={showControls}
    >
      <div
        ref={viewportRef}
        className="relative h-full min-w-0 flex-1 overflow-hidden"
        data-testid="presenter-viewport"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest('[data-interactive="true"]')) setActivePinId(null);
        }}
      >
        <div ref={stageRef} className="slide-stage" data-testid="slide-stage">
          <div ref={zoomRef} className="zoom-layer" data-testid="zoom-layer" data-zoomed="false">
            <div key={slide.id} className="slide-fade h-full w-full">
              <SlideStage slide={slide} leaderStyle={leaderStyle} resolveUrl={resolveUrl} activePinId={activePinId} onActivatePin={togglePin} />
            </div>
          </div>
        </div>

        <div
          data-testid="presenter-controls"
          className={cn(
            'popover absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-0.5 p-1 transition-opacity duration-200',
            controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" className="btn btn-icon" aria-label="Previous slide" title="Previous slide" data-testid="presenter-prev" disabled={index === 0} onClick={() => goTo(index - 1)}>
            <AppIcon icon="lucide:chevron-left" />
          </button>
          <span className="min-w-[56px] px-1 text-center text-xs text-ink-2 tabular-nums" data-testid="presenter-counter">
            {index + 1} / {slides.length}
          </span>
          <button type="button" className="btn btn-icon" aria-label="Next slide" title="Next slide" data-testid="presenter-next" disabled={index === slides.length - 1} onClick={() => goTo(index + 1)}>
            <AppIcon icon="lucide:chevron-right" />
          </button>
          <div className="mx-0.5 h-4 w-px bg-line" />
          <button type="button" className={cn('btn btn-icon', notesOpen && 'btn-active')} aria-label="Speaker notes" aria-pressed={notesOpen} title="Speaker notes (N)" data-testid="presenter-notes" onClick={() => setNotesOpen((value) => !value)}>
            <AppIcon icon="lucide:mic" />
          </button>
          <button type="button" className="btn btn-icon" aria-label="Export PDF" title="Export PDF" data-testid="presenter-export" disabled={exporting} onClick={() => void store().exportDeck('pdf')}>
            <AppIcon icon={exporting ? 'lucide:loader-circle' : 'lucide:download'} className={exporting ? 'spin' : undefined} />
          </button>
          <button type="button" className="btn btn-icon" aria-label="Exit presentation" title="Exit (Esc)" data-testid="presenter-exit" onClick={() => store().closePresenter()}>
            <AppIcon icon="lucide:x" />
          </button>
        </div>
      </div>

      {notesOpen && (
        <aside aria-label="Speaker notes" data-testid="presenter-notes-panel" className="h-full shrink-0 overflow-y-auto border-l border-line bg-sidebar p-4" style={{ width: NOTES_WIDTH }}>
          <h2 className="section-label">Speaker notes</h2>
          <p className="mt-2 text-[15px] leading-relaxed whitespace-pre-wrap">{slide.speakerNotes || 'No notes for this slide.'}</p>
        </aside>
      )}
    </div>
  );
}
