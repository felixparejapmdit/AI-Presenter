import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { bridge } from '../../lib/bridge';
import { cn, isEditableTarget, modKey } from '../../lib/utils';
import { useDeckStore } from '../../store/useDeckStore';
import type { Dropzone } from '../../types/deck';
import { AppIcon } from '../ui/AppIcon';
import { Modal } from '../ui/Modal';
import { AnnotatedImage, type PinHandlers } from './AnnotatedImage';

interface PasteTarget {
  slideId: string;
  zoneId: string;
}

// The most recently hovered or focused zone receives pasted images.
let hoveredTarget: PasteTarget | null = null;
let focusedTarget: PasteTarget | null = null;
let pasteListening = false;

function clipboardImageFile(event: ClipboardEvent): File | null {
  const items = event.clipboardData?.items;
  if (!items) return null;
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}

function installPasteListener() {
  if (pasteListening) return;
  pasteListening = true;

  document.addEventListener('paste', (event) => {
    const target = hoveredTarget ?? focusedTarget;
    if (!target) return;
    // Spreadsheets and word processors put text and an image on the clipboard together.
    // Inside a text field the text is what the user wants, and the slide image stays put.
    if (isEditableTarget(event.target) && event.clipboardData?.types.includes('text/plain')) return;
    const file = clipboardImageFile(event);
    if (file) {
      event.preventDefault();
      void useDeckStore.getState().ingestImage(target.slideId, target.zoneId, file, file.name || 'pasted-image.png');
      return;
    }
    if (isEditableTarget(event.target)) return;
    // Some webviews deliver no image data in the paste event, so ask the native clipboard.
    void bridge.readClipboardImage().then((blob) => {
      if (blob) void useDeckStore.getState().ingestImage(target.slideId, target.zoneId, blob, 'pasted-image.png');
    });
  });

  // A file dropped outside a zone must not navigate the webview away from the app.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
}

interface ImageDropzoneProps {
  projectId: string;
  slideId: string;
  zone: Dropzone;
  title: string;
}

