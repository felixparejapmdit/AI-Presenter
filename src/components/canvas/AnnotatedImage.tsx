import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { bezierPath, clampAnchorPercent, clampCardPosition, elbowPath, nearestEdgePoint, type Point } from '../../lib/leader';
import { clamp, cn } from '../../lib/utils';
import type { LeaderStyle, PinAnnotation } from '../../types/deck';
import { AppIcon } from '../ui/AppIcon';

export interface PinHandlers {
  onAddPin: (x: number, y: number) => void;
  onMovePin: (pinId: string, patch: Partial<Pick<PinAnnotation, 'anchorXPercent' | 'anchorYPercent' | 'calloutXPercent' | 'calloutYPercent'>>) => void;
  onEditPin: (pinId: string, patch: Partial<Pick<PinAnnotation, 'title' | 'description'>>) => void;
  onDeletePin: (pinId: string) => void;
  onDescribePin: (pinId: string) => void;
  onCancelDescribe: (pinId: string) => void;
  onInspect: () => void;
  onReplace: () => void;
  onResetPins: () => void;
  onRemoveImage: () => void;
  onExpand?: () => void;
}

interface AnnotatedImageProps {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  alt: string;
  pins: PinAnnotation[];
  leaderStyle: LeaderStyle;
  /** Omit for the read-only surface used by the presenter and export. */
  handlers?: PinHandlers;
  liveDescriptions?: Record<string, { live: string } | undefined>;
  activePinId?: string | null;
  onActivatePin?: (pinId: string) => void;
}

interface DragState {
  pinId: string;
  kind: 'anchor' | 'callout';
  pointerId: number;
  element: HTMLElement;
  rect: DOMRect;
  grabX: number;
  grabY: number;
  startClientX: number;
  startClientY: number;
  moved: boolean;
  x: number;
  y: number;
  lastClientX: number;
  lastClientY: number;
}

interface PinElements {
  anchor?: HTMLElement | null;
  card?: HTMLElement | null;
  halo?: SVGPathElement | null;
  line?: SVGPathElement | null;
}

const DRAG_THRESHOLD_PX = 3;

/**
 * The pin and leader-line engine.
 *
 * Geometry is written straight to the DOM during drags and resizes, outside React, so a
 * move costs one path update rather than a component tree render. React only hears about
 * a drag when it ends. Reads are batched before writes to avoid layout thrashing.
 */
