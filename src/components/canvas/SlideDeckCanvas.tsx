import { memo, useEffect, useRef } from 'react';
import { LAYOUT_ICONS, LAYOUT_LABELS } from '../../lib/deck';
import { cn } from '../../lib/utils';
import { selectActiveProject, useDeckStore } from '../../store/useDeckStore';
import { LAYOUT_TYPES, type LayoutType, type Slide } from '../../types/deck';
import { AppIcon } from '../ui/AppIcon';
import { Select, type SelectOption } from '../ui/Select';
import { ImageDropzone } from './ImageDropzone';

const LAYOUT_OPTIONS: SelectOption<LayoutType>[] = LAYOUT_TYPES.map((layout) => ({
  value: layout,
  label: LAYOUT_LABELS[layout],
  icon: LAYOUT_ICONS[layout],
}));

function zoneGridClass(layout: LayoutType, zoneCount: number): string {
  if (layout === 'split-comparison') return 'zone-grid-2';
  if (layout === 'multi-grid') return zoneCount >= 4 ? 'zone-grid-2' : 'zone-grid-3';
  return '';
}

export function SlideDeckCanvas() {
  const projectId = useDeckStore((state) => state.activeProjectId);
  const slides = useDeckStore((state) => selectActiveProject(state)?.slides);
  const scrollTarget = useDeckStore((state) => state.scrollTarget);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scrollTarget) return;
    scrollRef.current
      ?.querySelector(`[data-slide-id="${scrollTarget.slideId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [scrollTarget]);

  if (!projectId || !slides) return null;

  return (
    <section ref={scrollRef} aria-label="Slide deck" data-testid="slide-canvas" className="h-full overflow-y-auto bg-surface" style={{ scrollbarGutter: 'stable' }}>
      <div className="mx-auto flex max-w-[1040px] flex-col gap-4 p-4 sm:p-6" style={{ containerType: 'inline-size', containerName: 'deck' }}>
        {slides.length === 0 ? (
          <EmptyDeck />
        ) : (
          <>
            {slides.map((slide, index) => (
              <SlideCard key={slide.id} projectId={projectId} slide={slide} isFirst={index === 0} isLast={index === slides.length - 1} />
            ))}
            <button
              type="button"
              data-testid="add-slide"
              className="btn w-full border border-dashed border-line text-ink-2 hover:text-ink"
              onClick={() => useDeckStore.getState().addSlide()}
            >
              <AppIcon icon="lucide:plus" size={14} />
              Add slide
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function EmptyDeck() {
  const addSlide = useDeckStore((state) => state.addSlide);
  return (
    <div data-testid="empty-deck" className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
      <AppIcon icon="lucide:presentation" size={28} className="text-ink-3" />
      <div>
        <h2 className="text-sm font-semibold">Your slides will appear here</h2>
        <p className="mx-auto mt-1 max-w-[42ch] text-[13px] text-ink-2">
          Paste a script on the left and generate a deck, or start with an empty slide and build it by hand.
        </p>
      </div>
      <button type="button" className="btn btn-outline" onClick={() => addSlide()}>
        <AppIcon icon="lucide:plus" size={14} />
        Add a blank slide
      </button>
    </div>
  );
}

interface SlideCardProps {
  projectId: string;
  slide: Slide;
  isFirst: boolean;
  isLast: boolean;
}

/** Memoized so that editing or annotating one slide never re-renders the others. */
const SlideCard = memo(function SlideCard({ projectId, slide, isFirst, isLast }: SlideCardProps) {
  const store = useDeckStore.getState;
  const updateSummary = (points: string[]) => store().updateSlide(slide.id, { executiveSummary: points });

  return (
    <article data-testid="slide-card" data-slide-id={slide.id} className="slide-card card group/card scroll-mt-4">
      <header className="flex items-center gap-1 border-b border-line px-3 py-1.5">
        <span className="text-xs font-medium text-ink-2" data-testid="slide-number">
          Slide {slide.slideNumber}
        </span>
        <div className="flex-1" />
        <Select
          value={slide.layoutType}
          options={LAYOUT_OPTIONS}
          onChange={(layout) => store().setLayout(slide.id, layout)}
          label="Slide layout"
          testId="slide-layout"
          className="w-[156px]"
          buttonClassName="border-transparent shadow-none bg-transparent text-xs text-ink-2 hover:text-ink"
        />
        <button type="button" className="btn btn-icon" title="Move up" aria-label="Move slide up" disabled={isFirst} onClick={() => store().moveSlide(slide.id, -1)}>
          <AppIcon icon="lucide:arrow-up" size={14} />
        </button>
        <button type="button" className="btn btn-icon" title="Move down" aria-label="Move slide down" disabled={isLast} onClick={() => store().moveSlide(slide.id, 1)}>
          <AppIcon icon="lucide:arrow-down" size={14} />
        </button>
        <button type="button" className="btn btn-icon" title="Add slide below" aria-label="Add slide below" onClick={() => store().addSlide(slide.id)}>
          <AppIcon icon="lucide:plus" size={14} />
        </button>
        <button type="button" className="btn btn-icon btn-danger" title="Delete slide" aria-label="Delete slide" data-testid="delete-slide" onClick={() => store().deleteSlide(slide.id)}>
          <AppIcon icon="lucide:trash-2" size={14} />
        </button>
      </header>

      <div className="flex flex-col gap-3 p-4">
        <textarea
          rows={1}
          value={slide.refinedTitle}
          aria-label="Slide title"
          placeholder="Slide title"
          data-testid="slide-title"
          onChange={(event) => store().updateSlide(slide.id, { refinedTitle: event.target.value })}
          className="field-plain text-xl leading-snug font-semibold"
        />

        <ul className="flex flex-col gap-1" data-testid="slide-summary">
          {slide.executiveSummary.map((point, index) => (
            <li key={index} className="group/point flex items-start gap-2">
              <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-ink-2" />
              <textarea
                rows={1}
                value={point}
                aria-label={`Talking point ${index + 1}`}
                onChange={(event) => updateSummary(slide.executiveSummary.map((item, itemIndex) => (itemIndex === index ? event.target.value : item)))}
                className="field-plain flex-1 text-[14px] leading-relaxed"
              />
              <button
                type="button"
                className="btn btn-icon h-6 w-6 opacity-0 group-hover/point:opacity-100 focus:opacity-100"
                title="Remove talking point"
                aria-label={`Remove talking point ${index + 1}`}
                onClick={() => updateSummary(slide.executiveSummary.filter((_, itemIndex) => itemIndex !== index))}
              >
                <AppIcon icon="lucide:x" size={13} />
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="btn h-6 px-1 text-xs font-normal text-ink-3 hover:text-ink"
              data-testid="add-point"
              onClick={() => updateSummary([...slide.executiveSummary, ''])}
            >
              <AppIcon icon="lucide:plus" size={13} />
              Add talking point
            </button>
          </li>
        </ul>

        {slide.dropzones.length > 0 && (
          <div className={cn('grid grid-cols-1 gap-3', zoneGridClass(slide.layoutType, slide.dropzones.length))} data-testid="zone-grid">
            {slide.dropzones.map((zone) => (
              <ImageDropzone key={zone.id} projectId={projectId} slideId={slide.id} zone={zone} title={slide.refinedTitle} />
            ))}
          </div>
        )}

        <details className="group/notes rounded-[5px] border border-line bg-sidebar" data-testid="speaker-notes">
          <summary className="flex h-7 cursor-pointer list-none items-center gap-1.5 px-2 text-xs font-medium text-ink-2 select-none [&::-webkit-details-marker]:hidden">
            <AppIcon icon="lucide:chevron-right" size={13} className="group-open/notes:rotate-90" />
            <AppIcon icon="lucide:mic" size={13} />
            Speaker notes
          </summary>
          <div className="border-t border-line p-2">
            <textarea
              rows={3}
              value={slide.speakerNotes}
              aria-label="Speaker notes"
              data-testid="speaker-notes-input"
              placeholder="What you will say on this slide"
              onChange={(event) => store().updateSlide(slide.id, { speakerNotes: event.target.value })}
              className="field-plain text-[13px] leading-relaxed"
            />
          </div>
        </details>
      </div>
    </article>
  );
});
