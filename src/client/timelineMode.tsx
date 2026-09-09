/**
 * How much of the timeline is on screen.
 *
 * The rail is the plan's spine when you are building it and dead weight when
 * you are only reading it, so it has three sizes rather than one: Collapsed
 * turns it sideways into a strip under the arena, Normal is the rail that
 * ships, Expanded is the same rail with room to grab things.
 *
 * It is a preference of this browser, not of the plan: two people reading the
 * same link may want different amounts of chrome, and neither of them is
 * editing the document by choosing.
 */
import { useEffect, useState } from "react";

export type TimelineMode = "collapsed" | "normal" | "expanded";

const KEY = "raidplan.timelineMode";

/** Below this a rail costs more width than the arena can spare on first load. */
const NARROW_ON_LOAD = 900;
/** Below this there is no room for a rail at all, whatever the preference says. */
export const FORCED_COLLAPSE = 700;

const MODES: TimelineMode[] = ["collapsed", "normal", "expanded"];

/** The stored preference, or null when this browser has never chosen. */
export function loadTimelineMode(): TimelineMode | null {
  try {
    const stored = window.localStorage.getItem(KEY);
    return MODES.includes(stored as TimelineMode) ? (stored as TimelineMode) : null;
  } catch {
    return null;
  }
}

export function saveTimelineMode(mode: TimelineMode) {
  try {
    window.localStorage.setItem(KEY, mode);
  } catch {
    /* A browser with storage turned off still gets to switch modes. */
  }
}

/**
 * What a browser that has never chosen should open with: a plan you cannot
 * edit, or a window too narrow to spend on a rail, opens as the strip.
 */
export function defaultTimelineMode({
  editable,
  width,
}: {
  editable: boolean;
  width: number;
}): TimelineMode {
  return !editable || width < NARROW_ON_LOAD ? "collapsed" : "normal";
}

/** The viewport width, as a number that re-renders when the window changes. */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth
  );
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

const LABEL: Record<TimelineMode, string> = {
  collapsed: "Collapsed",
  normal: "Normal",
  expanded: "Expanded",
};

const TITLE: Record<TimelineMode, string> = {
  collapsed: "Collapsed — the timeline as a strip under the arena, for reading",
  normal: "Normal — the timeline rail beside the arena",
  expanded: "Expanded — the rail with room to grab edges and the Snap marker",
};

/** The three-segment switch. Same control wherever it is put. */
export function TimelineModeSwitch({
  value,
  onChange,
}: {
  value: TimelineMode;
  onChange(mode: TimelineMode): void;
}) {
  return (
    <div
      data-timeline-mode={value}
      role="group"
      aria-label="Timeline size"
      title="How much of the timeline is on screen"
      className="inline-flex shrink-0 rounded border border-ink-600 bg-ink-900 p-px"
    >
      {MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          data-mode-option={mode}
          aria-pressed={value === mode}
          title={TITLE[mode]}
          className={`rounded-[3px] px-1.5 py-px text-[10px] leading-[14px] ${
            value === mode ? "bg-ink-600 text-white" : "text-ink-400 hover:text-ink-200"
          }`}
          onClick={() => onChange(mode)}
        >
          {LABEL[mode]}
        </button>
      ))}
    </div>
  );
}
