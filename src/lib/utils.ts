import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function createId(): string {
  return crypto.randomUUID();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`;
}

const EMOJI_PATTERN =
  /[\u{200D}\u{FE0E}\u{FE0F}\u{20E3}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{25A0}-\u{27BF}\u{2900}-\u{297F}\u{2B00}-\u{2BFF}\u{3030}\u{303D}\u{3297}\u{3299}\u{1F000}-\u{1FAFF}\u{E0020}-\u{E007F}]/gu;

/** The no-emoji rule must hold even if a model ignores its system prompt. */
export function stripEmoji(text: string): string {
  return text.replace(EMOJI_PATTERN, '').replace(/[ \t]{2,}/g, ' ').trim();
}

export function containsEmoji(text: string): boolean {
  return new RegExp(EMOJI_PATTERN.source, 'u').test(text);
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? 'Cmd' : 'Ctrl';

/** Coalesces a stream of updates into at most one call per animation frame. */
export function frameThrottle<T>(apply: (value: T) => void): { push: (value: T) => void; flush: () => void } {
  let pending: { value: T } | null = null;
  let frame: number | null = null;
  const flush = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (pending) {
      const { value } = pending;
      pending = null;
      apply(value);
    }
  };
  return {
    push(value) {
      pending = { value };
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null;
          flush();
        });
      }
    },
    flush,
  };
}

export function waitForIdle(timeoutMs = 400): Promise<void> {
  return new Promise((resolve) => {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(() => resolve(), { timeout: timeoutMs });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