export const AnnotatedImage = memo(function AnnotatedImage({
  imageUrl,
  imageWidth,
  imageHeight,
  alt,
  pins,
  leaderStyle,
  handlers,
  liveDescriptions,
  activePinId,
  onActivatePin,
}: AnnotatedImageProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, PinElements>());
  const positions = useRef(new Map<string, { ax: number; ay: number; cx: number; cy: number }>());
  const drag = useRef<DragState | null>(null);
  const dragFrame = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const leaderStyleRef = useRef(leaderStyle);
  leaderStyleRef.current = leaderStyle;

  const [pinMode, setPinMode] = useState(true);
  const readOnly = !handlers;

  positions.current.clear();
  for (const pin of pins) {
    positions.current.set(pin.id, { ax: pin.anchorXPercent, ay: pin.anchorYPercent, cx: pin.calloutXPercent, cy: pin.calloutYPercent });
  }

  const elementsFor = useCallback((id: string): PinElements => {
    let entry = elements.current.get(id);
    if (!entry) {
      entry = {};
      elements.current.set(id, entry);
    }
    return entry;
  }, []);

  /** Redraws every leader line, keeping cards in view without touching stored coordinates. */
  const drawLines = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;

    const toUnits = (point: Point): Point => ({ x: (point.x / width) * 100, y: (point.y / height) * 100 });

    const measured: { id: string; card: HTMLElement; cardWidth: number; cardHeight: number }[] = [];
    for (const pin of pinsRef.current) {
      const card = elements.current.get(pin.id)?.card;
      if (card) measured.push({ id: pin.id, card, cardWidth: card.offsetWidth, cardHeight: card.offsetHeight });
    }

    for (const { id, card, cardWidth, cardHeight } of measured) {
      const position = positions.current.get(id);
      const parts = elements.current.get(id);
      if (!position || !parts?.line || !parts.halo) continue;

      const rawLeft = (position.cx / 100) * width;
      const rawTop = (position.cy / 100) * height;
      const clamped = clampCardPosition(rawLeft, rawTop, cardWidth, cardHeight, width, height);
      const offsetX = clamped.x - rawLeft;
      const offsetY = clamped.y - rawTop;
      const transform = offsetX !== 0 || offsetY !== 0 ? `translate(${offsetX}px, ${offsetY}px)` : '';
      if (card.style.transform !== transform) card.style.transform = transform;

      const anchor: Point = { x: (position.ax / 100) * width, y: (position.ay / 100) * height };
      const target = nearestEdgePoint(anchor, { left: clamped.x, top: clamped.y, width: cardWidth, height: cardHeight });
      const path = leaderStyleRef.current === 'bezier' ? bezierPath(anchor, target, toUnits) : elbowPath(anchor, target, toUnits);
      parts.line.setAttribute('d', path);
      parts.halo.setAttribute('d', path);
    }
  }, []);

  // Draw before paint whenever pins or style change, so a line can never lag a card.
  useLayoutEffect(() => {
    drawLines();
  }, [pins, leaderStyle, drawLines]);

  // ResizeObserver callbacks run before paint, so lines track resizes in the same frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => drawLines());
    observer.observe(canvas);
    for (const parts of elements.current.values()) {
      if (parts.card) observer.observe(parts.card);
    }
    return () => observer.disconnect();
  }, [pins.length, drawLines]);

  const applyDrag = useCallback(() => {
    dragFrame.current = null;
    const state = drag.current;
    if (!state) return;
    const { rect } = state;
    if (rect.width === 0 || rect.height === 0) return;

    const position = positions.current.get(state.pinId);
    const parts = elements.current.get(state.pinId);
    if (!position || !parts) return;

    if (state.kind === 'anchor') {
      state.x = clampAnchorPercent(((state.lastClientX - rect.left) / rect.width) * 100);
      state.y = clampAnchorPercent(((state.lastClientY - rect.top) / rect.height) * 100);
      position.ax = state.x;
      position.ay = state.y;
      if (parts.anchor) {
        parts.anchor.style.left = `${state.x}%`;
        parts.anchor.style.top = `${state.y}%`;
      }
    } else {
      state.x = clamp(((state.lastClientX - state.grabX - rect.left) / rect.width) * 100, 0, 100);
      state.y = clamp(((state.lastClientY - state.grabY - rect.top) / rect.height) * 100, 0, 100);
      position.cx = state.x;
      position.cy = state.y;
      if (parts.card) {
        parts.card.style.left = `${state.x}%`;
        parts.card.style.top = `${state.y}%`;
      }
    }
    drawLines();
  }, [drawLines]);

  const beginDrag = (event: React.PointerEvent<HTMLElement>, pin: PinAnnotation, kind: 'anchor' | 'callout') => {
    if (readOnly || event.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    event.stopPropagation();
    event.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const card = elements.current.get(pin.id)?.card;
    const cardRect = kind === 'callout' ? card?.getBoundingClientRect() : null;
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);

    const position = positions.current.get(pin.id)!;
    drag.current = {
      pinId: pin.id,
      kind,
      pointerId: event.pointerId,
      element,
      rect,
      grabX: cardRect ? event.clientX - cardRect.left : 0,
      grabY: cardRect ? event.clientY - cardRect.top : 0,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
      x: kind === 'anchor' ? position.ax : position.cx,
      y: kind === 'anchor' ? position.ay : position.cy,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
    };
  };

  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    state.lastClientX = event.clientX;
    state.lastClientY = event.clientY;
    if (!state.moved && Math.hypot(event.clientX - state.startClientX, event.clientY - state.startClientY) < DRAG_THRESHOLD_PX) return;
    state.moved = true;
    if (dragFrame.current === null) dragFrame.current = requestAnimationFrame(applyDrag);
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (dragFrame.current !== null) {
      cancelAnimationFrame(dragFrame.current);
      applyDrag();
    }
    if (state.element.hasPointerCapture(event.pointerId)) state.element.releasePointerCapture(event.pointerId);
    drag.current = null;

    if (state.moved) {
      // The browser fires a click after pointerup, which must not create a pin.
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 50);
      handlers?.onMovePin(
        state.pinId,
        state.kind === 'anchor'
          ? { anchorXPercent: state.x, anchorYPercent: state.y }
          : { calloutXPercent: state.x, calloutYPercent: state.y },
      );
    } else if (state.kind === 'anchor') {
      onActivatePin?.(state.pinId);
    }
  };

  const onCanvasClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly || !pinMode || suppressClick.current) return;
    if ((event.target as HTMLElement).closest('[data-interactive="true"]')) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    handlers.onAddPin(((event.clientX - rect.left) / rect.width) * 100, ((event.clientY - rect.top) / rect.height) * 100);
  };

  const onAnchorKeyDown = (event: React.KeyboardEvent<HTMLElement>, pin: PinAnnotation) => {
    if (readOnly) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onActivatePin?.(pin.id);
      }
      return;
    }
    const step = event.shiftKey ? 2 : 0.5;
    const nudge: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = nudge[event.key];
    if (delta) {
      event.preventDefault();
      handlers.onMovePin(pin.id, {
        anchorXPercent: clampAnchorPercent(pin.anchorXPercent + delta[0]),
        anchorYPercent: clampAnchorPercent(pin.anchorYPercent + delta[1]),
      });
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      handlers.onDeletePin(pin.id);
    }
  };

  const stateFor = (pinId: string): 'active' | 'dim' | 'idle' => {
    if (!activePinId) return 'idle';
    return pinId === activePinId ? 'active' : 'dim';
  };

  const frameStyle = { '--image-ratio': imageWidth / imageHeight } as React.CSSProperties;

  return (
    <div className="annotated-frame relative max-w-full overflow-hidden rounded-[6px] border border-line bg-sidebar" style={frameStyle}>
      <div
        ref={canvasRef}
        className="annotated-canvas select-none"
        data-testid="annotated-canvas"
        data-pin-mode={!readOnly && pinMode}
        onClick={onCanvasClick}
      >
        <img src={imageUrl} alt={alt} draggable={false} decoding="async" />

        <svg className="leader-layer pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {pins.map((pin) => (
            <g key={pin.id} className="leader-group" data-pin={pin.id} data-state={stateFor(pin.id)}>
              <path
                className="leader-halo"
                ref={(node) => {
                  elementsFor(pin.id).halo = node;
                }}
              />
              <path
                className="leader-line"
                data-testid="leader-line"
                ref={(node) => {
                  elementsFor(pin.id).line = node;
                }}
              />
            </g>
          ))}
        </svg>

        {pins.map((pin) => {
          const job = liveDescriptions?.[pin.id];
          const analyzing = Boolean(job);
          return (
            <PinView
              key={pin.id}
              pin={pin}
              readOnly={readOnly}
              state={stateFor(pin.id)}
              analyzing={analyzing}
              liveText={job?.live ?? ''}
              anchorRef={(node) => {
                elementsFor(pin.id).anchor = node;
              }}
              cardRef={(node) => {
                elementsFor(pin.id).card = node;
                if (!node) elements.current.delete(pin.id);
              }}
              onAnchorPointerDown={(event) => beginDrag(event, pin, 'anchor')}
              onHeaderPointerDown={(event) => beginDrag(event, pin, 'callout')}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onAnchorKeyDown={(event) => onAnchorKeyDown(event, pin)}
              onActivate={() => onActivatePin?.(pin.id)}
              onEdit={(patch) => handlers?.onEditPin(pin.id, patch)}
              onDelete={() => handlers?.onDeletePin(pin.id)}
              onDescribe={() => (analyzing ? handlers?.onCancelDescribe(pin.id) : handlers?.onDescribePin(pin.id))}
            />
          );
        })}
      </div>

      {handlers && (
        <div
          data-interactive="true"
          data-testid="image-toolbar"
          className="image-toolbar absolute top-2 right-2 z-30 flex items-center gap-0.5 rounded-[5px] border border-line p-0.5"
          style={{ background: 'var(--glass)', boxShadow: 'var(--shadow-popover)' }}
        >
          <ToolbarButton
            icon="lucide:map-pin"
            label="Add Pin"
            active={pinMode}
            title={pinMode ? 'Pin mode is on. Click the image to add a pin.' : 'Turn on pin mode'}
            onClick={() => setPinMode((value) => !value)}
          />
          <ToolbarButton icon="lucide:sparkles" label="AI Vision Inspect" title="Describe this image with the local vision model" onClick={handlers.onInspect} />
          <ToolbarButton icon="lucide:replace" label="Replace Image" title="Replace the image and keep its pins" onClick={handlers.onReplace} />
          <ToolbarButton icon="lucide:rotate-ccw" label="Reset Pins" title="Remove every pin from this image" onClick={handlers.onResetPins} disabled={pins.length === 0} />
          <div className="mx-0.5 h-3.5 w-px bg-line" />
          {handlers.onExpand && <ToolbarButton icon="lucide:maximize-2" title="Annotate in a larger view" onClick={handlers.onExpand} iconOnly label="Expand" />}
          <ToolbarButton icon="lucide:trash-2" title="Remove image" onClick={handlers.onRemoveImage} iconOnly label="Remove image" danger />
        </div>
      )}
    </div>
  );
});

