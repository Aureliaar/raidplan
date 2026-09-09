import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

/**
 * One point-anchored context menu for the whole app.
 *
 * The menu is not owned by whoever opened it: `openContextMenu` writes a tiny
 * module-level store and the single `<ContextMenuHost />` at the app root draws
 * it. That is what lets the Konva canvas — a bare <canvas> with no React nodes
 * inside it — put up the same menu a React panel does, with the same keyboard
 * handling and the same dismissal rules.
 */

/** A row that does something, or opens a submenu. */
export interface MenuAction {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  children?: MenuItem[];
}
/** A hairline between two runs of rows. */
export interface MenuSeparator {
  separator: true;
}
/** A small-caps caption over a run of rows: "Beat", "Step", "3 selected". */
export interface MenuHeading {
  heading: string;
}
export type MenuItem = MenuAction | MenuSeparator | MenuHeading;

export interface MenuPoint {
  x: number;
  y: number;
}

export const isSeparator = (item: MenuItem): item is MenuSeparator =>
  "separator" in item && item.separator === true;
export const isHeading = (item: MenuItem): item is MenuHeading => "heading" in item;
const isAction = (item: MenuItem): item is MenuAction =>
  !isSeparator(item) && !isHeading(item);

interface MenuState {
  /** Bumped per opening, so a reopen at the same point still remounts. */
  key: number;
  point: MenuPoint;
  items: MenuItem[];
}

let state: MenuState | null = null;
let opened = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Put the menu up at a viewport point. Items are read once, at open time. */
export function openContextMenu(point: MenuPoint, items: MenuItem[]): void {
  if (!items.length) {
    closeContextMenu();
    return;
  }
  state = { key: ++opened, point, items };
  emit();
}

export function closeContextMenu(): void {
  if (!state) return;
  state = null;
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => state;

/** A field whose own menu is worth more than ours: cut, paste, spellcheck. */
function inNativeField(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return !!el.closest("input, textarea, [contenteditable=''], [contenteditable='true']");
}

const ROW =
  "flex h-7 w-full items-center gap-2 whitespace-nowrap px-3 text-left text-[13px] leading-none";

function MenuRows({
  items,
  point,
  /** Which edge the parent grew from, so a chain of submenus keeps going that way. */
  flipped,
  onClose,
  onDismissBranch,
  autoFocus,
}: {
  items: MenuItem[];
  point: MenuPoint;
  flipped?: boolean;
  onClose(): void;
  /** ArrowLeft / pointer leaving a submenu: hand focus back to the parent row. */
  onDismissBranch?(): void;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const [open, setOpen] = useState<{ index: number; point: MenuPoint; flipped: boolean } | null>(null);

  // Measure, then place: a menu must never be drawn hanging off the viewport,
  // not even for the frame before it is corrected.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 6;
    let left = flipped ? point.x - width : point.x;
    if (left + width > window.innerWidth - pad) left = point.x - width;
    if (left < pad) left = Math.min(pad, window.innerWidth - width - pad);
    let top = point.y;
    if (top + height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - height - pad);
    if (top < pad) top = pad;
    setAt({ left, top });
  }, [items, point.x, point.y, flipped]);

  useEffect(() => {
    if (!autoFocus) return;
    const first = rowRefs.current.find((row) => row && !row.disabled);
    first?.focus();
  }, [autoFocus]);

  const actionIndexes = items.flatMap((item, index) =>
    isAction(item) && !item.disabled ? [index] : []
  );

  const focusStep = (delta: number) => {
    const rows = rowRefs.current;
    const here = actionIndexes.findIndex((index) => rows[index] === document.activeElement);
    const next =
      actionIndexes[
        here < 0
          ? delta > 0
            ? 0
            : actionIndexes.length - 1
          : (here + delta + actionIndexes.length) % actionIndexes.length
      ];
    rows[next]?.focus();
  };

  const openSub = (index: number, row: HTMLElement) => {
    const rect = row.getBoundingClientRect();
    // Grow to the right unless there is no room there — then to the left, and
    // every submenu below it keeps going the same way.
    const right = rect.right - 2;
    const wantFlip = flipped || right + 180 > window.innerWidth - 6;
    setOpen({
      index,
      point: { x: wantFlip ? rect.left + 2 : right, y: rect.top - 4 },
      flipped: wantFlip,
    });
  };

  return (
    <div
      ref={ref}
      data-context-menu
      role="menu"
      className="fixed z-[200] min-w-[180px] max-w-[320px] rounded border border-ink-600 bg-ink-700 py-1 shadow-xl shadow-black/50"
      style={{
        left: at?.left ?? point.x,
        top: at?.top ?? point.y,
        visibility: at ? "visible" : "hidden",
      }}
      onKeyDown={(ev) => {
        if (ev.key === "ArrowDown") {
          ev.preventDefault();
          ev.stopPropagation();
          focusStep(1);
        } else if (ev.key === "ArrowUp") {
          ev.preventDefault();
          ev.stopPropagation();
          focusStep(-1);
        } else if (ev.key === "ArrowLeft") {
          if (!onDismissBranch) return;
          ev.preventDefault();
          ev.stopPropagation();
          onDismissBranch();
        }
      }}
    >
      {items.map((item, index) => {
        if (isSeparator(item))
          return <div key={`sep-${index}`} role="separator" className="my-1 h-px bg-ink-600" />;
        if (isHeading(item))
          return (
            <div key={`head-${index}`} className="label px-3 pb-0.5 pt-1">
              {item.heading}
            </div>
          );
        const sub = item.children?.length ? item.children : undefined;
        return (
          <button
            key={`${item.label}-${index}`}
            type="button"
            role="menuitem"
            data-menu-item={item.label}
            aria-disabled={item.disabled || undefined}
            aria-haspopup={sub ? "menu" : undefined}
            aria-expanded={sub ? open?.index === index : undefined}
            disabled={item.disabled}
            ref={(node) => {
              rowRefs.current[index] = node;
            }}
            className={`${ROW} ${
              item.disabled
                ? "cursor-default text-ink-400"
                : item.danger
                  ? "text-red-300 hover:bg-red-900/50 focus:bg-red-900/50"
                  : "text-ink-100 hover:bg-ink-600 focus:bg-ink-600"
            } focus:outline-none`}
            onMouseEnter={(ev) => {
              if (item.disabled) return;
              ev.currentTarget.focus();
              if (sub) openSub(index, ev.currentTarget);
              else setOpen(null);
            }}
            onClick={(ev) => {
              if (item.disabled) return;
              if (sub) {
                openSub(index, ev.currentTarget);
                return;
              }
              onClose();
              item.onSelect?.();
            }}
            onKeyDown={(ev) => {
              if (ev.key === "ArrowRight" && sub) {
                ev.preventDefault();
                ev.stopPropagation();
                openSub(index, ev.currentTarget);
              } else if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                ev.stopPropagation();
                if (sub) openSub(index, ev.currentTarget);
                else {
                  onClose();
                  item.onSelect?.();
                }
              }
            }}
          >
            <span className="w-3 shrink-0 text-accent">{item.checked ? "✓" : ""}</span>
            <span className="flex-1 truncate">{item.label}</span>
            {sub && <span className="shrink-0 text-ink-400">›</span>}
          </button>
        );
      })}
      {open && (() => {
        const parent = items[open.index];
        const sub = isAction(parent) ? parent.children : undefined;
        if (!sub?.length) return null;
        return (
          <MenuRows
            items={sub}
            point={open.point}
            flipped={open.flipped}
            onClose={onClose}
            onDismissBranch={() => {
              setOpen(null);
              rowRefs.current[open.index]?.focus();
            }}
          />
        );
      })()}
    </div>
  );
}

