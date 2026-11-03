import { clamp } from './utils';

/** Pure geometry for pins and leader lines, in pixels unless stated otherwise. */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Edge = 'left' | 'right' | 'top' | 'bottom';

export interface EdgePoint extends Point {
  edge: Edge;
}

/** The point on the rectangle's perimeter nearest to `from`. */
export function nearestEdgePoint(from: Point, rect: Rect): EdgePoint {
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  const x = clamp(from.x, rect.left, right);
  const y = clamp(from.y, rect.top, bottom);

  const inside = from.x > rect.left && from.x < right && from.y > rect.top && from.y < bottom;
  if (inside) {
    const distances: [Edge, number][] = [
      ['left', from.x - rect.left],
      ['right', right - from.x],
      ['top', from.y - rect.top],
      ['bottom', bottom - from.y],
    ];
    distances.sort((a, b) => a[1] - b[1]);
    const edge = distances[0]![0];
    if (edge === 'left') return { x: rect.left, y: from.y, edge };
    if (edge === 'right') return { x: right, y: from.y, edge };
    if (edge === 'top') return { x: from.x, y: rect.top, edge };
    return { x: from.x, y: bottom, edge };
  }

  // On a corner the wider separation decides the entry side, so elbows look natural.
  const horizontalGap = from.x < rect.left ? rect.left - from.x : from.x > right ? from.x - right : 0;
  const verticalGap = from.y < rect.top ? rect.top - from.y : from.y > bottom ? from.y - bottom : 0;
  let edge: Edge;
  if (horizontalGap >= verticalGap) {
    edge = from.x < rect.left ? 'left' : 'right';
  } else {
    edge = from.y < rect.top ? 'top' : 'bottom';
  }
  return { x, y, edge };
}

const fmt = (value: number) => (Math.round(value * 1000) / 1000).toString();

/** Two orthogonal segments. The final one always enters the card squarely. */
export function elbowPath(from: Point, to: EdgePoint, toUnits: (p: Point) => Point): string {
  const corner: Point = to.edge === 'left' || to.edge === 'right' ? { x: from.x, y: to.y } : { x: to.x, y: from.y };
  const [a, b, c] = [toUnits(from), toUnits(corner), toUnits(to)];
  return `M ${fmt(a.x)} ${fmt(a.y)} L ${fmt(b.x)} ${fmt(b.y)} L ${fmt(c.x)} ${fmt(c.y)}`;
}

/** A smooth cubic curve that leaves the anchor and arrives square to the card edge. */
export function bezierPath(from: Point, to: EdgePoint, toUnits: (p: Point) => Point): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const reach = Math.max(24, Math.hypot(dx, dy) * 0.45);
  const horizontal = to.edge === 'left' || to.edge === 'right';
  const direction = to.edge === 'left' || to.edge === 'top' ? -1 : 1;
  const control1: Point = horizontal ? { x: from.x, y: from.y + Math.sign(dy || 1) * reach * 0.35 } : { x: from.x + Math.sign(dx || 1) * reach * 0.35, y: from.y };
  const control2: Point = horizontal ? { x: to.x + direction * reach, y: to.y } : { x: to.x, y: to.y + direction * reach };
  const [a, b, c, d] = [toUnits(from), toUnits(control1), toUnits(control2), toUnits(to)];
  return `M ${fmt(a.x)} ${fmt(a.y)} C ${fmt(b.x)} ${fmt(b.y)}, ${fmt(c.x)} ${fmt(c.y)}, ${fmt(d.x)} ${fmt(d.y)}`;
}

/** Keeps a card inside the canvas for display. The stored coordinates are unchanged. */
export function clampCardPosition(
  left: number,
  top: number,
  cardWidth: number,
  cardHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): Point {
  return {
    x: clamp(left, 0, Math.max(0, canvasWidth - cardWidth)),
    y: clamp(top, 0, Math.max(0, canvasHeight - cardHeight)),
  };
}

/** Pin anchors stay fully visible, so they are kept 2% away from the image edges. */
export function clampAnchorPercent(value: number): number {
  return clamp(value, 2, 98);
}

export interface PlacedPin {
  anchorXPercent: number;
  anchorYPercent: number;
  calloutXPercent: number;
  calloutYPercent: number;
}

/** Typical card size as a share of the canvas, used only to choose a starting position. */
const CARD_WIDTH_PERCENT = 36;
const CARD_HEIGHT_PERCENT = 24;
const ANCHOR_RADIUS_PERCENT = 3;
const CARD_GAP_PERCENT = 6;

