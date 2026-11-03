import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blankSlide, createDropzone, fitDropzones, renumberPins, renumberSlides, slidesFromAi, slidesFromOutline } from './deck';
import { parseSlides } from './bridge/webBridge';
import { diffWords } from './diff';
import { classifyTier, MODEL_CATALOG, recommendationsForTier } from './modelCatalog';
import { containsEmoji, formatBytes, formatSpeed, stripEmoji } from './utils';
import type { ImageAsset, PinAnnotation } from '../types/deck';

const asset: ImageAsset = { id: 'a', fileName: 'a.png', storedName: 'a.png', mime: 'image/png', width: 10, height: 10, byteSize: 1, path: '' };

describe('stripEmoji', () => {
  it('removes pictographs and keeps punctuation and accents', () => {
    expect(stripEmoji('Revenue \u{1F680} up 40% \u{2705}')).toBe('Revenue up 40%');
    expect(stripEmoji('Café — résumé')).toBe('Café — résumé');
    expect(stripEmoji('\u{1F468}‍\u{1F4BB} team')).toBe('team');
  });

  it('detects emoji without consuming the stateful regex', () => {
    expect(containsEmoji('hello \u{1F680}')).toBe(true);
    expect(containsEmoji('hello \u{1F680}')).toBe(true);
    expect(containsEmoji('plain text')).toBe(false);
  });
});

describe('slidesFromAi', () => {
  it('assigns ids, cleans text and enforces the slide contract', () => {
    const [slide] = slidesFromAi([
      {
        slideNumber: 9,
        originalExcerpt: 'raw \u{1F389}',
        refinedTitle: 'Launch \u{1F680}',
        executiveSummary: ['One', '', 'Two', 'Three', 'Four'],
        speakerNotes: 'Say it',
        layoutType: 'split_comparison',
        dropzones: [{ aiVisualPrompt: 'Before' }],
      },
    ]);
    expect(slide!.id).toBeTruthy();
    expect(slide!.slideNumber).toBe(1);
    expect(slide!.refinedTitle).toBe('Launch');
    expect(slide!.originalExcerpt).toBe('raw');
    expect(slide!.executiveSummary).toEqual(['One', 'Two', 'Three']);
    expect(slide!.layoutType).toBe('split-comparison');
    expect(slide!.dropzones).toHaveLength(2);
    expect(slide!.dropzones[0]!.aiVisualPrompt).toBe('Before');
  });

  it('falls back when a title or layout is unusable', () => {
    const [slide] = slidesFromAi([{ slideNumber: 1, originalExcerpt: '', refinedTitle: '', executiveSummary: [], speakerNotes: '', layoutType: 'nonsense', dropzones: [] }]);
    expect(slide!.refinedTitle).toBe('Slide 1');
    expect(slide!.layoutType).toBe('single-visual');
    expect(slide!.dropzones).toHaveLength(1);
  });
});

describe('slidesFromOutline', () => {
  it('splits on blank lines and turns following lines into points', () => {
    const slides = slidesFromOutline('## Growth\n- Up 40%\n- Churn down\n\nJust a statement');
    expect(slides).toHaveLength(2);
    expect(slides[0]!.refinedTitle).toBe('Growth');
    expect(slides[0]!.executiveSummary).toEqual(['Up 40%', 'Churn down']);
    expect(slides[0]!.layoutType).toBe('single-visual');
    expect(slides[1]!.layoutType).toBe('statement-only');
    expect(slides[1]!.dropzones).toHaveLength(0);
  });

  it('keeps a leading minus sign, which is a figure and not a bullet', () => {
    const [slide] = slidesFromOutline('-12% revenue year over year\n-3 points of churn\n- A real bullet');
    expect(slide!.refinedTitle).toBe('-12% revenue year over year');
    expect(slide!.executiveSummary).toEqual(['-3 points of churn', 'A real bullet']);
  });

  it('ignores extra whitespace and truncates long titles', () => {
    expect(slidesFromOutline('  \n\n  \n')).toHaveLength(0);
    expect(slidesFromOutline('x'.repeat(200))[0]!.refinedTitle.length).toBeLessThanOrEqual(80);
  });
});

describe('parseSlides', () => {
  it('keeps negative figures, removes real bullets and bold markers', () => {
    const [slide] = parseSlides(JSON.stringify({ slides: [{ refinedTitle: 'T', executiveSummary: ['-12% revenue', '- Real bullet', '**Churn** fell', '\u{2022}Dot'] }] }));
    expect(slide!.executiveSummary).toEqual(['-12% revenue', 'Real bullet', 'Churn fell']);
  });
});