export const ImageDropzone = memo(function ImageDropzone({ projectId, slideId, zone, title }: ImageDropzoneProps) {
  const leaderStyle = useDeckStore((state) => state.leaderStyle);
  const importing = useDeckStore((state) => Boolean(state.importingZones[zone.id]));
  const expanded = useDeckStore((state) => state.focusZone?.zoneId === zone.id);
  const liveDescriptions = useDeckStore(
    useShallow((state) => {
      const jobs: Record<string, { live: string }> = {};
      for (const pin of zone.pins) {
        const job = state.pinJobs[pin.id];
        if (job) jobs[pin.id] = job;
      }
      return jobs;
    }),
  );

  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  const target = useMemo(() => ({ slideId, zoneId: zone.id }), [slideId, zone.id]);

  useEffect(() => {
    installPasteListener();
    return () => {
      if (hoveredTarget?.zoneId === zone.id) hoveredTarget = null;
      if (focusedTarget?.zoneId === zone.id) focusedTarget = null;
    };
  }, [zone.id]);

  const onDragEnter = (event: React.DragEvent) => {
    event.preventDefault();
    // A depth counter stops the highlight flickering as the pointer crosses child elements.
    dragDepth.current += 1;
    if (dragDepth.current === 1) setDragOver(true);
  };

  const onDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragOver(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) void useDeckStore.getState().ingestFiles(slideId, zone.id, files);
  };

  const handlers = useMemo<PinHandlers>(() => {
    const store = useDeckStore.getState;
    return {
      onAddPin: (x, y) => {
        store().addPin(slideId, zone.id, x, y);
      },
      onMovePin: (pinId, patch) => store().commitPinPosition(slideId, zone.id, pinId, patch),
      onEditPin: (pinId, patch) => store().updatePinText(slideId, zone.id, pinId, patch),
      onDeletePin: (pinId) => store().deletePin(slideId, zone.id, pinId),
      onDescribePin: (pinId) => void store().describePin(slideId, zone.id, pinId),
      onCancelDescribe: (pinId) => void store().cancelPinJob(pinId),
      onInspect: () => void store().inspectImage(slideId, zone.id),
      onReplace: () => void store().pickImage(slideId, zone.id),
      onResetPins: () => store().resetPins(slideId, zone.id),
      onRemoveImage: () => store().removeImage(slideId, zone.id),
    };
  }, [slideId, zone.id]);

  const inlineHandlers = useMemo<PinHandlers>(
    () => ({ ...handlers, onExpand: () => useDeckStore.getState().setFocusZone({ slideId, zoneId: zone.id }) }),
    [handlers, slideId, zone.id],
  );

  const closeExpanded = useCallback(() => useDeckStore.getState().setFocusZone(null), []);

  const dragProps = {
    onDragEnter,
    onDragOver: (event: React.DragEvent) => event.preventDefault(),
    onDragLeave,
    onDrop,
  };
  const pointerProps = {
    onPointerEnter: () => {
      hoveredTarget = target;
    },
    onPointerLeave: () => {
      if (hoveredTarget?.zoneId === zone.id) hoveredTarget = null;
    },
    onFocus: () => {
      focusedTarget = target;
    },
    onBlur: (event: React.FocusEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node) && focusedTarget?.zoneId === zone.id) focusedTarget = null;
    },
  };

  if (zone.image) {
    const image = zone.image;
    const imageUrl = bridge.assetUrl(projectId, image);
    return (
      <div
        data-testid="dropzone"
        data-zone-id={zone.id}
        data-filled="true"
        data-drag-over={dragOver}
        className={cn('relative min-w-0', dragOver && 'rounded-[6px] outline-2 outline-offset-2 outline-accent')}
        {...dragProps}
        {...pointerProps}
      >
        <AnnotatedImage
          imageUrl={imageUrl}
          imageWidth={image.width}
          imageHeight={image.height}
          alt={zone.aiVisualPrompt || image.fileName}
          pins={zone.pins}
          leaderStyle={leaderStyle}
          handlers={inlineHandlers}
          liveDescriptions={liveDescriptions}
        />
        {expanded && (
          <Modal title={title} subtitle={image.fileName} onClose={closeExpanded} className="h-[min(92vh,900px)] max-w-[min(94vw,1400px)]" testId="annotate-modal">
            <div className="flex h-full items-center justify-center p-4">
              <div className="canvas-fit h-full w-full" style={{ '--image-ratio': image.width / image.height } as React.CSSProperties}>
                <AnnotatedImage
                  imageUrl={imageUrl}
                  imageWidth={image.width}
                  imageHeight={image.height}
                  alt={zone.aiVisualPrompt || image.fileName}
                  pins={zone.pins}
                  leaderStyle={leaderStyle}
                  handlers={handlers}
                  liveDescriptions={liveDescriptions}
                />
              </div>
            </div>
          </Modal>
        )}
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Image dropzone: ${zone.aiVisualPrompt || 'add an image'}`}
      data-testid="dropzone"
      data-zone-id={zone.id}
      data-filled="false"
      data-drag-over={dragOver}
      onClick={() => void useDeckStore.getState().pickImage(slideId, zone.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void useDeckStore.getState().pickImage(slideId, zone.id);
        }
      }}
      className={cn(
        'flex min-h-[148px] cursor-pointer flex-col items-center justify-center gap-2 rounded-[6px] border border-dashed px-4 py-5 text-center transition-colors duration-100',
        'border-[#D3D1CB] hover:bg-sidebar focus:bg-sidebar focus:outline-none dark:border-[#373737]',
        dragOver && 'border-accent bg-accent-soft hover:bg-accent-soft',
      )}
      {...dragProps}
      {...pointerProps}
    >
      <AppIcon icon={importing ? 'lucide:loader-circle' : dragOver ? 'lucide:download' : 'lucide:image-plus'} size={20} className={cn('text-ink-3', importing && 'spin')} />
      {zone.aiVisualPrompt && <p className="max-w-[46ch] text-xs leading-relaxed text-ink-2">{zone.aiVisualPrompt}</p>}
      <p className="text-[11px] text-ink-3">
        {importing ? 'Saving image' : `Drop an image, click to browse, or hover and press ${modKey}+V`}
      </p>
    </div>
  );
});