function overlapArea(aLeft: number, aTop: number, bLeft: number, bTop: number): number {
  const width = Math.min(aLeft, bLeft) + CARD_WIDTH_PERCENT - Math.max(aLeft, bLeft);
  const height = Math.min(aTop, bTop) + CARD_HEIGHT_PERCENT - Math.max(aTop, bTop);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Chooses where a new callout starts. It prefers the more spacious quadrant around the
 * anchor, as the plan's blueprint does, but never lands on another card or pin when any
 * free space remains, so adding several pins does not stack their cards.
 */
export function placeCallout(anchorX: number, anchorY: number, existing: PlacedPin[] = []): Point {
  const maxX = 100 - CARD_WIDTH_PERCENT;
  const maxY = 100 - CARD_HEIGHT_PERCENT;
  const horizontal = anchorX > 55 ? [anchorX - CARD_GAP_PERCENT - CARD_WIDTH_PERCENT, anchorX + CARD_GAP_PERCENT] : [anchorX + CARD_GAP_PERCENT, anchorX - CARD_GAP_PERCENT - CARD_WIDTH_PERCENT];
  const vertical = anchorY > 55 ? [anchorY - CARD_GAP_PERCENT - CARD_HEIGHT_PERCENT, anchorY + CARD_GAP_PERCENT] : [anchorY + CARD_GAP_PERCENT, anchorY - CARD_GAP_PERCENT - CARD_HEIGHT_PERCENT];

  const candidates: Point[] = [];
  for (const y of vertical) for (const x of horizontal) candidates.push({ x, y });
  const quadrantCount = candidates.length;
  for (let y = 2; y <= maxY; y += 8) for (let x = 2; x <= maxX; x += 8) candidates.push({ x, y });

  const pins = [...existing.map((pin) => ({ x: pin.anchorXPercent, y: pin.anchorYPercent })), { x: anchorX, y: anchorY }];
  let best: Point = { x: clamp(candidates[0]!.x, 1, maxX), y: clamp(candidates[0]!.y, 1, maxY) };
  let bestScore = Number.POSITIVE_INFINITY;

  candidates.forEach((candidate, order) => {
    const x = clamp(candidate.x, 1, maxX);
    const y = clamp(candidate.y, 1, maxY);
    // Quadrants are tried in order of preference. The sweep is a fallback that only wins
    // when they are all taken, and then the position closest to the anchor is best.
    const distance = Math.hypot(x + CARD_WIDTH_PERCENT / 2 - anchorX, y + CARD_HEIGHT_PERCENT / 2 - anchorY);
    let score = order < quadrantCount ? order * 10 : 40 + distance;
    for (const pin of existing) score += overlapArea(x, y, pin.calloutXPercent, pin.calloutYPercent) * 10;
    for (const pin of pins) {
      const covered =
        pin.x > x - ANCHOR_RADIUS_PERCENT &&
        pin.x < x + CARD_WIDTH_PERCENT + ANCHOR_RADIUS_PERCENT &&
        pin.y > y - ANCHOR_RADIUS_PERCENT &&
        pin.y < y + CARD_HEIGHT_PERCENT + ANCHOR_RADIUS_PERCENT;
      if (covered) score += 600;
    }
    if (score < bestScore) {
      bestScore = score;
      best = { x, y };
    }
  });
  return best;
}

export interface ZoomTransform {
  scale: number;
  translateX: number;
  translateY: number;
}

/**
 * Zooms so a pin and its callout both fill the view. The stage edges stay inside the frame,
 * so a zoom can never reveal empty space beyond the slide.
 */
export function zoomToBox(box: Rect, viewWidth: number, viewHeight: number, maxScale: number, margin: number): ZoomTransform {
  const fit = Math.min((viewWidth - margin * 2) / Math.max(1, box.width), (viewHeight - margin * 2) / Math.max(1, box.height));
  const scale = clamp(fit, 1, maxScale);
  const centerX = box.left + box.width / 2;
  const centerY = box.top + box.height / 2;
  return {
    scale,
    translateX: clamp(viewWidth / 2 - centerX * scale, viewWidth - viewWidth * scale, 0),
    translateY: clamp(viewHeight / 2 - centerY * scale, viewHeight - viewHeight * scale, 0),
  };
}