interface ToolbarButtonProps {
  icon: string;
  label: string;
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  iconOnly?: boolean;
  danger?: boolean;
}

function ToolbarButton({ icon, label, title, onClick, active, disabled, iconOnly, danger }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn('btn px-1.5 text-xs text-ink', active && 'btn-active', danger && 'btn-danger')}
    >
      <AppIcon icon={icon} size={14} />
      {!iconOnly && <span className="toolbar-label">{label}</span>}
    </button>
  );
}

interface PinViewProps {
  pin: PinAnnotation;
  readOnly: boolean;
  state: 'active' | 'dim' | 'idle';
  analyzing: boolean;
  liveText: string;
  anchorRef: (node: HTMLElement | null) => void;
  cardRef: (node: HTMLElement | null) => void;
  onAnchorPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onHeaderPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onAnchorKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  onActivate: () => void;
  onEdit: (patch: Partial<Pick<PinAnnotation, 'title' | 'description'>>) => void;
  onDelete: () => void;
  onDescribe: () => void;
}

function PinView({
  pin,
  readOnly,
  state,
  analyzing,
  liveText,
  anchorRef,
  cardRef,
  onAnchorPointerDown,
  onHeaderPointerDown,
  onPointerMove,
  onPointerUp,
  onAnchorKeyDown,
  onActivate,
  onEdit,
  onDelete,
  onDescribe,
}: PinViewProps) {
  const anchorStyle = { left: `${pin.anchorXPercent}%`, top: `${pin.anchorYPercent}%` };
  const cardStyle = { left: `${pin.calloutXPercent}%`, top: `${pin.calloutYPercent}%` };

  return (
    <>
      <div
        ref={anchorRef}
        role="button"
        tabIndex={0}
        aria-label={`Pin ${pin.index}: ${pin.title}`}
        data-interactive="true"
        data-testid="pin-anchor"
        data-pin-id={pin.id}
        data-active={state === 'active'}
        className="pin-anchor"
        style={anchorStyle}
        onPointerDown={onAnchorPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onAnchorKeyDown}
        onClick={readOnly ? onActivate : undefined}
      >
        {pin.index}
      </div>

      <div
        ref={cardRef}
        data-interactive="true"
        data-testid="callout-card"
        data-pin-id={pin.id}
        data-state={state}
        className={cn('callout-card', readOnly && 'cursor-pointer')}
        style={cardStyle}
        onClick={readOnly ? onActivate : undefined}
      >
        <div
          data-testid="callout-header"
          className={cn('flex items-center gap-1 border-b border-line pb-1', !readOnly && 'cursor-grab active:cursor-grabbing')}
          style={{ touchAction: 'none' }}
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <span
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold"
            style={{ background: 'var(--badge-bg)', color: 'var(--badge-fg)' }}
          >
            {pin.index}
          </span>
          {readOnly ? (
            <span className="min-w-0 flex-1 truncate font-semibold">{pin.title}</span>
          ) : (
            <>
              <input
                type="text"
                value={pin.title}
                aria-label="Callout title"
                data-testid="callout-title"
                onPointerDown={(event) => event.stopPropagation()}
                onChange={(event) => onEdit({ title: event.target.value })}
                className="field-plain min-w-0 flex-1 truncate font-semibold"
              />
              <button
                type="button"
                className="btn btn-icon h-5 w-5 hover:text-accent"
                data-testid="callout-ai"
                title={analyzing ? 'Stop AI Inspect Pin' : 'AI Inspect Pin: describe this region with the local vision model'}
                aria-label={analyzing ? 'Stop AI Inspect Pin' : 'AI Inspect Pin'}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={onDescribe}
              >
                <AppIcon icon={analyzing ? 'lucide:loader-circle' : 'lucide:sparkles'} size={13} className={analyzing ? 'spin text-accent' : undefined} />
              </button>
              <button
                type="button"
                className="btn btn-icon h-5 w-5 hover:text-danger"
                data-testid="callout-delete"
                title="Delete callout"
                aria-label="Delete callout"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={onDelete}
              >
                <AppIcon icon="lucide:x" size={13} />
              </button>
            </>
          )}
        </div>
        {readOnly ? (
          pin.description && <p className="mt-1 text-ink-2">{pin.description}</p>
        ) : (
          <textarea
            rows={2}
            value={analyzing ? liveText : pin.description}
            readOnly={analyzing}
            aria-label="Callout description"
            data-testid="callout-description"
            placeholder={analyzing ? 'Inspecting this area...' : 'Add client notes or click the AI icon to inspect this area.'}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onEdit({ description: event.target.value })}
            className="field-plain mt-1 max-h-40 text-ink-2 focus:text-ink"
          />
        )}
      </div>
    </>
  );
}
