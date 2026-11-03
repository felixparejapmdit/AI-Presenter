import { memo, type CSSProperties } from 'react';
import { cn } from '../../lib/utils';
import type { Dropzone, ImageAsset, LayoutType, LeaderStyle, Slide } from '../../types/deck';
import { AnnotatedImage } from '../canvas/AnnotatedImage';

export const STAGE_WIDTH = 1280;
export const STAGE_HEIGHT = 720;

interface SlideStageProps {
  slide: Slide;
  leaderStyle: LeaderStyle;
  resolveUrl: (asset: ImageAsset) => string;
  activePinId?: string | null;
  onActivatePin?: (pinId: string) => void;
}

/** With images missing, a slide falls back to a layout that does not show empty frames. */
function effectiveLayout(imageCount: number): LayoutType {
  if (imageCount === 0) return 'statement-only';
  if (imageCount === 1) return 'single-visual';
  return imageCount === 2 ? 'split-comparison' : 'multi-grid';
}

function Visual({ zone, ...props }: { zone: Dropzone & { image: ImageAsset } } & Omit<SlideStageProps, 'slide'>) {
  const { image } = zone;
  return (
    <div className="canvas-fit h-full w-full" style={{ '--image-ratio': image.width / image.height } as CSSProperties}>
      <AnnotatedImage
        imageUrl={props.resolveUrl(image)}
        imageWidth={image.width}
        imageHeight={image.height}
        alt={zone.aiVisualPrompt || image.fileName}
        pins={zone.pins}
        leaderStyle={props.leaderStyle}
        activePinId={zone.pins.some((pin) => pin.id === props.activePinId) ? props.activePinId : props.activePinId ? '__other__' : null}
        onActivatePin={props.onActivatePin}
      />
    </div>
  );
}

function Points({ points, size }: { points: string[]; size: number }) {
  const visible = points.filter((point) => point.trim());
  if (visible.length === 0) return null;
  return (
    <ul className="flex flex-col" style={{ gap: size * 0.7, fontSize: size, lineHeight: 1.4 }} data-testid="stage-points">
      {visible.map((point, index) => (
        <li key={index} className="flex" style={{ gap: size * 0.6 }}>
          <span className="shrink-0 rounded-full bg-ink-2" style={{ width: size * 0.26, height: size * 0.26, marginTop: size * 0.56 }} />
          <span className="min-w-0 break-words">{point}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One slide on a fixed 1280x720 logical surface. The presenter scales it to the screen
 * and export rasterizes it, so what you present is exactly what you export.
 */
export const SlideStage = memo(function SlideStage({ slide, ...props }: SlideStageProps) {
  const zones = slide.dropzones.filter((zone): zone is Dropzone & { image: ImageAsset } => Boolean(zone.image));
  const layout = effectiveLayout(zones.length);

  if (layout === 'statement-only') {
    return (
      <div className="flex h-full w-full flex-col justify-center px-[120px] py-[72px]" data-testid="stage-statement">
        <h1 className="text-[52px] leading-[1.14] font-semibold tracking-[-0.02em] break-words" data-testid="stage-title">
          {slide.refinedTitle}
        </h1>
        <div className="mt-10 max-w-[920px] text-ink-2">
          <Points points={slide.executiveSummary} size={24} />
        </div>
      </div>
    );
  }

  if (layout === 'single-visual') {
    return (
      <div className="flex h-full w-full flex-col px-[56px] py-[44px]" data-testid="stage-single">
        <h1 className="shrink-0 text-[36px] leading-[1.18] font-semibold tracking-[-0.015em] break-words" data-testid="stage-title">
          {slide.refinedTitle}
        </h1>
        <div className={cn('mt-6 grid min-h-0 flex-1 gap-8', slide.executiveSummary.some((point) => point.trim()) ? 'grid-cols-[300px_minmax(0,1fr)]' : 'grid-cols-1')}>
          {slide.executiveSummary.some((point) => point.trim()) && (
            <div className="min-w-0 text-ink-2">
              <Points points={slide.executiveSummary} size={18} />
            </div>
          )}
          <div className="min-h-0 min-w-0">
            <Visual zone={zones[0]!} {...props} />
          </div>
        </div>
      </div>
    );
  }

  const columns = zones.length === 2 ? 2 : zones.length === 3 ? 3 : 2;
  return (
    <div className="flex h-full w-full flex-col px-[56px] py-[40px]" data-testid={layout === 'split-comparison' ? 'stage-split' : 'stage-grid'}>
      <h1 className="shrink-0 text-[32px] leading-[1.18] font-semibold tracking-[-0.015em] break-words" data-testid="stage-title">
        {slide.refinedTitle}
      </h1>
      <div className="mt-5 grid min-h-0 flex-1 gap-4" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: 'minmax(0, 1fr)' }}>
        {zones.slice(0, 4).map((zone) => (
          <div key={zone.id} className="min-h-0 min-w-0">
            <Visual zone={zone} {...props} />
          </div>
        ))}
      </div>
      {slide.executiveSummary.some((point) => point.trim()) && (
        <div className="mt-4 shrink-0 text-ink-2">
          <Points points={slide.executiveSummary} size={15} />
        </div>
      )}
    </div>
  );
});
