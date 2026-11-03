import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { getFontEmbedCSS, toJpeg, toPng } from 'html-to-image';
import { STAGE_HEIGHT, STAGE_WIDTH, SlideStage } from '../components/presentation/SlideStage';
import type { ImageAsset, LeaderStyle, Project, Slide } from '../types/deck';
import { bridge } from './bridge';
import { nextFrame } from './utils';

const PIXEL_RATIO = 2;
const JPEG_QUALITY = 0.94;

export type ExportProgress = (current: number, total: number) => void;

function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim();
  return cleaned || 'Vanguard Deck';
}

function mimeFor(asset: ImageAsset): string {
  return asset.mime || 'image/png';
}

async function waitForImages(root: HTMLElement): Promise<void> {
  const images = [...root.querySelectorAll('img')];
  await Promise.all(images.map((image) => (image.complete && image.naturalWidth > 0 ? Promise.resolve() : image.decode().catch(() => undefined))));
}

/**
 * Renders every slide off-screen on the same stage the presenter uses, then rasterizes it.
 * Images are inlined as data URLs so the canvas is never tainted, and the event loop is
 * released between slides so the window stays responsive.
 */
async function renderSlides(project: Project, leaderStyle: LeaderStyle, format: 'jpeg' | 'png', onProgress: ExportProgress): Promise<string[]> {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  // Export is always light: a deck is printed and shared, whatever the app theme is.
  host.setAttribute('data-theme', 'light');
  host.setAttribute('data-testid', 'export-host');
  host.style.cssText = `position:fixed;left:-${STAGE_WIDTH * 2}px;top:0;width:${STAGE_WIDTH}px;height:${STAGE_HEIGHT}px;pointer-events:none;`;
  document.body.append(host);
  const root = createRoot(host);

  const dataUrls = new Map<string, string>();
  const results: string[] = [];
  let fontEmbedCSS: string | undefined;

  try {
    for (const asset of project.slides.flatMap((slide) => slide.dropzones.flatMap((zone) => (zone.image ? [zone.image] : [])))) {
      if (!dataUrls.has(asset.storedName)) {
        dataUrls.set(asset.storedName, `data:${mimeFor(asset)};base64,${await bridge.assetBase64(project.id, asset)}`);
      }
    }
    const resolveUrl = (asset: ImageAsset) => dataUrls.get(asset.storedName) ?? '';

    let index = 0;
    for (const slide of project.slides) {
      flushSync(() => {
        root.render(
          <div className="slide-stage" data-testid="export-stage">
            <SlideStage slide={slide} leaderStyle={leaderStyle} resolveUrl={resolveUrl} />
          </div>,
        );
      });
      const stage = host.firstElementChild as HTMLElement;
      await waitForImages(stage);
      await document.fonts.ready;
      await nextFrame();
      await nextFrame();

      fontEmbedCSS ??= await getFontEmbedCSS(stage);
      const options = {
        width: STAGE_WIDTH,
        height: STAGE_HEIGHT,
        pixelRatio: PIXEL_RATIO,
        fontEmbedCSS,
        backgroundColor: '#FFFFFF',
        quality: JPEG_QUALITY,
      };
      results.push(format === 'jpeg' ? await toJpeg(stage, options) : await toPng(stage, options));
      index += 1;
      onProgress(index, project.slides.length);
      await nextFrame();
    }
  } finally {
    root.unmount();
    host.remove();
  }
  return results;
}

async function buildPdf(images: string[]): Promise<Uint8Array> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'px',
    format: [STAGE_WIDTH, STAGE_HEIGHT],
    hotfixes: ['px_scaling'],
    compress: true,
  });
  images.forEach((image, index) => {
    if (index > 0) doc.addPage([STAGE_WIDTH, STAGE_HEIGHT], 'landscape');
    // JPEG data is embedded as is, which avoids the long main-thread decode a PNG would need.
    doc.addImage(image, 'JPEG', 0, 0, STAGE_WIDTH, STAGE_HEIGHT, undefined, 'NONE');
  });
  return new Uint8Array(doc.output('arraybuffer'));
}

function notesFor(slide: Slide): string {
  return slide.speakerNotes.trim();
}

async function buildPptx(project: Project, images: string[]): Promise<Uint8Array> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'VANGUARD_16_9', width: 13.333, height: 7.5 });
  pptx.layout = 'VANGUARD_16_9';
  pptx.title = project.name;
  pptx.company = 'Vanguard Deck';

  images.forEach((image, index) => {
    const source = project.slides[index]!;
    const slide = pptx.addSlide();
    slide.addImage({ data: image, x: 0, y: 0, w: 13.333, h: 7.5, altText: source.refinedTitle });
    const notes = notesFor(source);
    if (notes) slide.addNotes(notes);
  });

  const output = await pptx.write({ outputType: 'uint8array' });
  return output as Uint8Array;
}

/** Resolves to the saved file name, or null when the user dismissed the save dialog. */
export async function exportDeck(project: Project, format: 'pdf' | 'pptx', leaderStyle: LeaderStyle, onProgress: ExportProgress): Promise<string | null> {
  const fileBase = safeFileName(project.name);
  if (format === 'pdf') {
    const images = await renderSlides(project, leaderStyle, 'jpeg', onProgress);
    return bridge.saveExport(`${fileBase}.pdf`, await buildPdf(images), { name: 'PDF document', extensions: ['pdf'] });
  }
  const images = await renderSlides(project, leaderStyle, 'png', onProgress);
  return bridge.saveExport(`${fileBase}.pptx`, await buildPptx(project, images), { name: 'PowerPoint presentation', extensions: ['pptx'] });
}
