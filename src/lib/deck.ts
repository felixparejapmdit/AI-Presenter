import { LAYOUT_TYPES, type AiSlide, type Dropzone, type LayoutType, type PinAnnotation, type Project, type Slide } from '../types/deck';
import { createId, stripEmoji } from './utils';

export const LAYOUT_LABELS: Record<LayoutType, string> = {
  'single-visual': 'Single visual',
  'split-comparison': 'Split comparison',
  'multi-grid': 'Multi grid',
  'statement-only': 'Statement only',
};

export const LAYOUT_ICONS: Record<LayoutType, string> = {
  'single-visual': 'lucide:image',
  'split-comparison': 'lucide:columns-2',
  'multi-grid': 'lucide:layout-grid',
  'statement-only': 'lucide:align-left',
};

const LAYOUT_ZONES: Record<LayoutType, { min: number; max: number }> = {
  'single-visual': { min: 1, max: 1 },
  'split-comparison': { min: 2, max: 2 },
  'multi-grid': { min: 3, max: 4 },
  'statement-only': { min: 0, max: 0 },
};

export function normalizeLayout(value: string): LayoutType {
  const candidate = value.trim().toLowerCase().replace(/_/g, '-');
  return (LAYOUT_TYPES as string[]).includes(candidate) ? (candidate as LayoutType) : 'single-visual';
}

export function createDropzone(aiVisualPrompt = ''): Dropzone {
  return { id: createId(), aiVisualPrompt, image: null, pins: [] };
}

function promptForZone(title: string): string {
  return title ? `Drop a screenshot, chart or mockup that supports: ${title}` : 'Drop a screenshot, chart or mockup for this slide';
}

/** Resizes a dropzone list to fit a layout. Filled zones are kept in preference to empty ones. */
export function fitDropzones(zones: Dropzone[], layout: LayoutType, title: string): Dropzone[] {
  const { min, max } = LAYOUT_ZONES[layout];
  const filled = zones.filter((zone) => zone.image);
  const empty = zones.filter((zone) => !zone.image);
  const ordered = [...filled, ...empty];
  const kept = zones.filter((zone) => ordered.indexOf(zone) < max);
  const result = [...kept];
  while (result.length < min) result.push(createDropzone(promptForZone(title)));
  return result;
}

/** Final gate for AI output, applied whichever backend produced it. */
export function slidesFromAi(items: AiSlide[]): Slide[] {
  return items.map((item, index) => {
    const refinedTitle = stripEmoji(item.refinedTitle ?? '') || `Slide ${index + 1}`;
    const layoutType = normalizeLayout(item.layoutType ?? '');
    const zones = (item.dropzones ?? []).map((zone) => createDropzone(stripEmoji(zone.aiVisualPrompt ?? '')));
    return {
      id: createId(),
      slideNumber: index + 1,
      originalExcerpt: stripEmoji(item.originalExcerpt ?? ''),
      refinedTitle,
      executiveSummary: (item.executiveSummary ?? []).map(stripEmoji).filter(Boolean).slice(0, 3),
      speakerNotes: stripEmoji(item.speakerNotes ?? ''),
      layoutType,
      dropzones: fitDropzones(zones, layoutType, refinedTitle),
    };
  });
}

/** Builds a deck by splitting on blank lines, so the app stays useful without any AI model. */
export function slidesFromOutline(script: string): Slide[] {
  const blocks = script
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block, index) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const first = (lines[0] ?? '').replace(/^#+\s*/, '').replace(/^[-*]\s+/, '');
    const title = first.length > 80 ? `${first.slice(0, 77).trimEnd()}...` : first;
    const rest = lines.slice(1).map((line) => line.replace(/^[-*]\s+/, '')).slice(0, 3);
    const layoutType: LayoutType = rest.length === 0 ? 'statement-only' : 'single-visual';
    return {
      id: createId(),
      slideNumber: index + 1,
      originalExcerpt: block,
      refinedTitle: title || `Slide ${index + 1}`,
      executiveSummary: rest,
      speakerNotes: block.replace(/^#+\s*/gm, ''),
      layoutType,
      dropzones: fitDropzones([], layoutType, title),
    };
  });
}

export function renumberSlides(slides: Slide[]): Slide[] {
  return slides.map((slide, index) => (slide.slideNumber === index + 1 ? slide : { ...slide, slideNumber: index + 1 }));
}

export function renumberPins(pins: PinAnnotation[]): PinAnnotation[] {
  return pins.map((pin, index) => (pin.index === index + 1 ? pin : { ...pin, index: index + 1 }));
}

export function blankSlide(): Slide {
  return {
    id: createId(),
    slideNumber: 0,
    originalExcerpt: '',
    refinedTitle: 'Untitled slide',
    executiveSummary: [],
    speakerNotes: '',
    layoutType: 'single-visual',
    dropzones: [createDropzone(promptForZone(''))],
  };
}

export function createProject(name = 'Untitled deck'): Project {
  const now = Date.now();
  return {
    id: createId(),
    name,
    script: '',
    persona: 'C-Suite Executive',
    tone: 'Concise & Direct',
    slides: [],
    createdAt: now,
    updatedAt: now,
  };
}

export const SAMPLE_SCRIPT = `Q3 review for the Northwind leadership team.

Revenue grew 38 percent year over year, driven by the enterprise tier. Churn fell from 4.1 percent to 2.6 percent after we launched guided onboarding.

Here is the new analytics dashboard. Point out the conversion funnel and the spike in week 7 when the partner campaign went live.

Compare the legacy checkout with the redesigned flow. Page load dropped from 3.2 seconds to 900 milliseconds and abandoned carts fell by a fifth.

We have three priorities for Q4: expand into the APAC region, ship the mobile companion, and reach SOC 2 Type II certification.

The ask: approve an additional two engineers for the data platform so that the APAC launch stays on schedule.`;
