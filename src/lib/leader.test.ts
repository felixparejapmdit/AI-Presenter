import { describe, expect, it } from 'vitest';
import { bezierPath, clampAnchorPercent, clampCardPosition, elbowPath, nearestEdgePoint, placeCallout, zoomToBox } from './leader';

const rect = { left: 100, top: 100, width: 200, height: 100 };
const identity = (point: { x: number; y: number }) => point;

function parsePath(path: string): number[][] {
  return [...path.matchAll(/-?\d+(?:\.\d+)?\s-?\d+(?:\.\d+)?/g)].map((match) => match[0].split(/\s/).map(Number));
}

describe('nearestEdgePoint', () => {
  it('finds the nearest point on each side', () => {
    expect(nearestEdgePoint({ x: 50, y: 150 }, rect)).toEqual({ x: 100, y: 150, edge: 'left' });
    expect(nearestEdgePoint({ x: 350, y: 150 }, rect)).toEqual({ x: 300, y: 150, edge: 'right' });
    expect(nearestEdgePoint({ x: 200, y: 50 }, rect)).toEqual({ x: 200, y: 100, edge: 'top' });
    expect(nearestEdgePoint({ x: 200, y: 250 }, rect)).toEqual({ x: 200, y: 200, edge: 'bottom' });
  });

  it('resolves a corner toward the wider gap', () => {
    expect(nearestEdgePoint({ x: 0, y: 90 }, rect)).toEqual({ x: 100, y: 100, edge: 'left' });
    expect(nearestEdgePoint({ x: 95, y: 0 }, rect)).toEqual({ x: 100, y: 100, edge: 'top' });
  });

  it('always lands on the perimeter even when the anchor is inside the card', () => {
    const point = nearestEdgePoint({ x: 110, y: 150 }, rect);
    expect(point).toEqual({ x: 100, y: 150, edge: 'left' });
  });
});

describe('elbowPath', () => {
  it('draws exactly two orthogonal segments', () => {
    const from = { x: 20, y: 300 };
    const to = nearestEdgePoint(from, rect);
    const points = parsePath(elbowPath(from, to, identity));
    expect(points).toHaveLength(3);
    const [a, b, c] = points as [number[], number[], number[]];
    expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
    expect(b[0] === c[0] || b[1] === c[1]).toBe(true);
  });

  it('enters the card squarely on its nearest edge', () => {
    const left = nearestEdgePoint({ x: 20, y: 150 }, rect);
    expect(elbowPath({ x: 20, y: 150 }, left, identity)).toBe('M 20 150 L 20 150 L 100 150');
    const top = nearestEdgePoint({ x: 200, y: 20 }, rect);
    expect(elbowPath({ x: 200, y: 20 }, top, identity)).toBe('M 200 20 L 200 20 L 200 100');
  });

  it('converts coordinates to the requested units', () => {
    const toPercent = (point: { x: number; y: number }) => ({ x: point.x / 10, y: point.y / 10 });
    const to = nearestEdgePoint({ x: 20, y: 150 }, rect);
    expect(elbowPath({ x: 20, y: 150 }, to, toPercent)).toBe('M 2 15 L 2 15 L 10 15');
  });
});

describe('bezierPath', () => {
  it('starts at the anchor and ends on the edge point', () => {
    const from = { x: 20, y: 300 };
    const to = nearestEdgePoint(from, rect);
    const points = parsePath(bezierPath(from, to, identity));
    expect(points[0]).toEqual([20, 300]);
    expect(points[points.length - 1]).toEqual([to.x, to.y]);
    expect(bezierPath(from, to, identity)).toContain(' C ');
  });

  it('arrives perpendicular to the entry edge', () => {
    const from = { x: 20, y: 150 };
    const to = nearestEdgePoint(from, rect);
    const points = parsePath(bezierPath(from, to, identity));
    expect(points[2]![1]).toBe(to.y);
  });
});

describe('clampCardPosition', () => {
  it('keeps cards inside the canvas', () => {
    expect(clampCardPosition(900, 900, 200, 100, 1000, 500)).toEqual({ x: 800, y: 400 });
    expect(clampCardPosition(-5, -5, 200, 100, 1000, 500)).toEqual({ x: 0, y: 0 });
  });

  it('pins an oversized card to the origin', () => {
    expect(clampCardPosition(50, 50, 2000, 1000, 1000, 500)).toEqual({ x: 0, y: 0 });
  });
});

