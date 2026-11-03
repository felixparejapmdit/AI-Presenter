import { useToastStore, type ToastKind } from '../../store/useToastStore';
import { AppIcon } from './AppIcon';

const ICONS: Record<ToastKind, { icon: string; className: string }> = {
  info: { icon: 'lucide:info', className: 'text-ink-2' },
  success: { icon: 'lucide:check', className: 'text-ok' },
  error: { icon: 'lucide:circle-alert', className: 'text-danger' },
};

export function Toasts() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  return (
    <div
      className="pointer-events-none fixed right-3 bottom-3 z-[100] flex w-[min(380px,calc(100vw-24px))] flex-col items-end gap-2"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div key={toast.id} role="status" data-kind={toast.kind} className="popover fade-in pointer-events-auto flex w-full items-center gap-2 px-3 py-2 text-[13px]">
          <AppIcon icon={ICONS[toast.kind].icon} className={ICONS[toast.kind].className} />
          <span className="min-w-0 flex-1 break-words">{toast.message}</span>
          {toast.actionLabel && (
            <button
              type="button"
              className="btn h-6 px-1.5 text-accent"
              onClick={() => {
                toast.onAction?.();
                dismiss(toast.id);
              }}
            >
              {toast.actionLabel}
            </button>
          )}
          <button type="button" className="btn btn-icon h-6 w-6" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
            <AppIcon icon="lucide:x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
