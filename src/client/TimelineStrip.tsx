/**
 * The timeline, turned sideways.
 *
 * Collapsed mode gives the arena the whole window, so the rail's column of
 * steps becomes a row of pills under it and every Beat card becomes one thin
 * bar across the steps it spans: cast colour on the left, amber on the right,
 * the Snap diamond on its seam and the hollow tail after it. It is a reading
 * instrument — nothing in here edits the plan.
 */
import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";
import {
  VARIANT_COLORS,
  freezeStep,
  mechColor,
  mechLabel,
  mechSpan,
  mechanicLabel,
  mechanicSteps,
  type Mech,
  type Plan,
  type Step,
} from "../shared/schema";
import {
  boxedBeatIds,
  defaultStepVariantSelections,
  stepVariantLabel,
  stepVariants,
} from "../shared/step-variants";

/** A step pill and the column of timeline under it. */
const PILL = 40;
const PILL_GAP = 4;
const PILL_H = 44;
/** One Beat is one 8px bar; lanes are 12px apart, so bars never touch. */
const BAR = 8;
const LANE = 12;

/** A hex colour as a translucent CSS rgba — the rail's own helper, in miniature. */
function tint(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** The Snap marker, the same diamond the rail draws. */
function Diamond({ size, fill }: { size: number; fill: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true" className="block">
      <path d="M5 0.7L9.3 5 5 9.3 0.7 5z" fill={fill} stroke="#e6ebf2" strokeWidth="1.2" />
    </svg>
  );
}

function Chevron({ back }: { back?: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
      className="shrink-0"
      style={{ transform: back ? "rotate(180deg)" : undefined }}
    >
      <path d="M3 1 L7 5 L3 9" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

type Bar = { mech: Mech; lo: number; hi: number; lane: number; snap: number };

export function TimelineStrip({
  plan,
  index,
  width,
  shown,
  openMech,
  onSelect,
  onOpenMech,
  onFocusBeat,
  onShow,
  onEditBeatVariant,
}: {
  plan: Plan;
  /** The step being looked at, as an index into `plan.steps`. */
  index: number;
  /** How wide the arena above is: the strip is the arena's width. */
  width: number;
  shown: Record<string, string>;
  openMech: string | null;
  onSelect(i: number): void;
  onOpenMech(id: string | null): void;
  onFocusBeat(id: string): void;
  onShow: Dispatch<SetStateAction<Record<string, string>>>;
  onEditBeatVariant(id: string | null): void;
}) {
  /** The one-line note opens to its full text on a tap, and closes again. */
  const [noteOpen, setNoteOpen] = useState(false);

  const at = Math.min(Math.max(index, 0), plan.steps.length - 1);
  const current: Step | undefined = plan.steps[at];
  const mechanicId = current?.mechanic ?? null;
  const mechanicAt = plan.mechanics.findIndex((m) => m.id === mechanicId);
  const mechanic = mechanicAt >= 0 ? plan.mechanics[mechanicAt] : null;
  const visible = mechanic ? mechanicSteps(plan, mechanic.id) : plan.steps;
  const row = new Map(visible.map((s, i) => [s.id, i]));
  const selected = visible.findIndex((s) => s.id === current?.id);

  /* --- which Beats are on this strip ---------------------------------- */

  const boxed = boxedBeatIds(plan);
  const fallback = defaultStepVariantSelections(plan);
  /** A Beat inside a Variant box is on the strip only while its box is the one being read. */
  const previewing = (id: string) => {
    for (const owner of plan.steps) {
      const variants = stepVariants(owner);
      const mine = variants.find((variant) => variant.beats.includes(id));
      if (!mine) continue;
      const chosen = shown[owner.id] ?? fallback[owner.id] ?? variants[0]?.id;
      return mine.id === chosen;
    }
    return true;
  };

  // Greedy first-fit, exactly as the rail packs its lanes: two Beats over the
  // same steps stack rather than overlap.
  const bars: Bar[] = [];
  for (const mech of plan.mechs) {
    if (!row.has(mech.snap)) continue;
    if (boxed.has(mech.id) && !previewing(mech.id)) continue;
    const rows = mechSpan(plan, mech)
      .map((id) => row.get(id))
      .filter((i): i is number => i !== undefined);
    if (!rows.length) continue;
    const lo = Math.min(...rows);
    const hi = Math.max(...rows);
    const freeze = row.get(freezeStep(plan, mech));
    const snap = Math.min(Math.max(freeze ?? lo, lo), Math.max(lo, hi - 1));
    let lane = 0;
    while (bars.some((b) => b.lane === lane && b.lo <= hi && b.hi >= lo)) lane++;
    bars.push({ mech, lo, hi, lane, snap });
  }
  const lanes = bars.reduce((n, b) => Math.max(n, b.lane + 1), 0);

  /* --- the Variant splits over these steps ---------------------------- */

  const splits = visible
    .map((owner) => ({ owner, variants: stepVariants(owner) }))
    .filter(({ variants }) => variants.length >= 2);

  /* --- geometry -------------------------------------------------------- */

  const trackW = visible.length * PILL + Math.max(0, visible.length - 1) * PILL_GAP;
  const x = (i: number) => i * (PILL + PILL_GAP);
  const barsH = Math.max(LANE, lanes * LANE) + 8;

  const go = (i: number) => {
    const step = visible[i];
    if (step) onSelect(plan.steps.indexOf(step));
  };
  const goMechanic = (delta: number) => {
    const next = plan.mechanics[mechanicAt + delta];
    if (!next) return;
    const first = mechanicSteps(plan, next.id)[0];
    if (first) onSelect(plan.steps.indexOf(first));
  };

  const notes = current?.notes ?? "";

  return (
    <div
      data-timeline-strip
      className="mx-auto shrink-0 rounded-md border border-ink-700 bg-ink-800 pb-2.5 pt-2"
      style={{ width: width || undefined }}
    >
      {/* Which part of the fight this is, and the two beside it. */}
      <div className="flex items-center gap-1.5 px-3 pb-2">
        <button
          type="button"
          data-strip-mechanic="prev"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-400 hover:bg-ink-700 hover:text-ink-200 disabled:opacity-30"
          title="The mechanic before this one"
          aria-label="Previous mechanic"
          disabled={mechanicAt <= 0}
          onClick={() => goMechanic(-1)}
        >
          <Chevron back />
        </button>
        <span className="min-w-0 flex-1 truncate text-center text-xs leading-4 text-ink-200">
          {mechanic ? mechanicLabel(plan, mechanic) : "Timeline"}
        </span>
        <button
          type="button"
          data-strip-mechanic="next"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-400 hover:bg-ink-700 hover:text-ink-200 disabled:opacity-30"
          title="The mechanic after this one"
          aria-label="Next mechanic"
          disabled={mechanicAt < 0 || mechanicAt >= plan.mechanics.length - 1}
          onClick={() => goMechanic(1)}
        >
          <Chevron />
        </button>
      </div>

      <div className="overflow-x-auto">
        <div className="relative mx-auto" style={{ width: trackW }}>
          {/* The steps, as taps. */}
          <div className="relative" style={{ height: PILL_H }}>
            {visible.map((step, i) => (
              <button
                key={step.id}
                type="button"
                data-strip-step={step.id}
                aria-current={i === selected ? "step" : undefined}
                title={`Step ${i + 1}${step.name ? ` — ${step.name}` : ""}`}
                className={`absolute top-0 grid place-items-center rounded-md text-sm ${
                  i === selected ? "bg-ink-600 font-semibold text-white" : "text-ink-400"
                }`}
                style={{ left: x(i), width: PILL, height: PILL_H }}
                onClick={() => go(i)}
              >
                {i + 1}
              </button>
            ))}
          </div>

          {/* One bar per Beat, over the steps it is on the floor for. */}
          <div className="relative mt-1.5" style={{ height: barsH }}>
            {selected >= 0 && (
              <div
                aria-hidden
                className="absolute rounded"
                style={{
                  left: x(selected),
                  top: -4,
                  width: PILL,
                  height: barsH + 4,
                  background: "rgba(46,53,67,0.5)",
                }}
              />
            )}
            {bars.map(({ mech, lo, hi, lane, snap }) => {
              const color = mechColor(plan, mech);
              const left = x(lo);
              const right = x(hi) + PILL;
              const marked = hi - lo + 1 >= 3;
              // The seam falls in the gap after the step the Beat freezes in.
              const cut = x(snap) + PILL + PILL_GAP / 2;
              return (
                <button
                  key={mech.id}
                  type="button"
                  data-strip-beat={mech.id}
                  aria-pressed={openMech === mech.id}
                  title={`${mechLabel(plan, mech)} — casts in step ${lo + 1}, resolves in step ${hi + 1}`}
                  className="absolute box-border rounded-sm"
                  style={{
                    left,
                    top: lane * LANE,
                    width: right - left,
                    height: BAR,
                    borderLeft: `2px solid ${color}`,
                    borderRight: "3px solid rgba(251,191,36,0.8)",
                    background: tint(color, 0.3),
                    overflow: "visible",
                  }}
                  onClick={() => {
                    go(lo);
                    onOpenMech(mech.id);
                    onFocusBeat(mech.id);
                  }}
                >
                  {/* Past the seam the Beat is drawn on its snapshot: the fill
                      drains out and only the edges keep its colour. */}
                  {marked && snap < hi && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0 right-0"
                      style={{
                        left: cut - left - 2,
                        background: "rgba(20,23,28,0.5)",
                        boxShadow: `inset 0 1px 0 ${tint(color, 0.55)}, inset 0 -1px 0 ${tint(color, 0.55)}`,
                      }}
                    />
                  )}
                  {marked && (
                    <span
                      aria-hidden
                      data-strip-freeze={mech.id}
                      className="pointer-events-none absolute"
                      style={{ left: cut - left - 6, top: -2 }}
                    >
                      <Diamond size={12} fill={color} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* The splits over these steps, and the note for the step you are on. */}
      <div className="mt-0.5 flex items-center gap-2 px-3">
        {splits.map(({ owner, variants }) => {
          const chosen = shown[owner.id] ?? fallback[owner.id] ?? variants[0]?.id;
          return (
            <div
              key={owner.id}
              data-strip-variants={owner.id}
              title={`A Variant split at ${owner.name || "this Step"} — tap a side to read it`}
              className="inline-flex shrink-0 overflow-hidden rounded border border-ink-400/70 text-[10px] font-bold leading-[18px] tracking-[0.04em]"
            >
              {variants.map((variant, i) => {
                const color = VARIANT_COLORS[i % VARIANT_COLORS.length];
                const on = variant.id === chosen;
                return (
                  <button
                    key={variant.id}
                    type="button"
                    data-strip-variant={variant.id}
                    aria-pressed={on}
                    className="px-2"
                    style={{ background: on ? color : undefined, color: on ? "#14171c" : undefined }}
                    onClick={() => {
                      onShow((choices) => ({ ...choices, [owner.id]: variant.id }));
                      onFocusBeat(owner.id);
                      onEditBeatVariant(variant.id);
                    }}
                  >
                    {stepVariantLabel(owner, variant.id)}
                  </button>
                );
              })}
            </div>
          );
        })}
        <button
          type="button"
          data-strip-note
          title={notes ? "Tap for the whole note" : "This step has no notes"}
          className={`min-w-0 flex-1 rounded border bg-ink-900/85 px-2 py-1 text-left text-xs leading-4 shadow-sm ${
            notes ? "border-ink-600/70 text-ink-100" : "border-ink-600/50 text-ink-400"
          } ${noteOpen ? "whitespace-pre-wrap" : "truncate"}`}
          onClick={() => setNoteOpen((open) => !open)}
        >
          {notes || "No notes on this step"}
        </button>
      </div>
    </div>
  );
}