describe('anchors and new callouts', () => {
  it('keeps anchors within the 2 to 98 percent band', () => {
    expect(clampAnchorPercent(-10)).toBe(2);
    expect(clampAnchorPercent(120)).toBe(98);
    expect(clampAnchorPercent(50)).toBe(50);
  });

  it('offsets new callouts toward the spacious quadrant', () => {
    const lowerRight = placeCallout(20, 20);
    expect(lowerRight.x).toBeGreaterThan(20);
    expect(lowerRight.y).toBeGreaterThan(20);
    const upperLeft = placeCallout(80, 80);
    expect(upperLeft.x).toBeLessThan(80);
    expect(upperLeft.y).toBeLessThan(80);
  });

  it('never covers its own anchor, at any position on the image', () => {
    for (let anchorX = 2; anchorX <= 98; anchorX += 8) {
      for (let anchorY = 2; anchorY <= 98; anchorY += 8) {
        const { x, y } = placeCallout(anchorX, anchorY);
        const covers = anchorX > x && anchorX < x + 36 && anchorY > y && anchorY < y + 24;
        expect(covers, `${anchorX},${anchorY} placed at ${x},${y}`).toBe(false);
      }
    }
  });

  it('stays inside the canvas', () => {
    for (const [anchorX, anchorY] of [[2, 2], [98, 2], [2, 98], [98, 98], [50, 50]] as const) {
      const { x, y } = placeCallout(anchorX, anchorY);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + 36).toBeLessThanOrEqual(100);
      expect(y + 24).toBeLessThanOrEqual(100);
    }
  });

  it('does not stack cards when pins are added near each other', () => {
    const pins: { anchorXPercent: number; anchorYPercent: number; calloutXPercent: number; calloutYPercent: number }[] = [];
    for (const [anchorX, anchorY] of [[72, 62], [20, 25], [50, 50], [30, 70]] as const) {
      const { x, y } = placeCallout(anchorX, anchorY, pins);
      for (const pin of pins) {
        const overlapsX = Math.min(x, pin.calloutXPercent) + 36 > Math.max(x, pin.calloutXPercent);
        const overlapsY = Math.min(y, pin.calloutYPercent) + 24 > Math.max(y, pin.calloutYPercent);
        expect(overlapsX && overlapsY, `card at ${x},${y} overlaps ${pin.calloutXPercent},${pin.calloutYPercent}`).toBe(false);
      }
      pins.push({ anchorXPercent: anchorX, anchorYPercent: anchorY, calloutXPercent: x, calloutYPercent: y });
    }
  });

  it('still returns a position when the canvas is crowded', () => {
    const crowded = Array.from({ length: 30 }, (_, index) => ({ anchorXPercent: index * 3, anchorYPercent: 50, calloutXPercent: (index % 6) * 10, calloutYPercent: (index % 5) * 15 }));
    const { x, y } = placeCallout(50, 50, crowded);
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
  });
});

describe('zoomToBox', () => {
  it('never reveals space beyond the stage', () => {
    for (const box of [
      { left: 0, top: 0, width: 50, height: 50 },
      { left: 1230, top: 670, width: 50, height: 50 },
      { left: 600, top: 300, width: 80, height: 80 },
    ]) {
      const zoom = zoomToBox(box, 1280, 720, 2.6, 28);
      expect(zoom.translateX).toBeLessThanOrEqual(0);
      expect(zoom.translateY).toBeLessThanOrEqual(0);
      expect(zoom.translateX).toBeGreaterThanOrEqual(1280 - 1280 * zoom.scale);
      expect(zoom.translateY).toBeGreaterThanOrEqual(720 - 720 * zoom.scale);
    }
  });

  it('caps the scale and never zooms out', () => {
    expect(zoomToBox({ left: 600, top: 300, width: 10, height: 10 }, 1280, 720, 2.6, 28).scale).toBe(2.6);
    expect(zoomToBox({ left: 0, top: 0, width: 1280, height: 720 }, 1280, 720, 2.6, 28).scale).toBe(1);
  });

  it('centers the box when the stage allows it', () => {
    const zoom = zoomToBox({ left: 600, top: 340, width: 80, height: 40 }, 1280, 720, 2, 28);
    expect(zoom.scale).toBe(2);
    expect(640 * zoom.scale + zoom.translateX).toBeCloseTo(640);
    expect(360 * zoom.scale + zoom.translateY).toBeCloseTo(360);
  });
});
