import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';
import { AppIcon } from './AppIcon';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  icon?: string;
}

interface SelectProps<T extends string> {
  value: T | null;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  label: string;
  placeholder?: string;
  icon?: string;
  className?: string;
  buttonClassName?: string;
  emptyContent?: ReactNode;
  footer?: { label: string; icon?: string; onSelect: () => void };
  testId?: string;
  minMenuWidth?: number;
  disabled?: boolean;
  /** Renders the placeholder at full strength, for action menus that have no selected value. */
  plainPlaceholder?: boolean;
}

interface MenuPosition {
  left: number;
  top: number;
  minWidth: number;
  maxHeight: number;
}

const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

/**
 * Notion-style listbox. The menu is portaled to the body so scrolling panes never clip
 * it, and it is positioned before paint so it cannot visibly jump.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  placeholder = 'Select',
  icon,
  className,
  buttonClassName,
  emptyContent,
  footer,
  testId,
  minMenuWidth = 180,
  disabled,
  plainPlaceholder,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const current = options.find((option) => option.value === value);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setPosition(null);
    if (refocus) buttonRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const button = buttonRef.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (!button || !menu) return;

    const minWidth = Math.max(button.width, minMenuWidth);
    const spaceBelow = window.innerHeight - button.bottom - VIEWPORT_MARGIN - MENU_GAP;
    const spaceAbove = button.top - VIEWPORT_MARGIN - MENU_GAP;
    const placeBelow = menu.height <= spaceBelow || spaceBelow >= spaceAbove;
    const maxHeight = Math.max(120, placeBelow ? spaceBelow : spaceAbove);
    const height = Math.min(menu.height, maxHeight);
    const width = Math.max(menu.width, minWidth);

    setPosition({
      left: Math.max(VIEWPORT_MARGIN, Math.min(button.left, window.innerWidth - width - VIEWPORT_MARGIN)),
      top: placeBelow ? button.bottom + MENU_GAP : button.top - MENU_GAP - height,
      minWidth,
      maxHeight,
    });
  }, [open, minMenuWidth, options.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close(false);
    };
    const onScrollOrResize = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      // An unrelated pane scrolling, such as the live analysis log, must not close the menu.
      if (event.target instanceof Node && buttonRef.current && !event.target.contains(buttonRef.current)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, close]);

  const openMenu = () => {
    if (disabled) return;
    const selected = options.findIndex((option) => option.value === value);
    setActiveIndex(selected >= 0 ? selected : 0);
    setOpen(true);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(options.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) {
        onChange(option.value);
        close();
      }
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  return (
    <div className={cn('relative min-w-0', className)}>
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-label={label}
        title={label}
        data-testid={testId}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
        className={cn('btn btn-outline w-full justify-between font-normal', buttonClassName)}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {(current?.icon ?? icon) && <AppIcon icon={current?.icon ?? icon!} size={14} className="text-ink-2" />}
          {/* A saved value shows at once, even before its option list has loaded. */}
          <span className={cn('truncate', !current && !value && !plainPlaceholder && 'text-ink-3')}>{current?.label ?? value ?? placeholder}</span>
        </span>
        <AppIcon icon="lucide:chevron-down" size={14} className="text-ink-3" />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={listboxId}
            role="listbox"
            aria-label={label}
            className="popover fixed z-[80] overflow-y-auto p-1"
            style={
              position
                ? { left: position.left, top: position.top, minWidth: position.minWidth, maxHeight: position.maxHeight }
                : { left: 0, top: 0, visibility: 'hidden' }
            }
            onKeyDown={onKeyDown}
          >
            {options.length === 0 && emptyContent && <div className="px-2 py-1.5 text-[13px] text-ink-2">{emptyContent}</div>}
            {options.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                onPointerEnter={() => setActiveIndex(index)}
                onClick={() => {
                  onChange(option.value);
                  close();
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-[13px]',
                  index === activeIndex && 'bg-hover',
                )}
              >
                {option.icon && <AppIcon icon={option.icon} size={14} className="text-ink-2" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  {option.hint && <span className="block truncate text-[11px] text-ink-2">{option.hint}</span>}
                </span>
                {option.value === value && <AppIcon icon="lucide:check" size={14} className="text-accent" />}
              </button>
            ))}
            {footer && (
              <>
                {options.length > 0 && <div className="my-1 h-px bg-line" />}
                <button
                  type="button"
                  onClick={() => {
                    close(false);
                    footer.onSelect();
                  }}
                  className="flex w-full items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
                >
                  {footer.icon && <AppIcon icon={footer.icon} size={14} />}
                  {footer.label}
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