describe('fitDropzones', () => {
  it('grows and shrinks to the layout', () => {
    expect(fitDropzones([], 'single-visual', 'T')).toHaveLength(1);
    expect(fitDropzones([], 'split-comparison', 'T')).toHaveLength(2);
    expect(fitDropzones([], 'multi-grid', 'T')).toHaveLength(3);
    expect(fitDropzones([createDropzone()], 'statement-only', 'T')).toHaveLength(0);
  });

  it('keeps filled zones when shrinking', () => {
    const empty = createDropzone('empty');
    const filled = { ...createDropzone('filled'), image: asset };
    const result = fitDropzones([empty, filled], 'single-visual', 'T');
    expect(result).toEqual([filled]);
  });

  it('leaves a valid count untouched and preserves order', () => {
    const zones = [createDropzone('a'), createDropzone('b'), createDropzone('c'), createDropzone('d')];
    expect(fitDropzones(zones, 'multi-grid', 'T')).toEqual(zones);
  });
});

describe('renumbering', () => {
  it('renumbers slides and keeps identity when nothing changed', () => {
    const first = { ...blankSlide(), slideNumber: 1 };
    const second = { ...blankSlide(), slideNumber: 5 };
    const result = renumberSlides([first, second]);
    expect(result[0]).toBe(first);
    expect(result[1]!.slideNumber).toBe(2);
  });

  it('renumbers pins after a removal', () => {
    const pin = (index: number) => ({ id: String(index), index }) as PinAnnotation;
    expect(renumberPins([pin(2), pin(3)]).map((entry) => entry.index)).toEqual([1, 2]);
  });
});

describe('diffWords', () => {
  it('marks additions and removals at word level', () => {
    expect(diffWords('grew a lot', 'grew 38 percent')).toEqual([
      { kind: 'same', text: 'grew ' },
      { kind: 'removed', text: 'a' },
      { kind: 'added', text: '38' },
      { kind: 'same', text: ' ' },
      { kind: 'removed', text: 'lot' },
      { kind: 'added', text: 'percent' },
    ]);
  });

  it('reconstructs both sides exactly', () => {
    const before = 'The quick brown fox jumps';
    const after = 'A quick red fox leaps today';
    const tokens = diffWords(before, after);
    expect(tokens.filter((t) => t.kind !== 'added').map((t) => t.text).join('')).toBe(before);
    expect(tokens.filter((t) => t.kind !== 'removed').map((t) => t.text).join('')).toBe(after);
  });

  it('handles empty input and huge input without stalling', () => {
    expect(diffWords('', '')).toEqual([]);
    expect(diffWords('', 'new')).toEqual([{ kind: 'added', text: 'new' }]);
    const huge = 'word '.repeat(5000);
    expect(diffWords(huge, `${huge}x`)).toHaveLength(2);
  });
});

describe('formatting', () => {
  it('formats bytes and speed', () => {
    expect(formatBytes(1_738_451_197)).toBe('1.74 GB');
    expect(formatBytes(52_000_000)).toBe('52 MB');
    expect(formatSpeed(12_500_000)).toBe('12.5 MB/s');
  });
});

describe('model catalog', () => {
  it('matches the native catalog in hardware.rs', () => {
    const rust = readFileSync(new URL('../../src-tauri/src/hardware.rs', import.meta.url), 'utf8');
    const rustEntries = [...rust.matchAll(/CatalogEntry \{ id: "([^"]+)", display_name: "([^"]+)", role: "([^"]+)", size_gb: ([\d.]+), tier_level: (\d)/g)].map((match) => ({
      id: match[1],
      displayName: match[2],
      role: match[3],
      sizeGb: Number(match[4]),
      tierLevel: Number(match[5]),
    }));
    expect(rustEntries).toHaveLength(MODEL_CATALOG.length);
    expect(MODEL_CATALOG.map(({ id, displayName, role, sizeGb, tierLevel }) => ({ id, displayName, role, sizeGb, tierLevel }))).toEqual(rustEntries);
  });

  it('classifies tiers with no gaps', () => {
    expect(classifyTier(0).tierLevel).toBe(1);
    expect(classifyTier(7.99).tierLevel).toBe(1);
    expect(classifyTier(8).tierLevel).toBe(2);
    expect(classifyTier(17.99).tierLevel).toBe(2);
    expect(classifyTier(18).tierLevel).toBe(3);
  });

  it('recommends both vision and text at every tier', () => {
    for (const tier of [1, 2, 3]) {
      const picks = recommendationsForTier(tier).filter((entry) => entry.recommended);
      expect(picks.some((entry) => entry.role === 'vision')).toBe(true);
      expect(picks.some((entry) => entry.role === 'text')).toBe(true);
    }
  });
});
