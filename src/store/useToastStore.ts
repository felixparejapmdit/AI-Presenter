import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>, durationMs?: number) => number;
  dismiss: (id: number) => void;
  /** Called when the deck changes, because an undo offer now describes an older action. */
  dismissUndoable: () => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push(toast, durationMs = 4200) {
    const id = nextId++;
    set({ toasts: [...get().toasts.slice(-3), { ...toast, id }] });
    window.setTimeout(() => get().dismiss(id), durationMs);
    return id;
  },
  dismiss(id) {
    const remaining = get().toasts.filter((toast) => toast.id !== id);
    if (remaining.length !== get().toasts.length) set({ toasts: remaining });
  },
  dismissUndoable() {
    const remaining = get().toasts.filter((toast) => !toast.onAction);
    if (remaining.length !== get().toasts.length) set({ toasts: remaining });
  },
}));

export const toast = {
  info: (message: string) => useToastStore.getState().push({ kind: 'info', message }),
  success: (message: string) => useToastStore.getState().push({ kind: 'success', message }),
  error: (message: string) => useToastStore.getState().push({ kind: 'error', message }, 7000),
  undoable: (message: string, onAction: () => void) =>
    useToastStore.getState().push({ kind: 'info', message, actionLabel: 'Undo', onAction }, 6500),
};