/**
 * Mounted once at the app root. It owns the global right-click hijack, the
 * dismissal rules, and the key capture that stops the editor's own Delete and
 * Escape handlers from firing at a menu row.
 */
export function ContextMenuHost() {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const close = useCallback(() => closeContextMenu(), []);

  // The native menu never shows outside a text field. Whether *our* menu shows
  // is up to whoever owns the pixels: a component claims the event by calling
  // openContextMenu from its own handler, which runs after this capture pass.
  // Nothing claimed it by the end of the turn means the floor was empty, so
  // any menu still up is dismissed.
  useEffect(() => {
    const onContextMenu = (ev: MouseEvent) => {
      if (inNativeField(ev.target)) return;
      ev.preventDefault();
      if (ev.target instanceof Element && ev.target.closest("[data-context-menu]")) return;
      const before = opened;
      setTimeout(() => {
        if (opened === before) closeContextMenu();
      }, 0);
    };
    document.addEventListener("contextmenu", onContextMenu, { capture: true });
    return () => document.removeEventListener("contextmenu", onContextMenu, { capture: true });
  }, []);

  useEffect(() => {
    if (!current) return;
    const onPointerDown = (ev: PointerEvent) => {
      if (ev.target instanceof Element && ev.target.closest("[data-context-menu]")) return;
      closeContextMenu();
    };
    const onScroll = () => closeContextMenu();
    const onBlur = () => closeContextMenu();
    // Escape has to beat the editor's own window keydown, which would otherwise
    // step out of variant editing behind the menu; Delete has to be swallowed
    // outright, because the editor deletes the selection on it.
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        closeContextMenu();
        return;
      }
      if (ev.key === "Delete" || ev.key === "Backspace") {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("scroll", onScroll, { capture: true });
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [current]);

  if (!current) return null;
  return createPortal(
    <MenuRows
      key={current.key}
      items={current.items}
      point={current.point}
      onClose={close}
      autoFocus
    />,
    document.body
  );
}
