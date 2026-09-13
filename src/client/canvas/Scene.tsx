import {
  Fragment,
  type MutableRefObject,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  Arrow,
  Circle,
  Ellipse,
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Rect,
  RegularPolygon,
  Ring,
  Shape,
  Stage,
  Text,
  Wedge,
} from "react-konva";
import type Konva from "konva";
import type { Entity, Plan, ZoneEntity } from "../../shared/schema";
import { authoredEntitiesForStep, entitiesForStep, fanOwnerId, isFanCopy, isLocked, tetherEnds } from "../../shared/schema";
import { composeStepVariantEntities } from "../../shared/step-variants";
import { jobColor, jobLabel } from "../../shared/jobs";
import { type DebuffDress, dressIconKey } from "../../shared/debuffs";
import { assetUrl, enemyIconKey, jobIconKey, waymarkIconKey } from "../../shared/assets";
import {
  symmetricUpdates,
  symmetryMemberIds,
  type SymmetryCount,
  type SymmetryKind,
} from "../symmetry";

/**
 * Top-down arena renderer. Everything is drawn in arena units inside one scaled
 * group, so the plan JSON never has to know about pixels.
 */

/**
 * The stage is wider than the arena so anything sitting on — or just past — a
 * wall keeps drawing instead of being cut off at the canvas edge. Everything
 * that maps arena units to pixels goes through viewScale so the drop point, the
 * notes card and the canvas all agree on where the floor is.
 */
export const VIEW_MARGIN = 1.18;

export function viewScale(arena: Plan["arena"], size: number): number {
  return size / (Math.max(arena.width, arena.height) * VIEW_MARGIN);
}

const ZONE_DEFAULT = "#ff7043";
const MARKER_COLORS: Record<string, string> = {
  A: "#e05252",
  B: "#e0c452",
  C: "#5aa8e0",
  D: "#b06ce0",
  "1": "#e05252",
  "2": "#e0c452",
  "3": "#5aa8e0",
  "4": "#b06ce0",
};

/**
 * Draw order runs in bands, the way XIVPlan layers a plan: ground effects first,
 * then people, then annotations. Without this an AoE added after the party would
 * cover the tokens and swallow every click on them. `reorder_entity` still
 * shuffles entities within their own band.
 */
// Waymarks are the floor's own labels: they go under everything, and are then
// drawn once more, faint, over everything -- see the ghost pass in `Scene`.
const DRAW_BAND: Record<Entity["type"], number> = {
  marker: -1,
  zone: 0,
  path: 1,
  tether: 3,
  enemy: 4,
  player: 5,
  icon: 6,
  text: 7,
};

function sortForDrawing(entities: Entity[]): Entity[] {
  return entities
    .map((entity, index) => ({ entity, index }))
    .sort((a, b) => DRAW_BAND[a.entity.type] - DRAW_BAND[b.entity.type] || a.index - b.index)
    .map((e) => e.entity);
}

/**
 * Which layer the pointer is working on. Waymarks sit under the whole plan and
 * never move once the fight starts, so a stray drag on one while you are laying
 * out a mechanic is always a mistake: they are frozen unless you deliberately
 * switch to their layer, and then everything else is frozen instead.
 */
export type EditLayer = "step" | "markers";

/** What a right-click on the canvas landed on, in viewport and arena coordinates. */
export type SceneContextTarget =
  | { kind: "entity"; id: string; point: { x: number; y: number } }
  | { kind: "floor"; arenaPoint: { x: number; y: number }; point: { x: number; y: number } };

export interface SceneProps {
  plan: Plan;
  /** Uncommitted palette shapes at the point where the current drop would land. */
  preview?: Entity[];
  stepId?: string;
  /** Which reading of each mechanic is being played, by mechanic id. */
  shown?: Record<string, string>;
  size: number;
  selected: string[];
  editable: boolean;
  symmetryCount?: SymmetryCount;
  symmetryKind?: SymmetryKind;
  layer?: EditLayer;
  /** Which kinds of floor item get a leader and a chip beyond the selection: the party, the rest. */
  chips?: { party: boolean; others: boolean };
  /** Whether drags, turns and spreads settle onto round values (E). Alt still skips it per drag. */
  snapping?: boolean;
  /** A bond or mech id whose shapes should light up — the row being hovered. */
  highlight?: string | null;
  /** What the party wears while a debuff mech is on the floor, by player id. */
  dress?: Map<string, DebuffDress> | null;
  /**
   * Bumped every time the fight is walked from the keyboard. A click puts you
   * in the next step at once, which is what a click is for; a keypress is a
   * step of the fight happening, so the floor glides into it.
   */
  glide?: number;
  /**
   * Whether that walk is forwards through the fight. Going on, a cast that has
   * had its step goes off; going back, it simply un-happens — rewinding a hit
   * should not land it again.
   */
  onward?: boolean;
  /**
   * Filled with a function that starts a selection sweep from a mouse-down
   * that landed beside the canvas, so a box can be drawn in from the page
   * around it: the chips sit at the very edge, and the hand wants room.
   */
  sweep?: MutableRefObject<((ev: MouseEvent) => void) | null>;
  /** Intercept a click before normal selection/dragging, for two-click authoring tools. */
  onPick?(id: string): boolean;
  /**
   * A two-click tool is waiting for its second click. Choosing the boss as a
   * tether's other end does not touch the boss, so locks do not hide it then.
   */
  picking?: boolean;
  onSelect(ids: string[]): void;
  /**
   * A right-click on the floor or on something standing on it. The canvas is
   * one <canvas> element, so it cannot hand the event to a React node the way
   * the rest of the page does: it hit-tests exactly as a left-click would and
   * reports what was under the pointer instead.
   */
  onContextMenu?(target: SceneContextTarget): void;
  onMove(moves: { id: string; x: number; y: number }[]): void;
  /** Wheel over something: resize it (or a tether's range) by that factor. */
  onResize?(ids: string[], factor: number, what: "size" | "opacity"): void;
  /**
   * Direct-manipulation pins commit the selected entity's visual transform.
   * A stretch that holds one edge still moves the centre, so the patch may
   * carry a pose along with the dimension that displaced it.
   */
  onTransform?(
    id: string,
    patch: {
      factor: number;
      rotation?: number;
      innerRadius?: number;
      angle?: number;
      width?: number;
      length?: number;
      x?: number;
      y?: number;
    }
  ): Promise<unknown> | void;
}

/** How long the floor takes to walk into the next step, and its easing. */
const GLIDE_MS = 260;
/**
 * How the chips leave when the floor starts moving and how they come back. Out
 * quickly, because the picture they describe is already stale; back only after
 * a wait, so a run of step presses never flickers them in between.
 */
const CHIPS_OUT_MS = 120;
const CHIPS_WAIT_MS = 260;
const CHIPS_IN_MS = 220;
const ease = (p: number) => p * p * (3 - 2 * p);

/**
 * The same shapes, sliding to where the step puts them rather than appearing
 * there. Everything downstream — tethers, hit areas, which player a bait picks
 * — is solved from what this returns, so the whole picture moves together.
 *
 * A move always starts from where things are *on screen*, not from where the
 * step you were on says they were: press S twice quickly and the first walk is
 * abandoned where it got to, and the second sets off from there. Nothing is
 * queued, so holding a key never plays a backlog of moves you have stopped
 * caring about.
 */
function useGlide(
  target: Entity[],
  glide: number,
  onward: boolean
): { entities: Entity[]; going: Set<string>; blast: Map<string, number>; walking: boolean } {
  const [, frame] = useReducer((n: number) => n + 1, 0);
  /** What was on the floor when this move set off, and what is on it right now. */
  const from = useRef(new Map<string, Entity>());
  const drawn = useRef(new Map<string, Entity>());
  const startedAt = useRef(0);
  const at = useRef(1);
  const token = useRef(glide);
  const raf = useRef(0);

  // Read during the render that the target changed, not after it: an effect
  // would paint the new positions once before starting to move towards them.
  if (token.current !== glide) {
    token.current = glide;
    from.current = new Map(drawn.current);
    startedAt.current = performance.now();
    at.current = from.current.size ? 0 : 1;
  }

  useLayoutEffect(() => {
    if (at.current >= 1) return;
    const tick = () => {
      at.current = Math.min(1, (performance.now() - startedAt.current) / GLIDE_MS);
      frame();
      if (at.current < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [glide]);

  const p = at.current;
  const going = new Set<string>();
  /** How far through going off each leaving cast is, 0 to 1. */
  const blast = new Map<string, number>();
  if (p >= 1) {
    drawn.current = new Map(target.map((e) => [e.id, e]));
    return { entities: target, going, blast, walking: false };
  }

  const k = ease(p);
  const targetById = new Map(target.map((e) => [e.id, e]));
  const lerp = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
  });
  // A shape that is in both steps slides and, if it is drawn fainter in one of
  // them, fades as it goes. One that is only in the step being walked into
  // comes up out of nothing.
  const moving = target.map((e): Entity => {
    const was = from.current.get(e.id);
    if (!was) return { ...e, opacity: e.opacity * k };
    // A tether pinned where its Beat froze slides between pinned and following
    // too, rather than jumping across while the people it joins walk.
    if (e.type === "tether" && was.type === "tether" && (e.ends || was.ends)) {
      const a = tetherEnds(was, from.current);
      const b = tetherEnds(e, targetById);
      if (a && b)
        return {
          ...e,
          opacity: was.opacity + (e.opacity - was.opacity) * k,
          ends: { from: lerp(a.from, b.from), to: lerp(a.to, b.to) },
        };
    }
    return {
      ...e,
      x: was.x + (e.x - was.x) * k,
      y: was.y + (e.y - was.y) * k,
      opacity: was.opacity + (e.opacity - was.opacity) * k,
    };
  });
  // And one that the next step does not have is still on the floor while it
  // goes — an AoE resolving, not an AoE deleted. A zone goes off rather than
  // just leaving: it flares, swells a little, and is gone. Everything else
  // simply fades. Either way it is on its way out, so it cannot be grabbed.
  // A cast goes off only when the fight is going on: walking back up the steps,
  // or sideways into the other reading, it just leaves the floor.
  const flare = Math.sin(Math.PI * Math.min(1, k * 1.4));
  const here = new Set(target.map((e) => e.id));
  const leaving: Entity[] = [];
  for (const [id, was] of from.current) {
    if (here.has(id)) continue;
    going.add(id);
    if (was.type === "zone" && onward) blast.set(id, k);
    leaving.push(
      was.type === "zone" && onward
        ? {
            // A hit landing rather than a shape being turned off: it floods —
            // the clear heart of a telegraph fills in — punches outwards fast,
            // and only then blows out. A telegraph drawn faint has room to
            // flare on the way; one already at full just holds and goes.
            ...was,
            opacity: Math.min(1, was.opacity * (1 + 0.9 * flare)) * (1 - k * k * k),
            scale: was.scale * (1 + 0.4 * Math.sqrt(k)),
          }
        : { ...was, opacity: was.opacity * (1 - k) }
    );
  }
  // Underneath everything that is staying: a puddle going out should not wash
  // over the party walking away from it.
  const entities = leaving.length ? [...leaving, ...moving] : moving;
  drawn.current = new Map(entities.map((e) => [e.id, e]));
  return { entities, going, blast, walking: true };
}

/**
 * The chips stand down while the floor is in motion. A margin full of leaders
 * and plates relaid under the hand is the readout least worth having then: it
 * reflows faster than it can be read. So the leaders are cut the instant
 * something moves and the plates fade out from where they already stood, then
 * fade back in a beat after everything settles — which also means holding a
 * step key never flickers them in and out.
 *
 * Because they have a canvas to themselves, standing down costs nothing and
 * being away costs nothing: one redraw to cut the leaders, then a fade the
 * browser composites, and not a pixel more until they are wanted again.
 *
 * Both fades are driven straight at the canvas element rather than through
 * state: a render per frame is among the costs this is here to avoid.
 */
function useChipsFade(moving: boolean) {
  const layer = useRef<Konva.Layer>(null);
  const group = useRef<Konva.Group>(null);
  const leaders = useRef<Konva.Group>(null);
  /** False while the chips are away: still mounted, just not current or lit. */
  const [shown, setShown] = useState(true);
  const raf = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * Walk the chips' own canvas to `to`. This is a style on the canvas element,
   * not a Konva opacity: the browser composites it, so a fade costs no drawing
   * at all — which is the whole point of the chips having a canvas of their
   * own. Nothing is redrawn between the first frame of the fade and the last.
   */
  const fade = (to: number, ms: number, done?: () => void) => {
    const canvas = layer.current?.getNativeCanvasElement();
    if (!canvas) return done?.();
    const from = Number(canvas.style.opacity === "" ? 1 : canvas.style.opacity);
    const startedAt = performance.now();
    cancelAnimationFrame(raf.current);
    const tick = () => {
      const p = Math.min(1, (performance.now() - startedAt) / ms);
      canvas.style.opacity = String(from + (to - from) * p);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else done?.();
    };
    raf.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    clearTimeout(timer.current);
    if (moving) {
      if (!shown) return;
      // The leaders go at once. A hairline is a line drawn between two places,
      // and one of them has just started moving out from under it: held for
      // even a few frames it points at the wrong thing, which is worse than not
      // being drawn. Cutting them is the one redraw this layer gets; the plates
      // it fed then fade where they stand, on a canvas nothing touches again.
      leaders.current?.visible(false);
      layer.current?.batchDraw();
      setShown(false);
      fade(0, CHIPS_OUT_MS);
      return;
    }
    if (shown) return;
    timer.current = setTimeout(() => setShown(true), CHIPS_WAIT_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving, shown]);

  // Back on the floor at nothing, walking up to full. The layout is fresh by
  // now — the render that set this off rebuilt it — so all that is left is to
  // put the leaders back and let the browser bring the canvas up.
  useLayoutEffect(() => {
    if (!shown || !layer.current) return;
    leaders.current?.visible(true);
    layer.current.batchDraw();
    fade(1, CHIPS_IN_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  /**
   * A second layer is a second canvas, stacked over the first and covering the
   * whole stage. Konva hears the pointer on the container that holds them both
   * and does its own hit testing across layers, so this canvas never needs to
   * be a target itself — and left as one it shadows the floor beneath it for
   * anything that asks the document what is under the cursor. Reasserted on
   * every render because a resize rebuilds the element.
   */
  useLayoutEffect(() => {
    const canvas = layer.current?.getNativeCanvasElement();
    if (canvas) canvas.style.pointerEvents = "none";
  });

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      clearTimeout(timer.current);
    },
    []
  );

  return { layer, group, leaders, shown };
}

export function Scene({
  plan,
  preview = [],
  stepId,
  shown,
  size,
  selected,
  editable,
  symmetryCount = 1,
  symmetryKind = "mirror",
  layer = "step",
  chips = { party: false, others: false },
  snapping = true,
  highlight,
  dress,
  glide = 0,
  onward = true,
  sweep,
  onPick,
  picking,
  onSelect,
  onContextMenu,
  onMove,
  onResize,
  onTransform,
}: SceneProps) {
  const { arena } = plan;
  const scale = viewScale(arena, size);

  /**
   * Where the thing under the pointer is mid-drag, before the op that commits
   * it. Everything derived — tethers, baits, which player an autobait picks —
   * is solved from this, so the plan you are looking at while you drag is the
   * plan you will get when you let go.
   */
  const [dragging, setDragging] = useState<Map<string, { x: number; y: number }> | null>(null);
  const dragStart = useRef<{
    source: string;
    sourceAt: { x: number; y: number };
    pivot: { x: number; y: number };
    snapSymmetry: boolean;
    moved: boolean;
    members: Map<string, { x: number; y: number; shownX: number; shownY: number }>;
  } | null>(null);
  const [marquee, setMarquee] = useState<{
    from: { x: number; y: number };
    to: { x: number; y: number };
    additive: boolean;
  } | null>(null);
  /** Which radial-snap guides the current drag has earned drawing. */
  const [guides, setGuides] = useState<{
    spoke?: number;
    radius?: number;
    point?: { x: number; y: number };
  } | null>(null);
  useEffect(() => {
    // A response to an earlier edit can arrive during a new drag. Preserve the
    // gesture already in the hand; its drop will be serialized after that edit.
    if (!dragStart.current) setDragging(null);
  }, [plan.rev]);

  /**
   * Off-layer things are there for reference only: no clicks, no drags. A bonded
   * shape is off-layer too, always: it is one face of a set that lives with its
   * group, so grabbing the face would be grabbing the wrong thing.
   */
  /** The other layer's things: still drawn, but faded to say "not now". */
  const offLayer = (e: Entity) => (layer === "markers" ? e.type !== "marker" : e.type === "marker");
  // Bonded shapes are faces of a group-owned set and cannot be selected alone.
  // A tether is already immovable, though, and selecting one is how its shared
  // style/range becomes editable in the inspector.
  const frozen = (e: Entity) => offLayer(e) || (!!e.bond && e.type !== "tether") || going.has(e.id);
  // Locked by hand or by its Beat: every left-button gesture looks straight
  // through it, and only a right-click still lands on it.
  const locked = (e: Entity) => isLocked(plan, e);

  const committed = useMemo(() => entitiesForStep(plan, stepId, undefined, shown), [plan, stepId, shown]);
  const selectedIds = useMemo(
    () =>
      new Set(
        selected.flatMap((id) =>
          symmetryCount > 1
            ? symmetryMemberIds(plan, id, symmetryKind, symmetryCount as 2 | 4, committed)
            : [id]
        )
      ),
    [plan, selected, symmetryCount, symmetryKind, committed]
  );
  const settled = useMemo(() => {
    const sorted = sortForDrawing(dragging ? entitiesForStep(plan, stepId, dragging, shown) : committed);
    // On the waymark layer the marks come to the top: they normally lie on the
    // floor under the party, which is right for reading a plan and useless for
    // dropping an A on the exact tile you mean.
    return layer === "markers"
      ? [...sorted].sort((a, b) => Number(a.type === "marker") - Number(b.type === "marker"))
      : sorted;
  }, [plan, stepId, shown, committed, dragging, layer, symmetryCount, symmetryKind]);
  // What is actually on the floor this frame: the step's shapes, or them on
  // their way there. Everything below reads this, so a walk moves the lot.
  const { entities, going, blast, walking } = useGlide(settled, glide, onward);
  // What actually moves the floor: a walk between steps, or something in the
  // hand. A marquee is not motion — and sweeping the margin over a run of chips
  // is how a pile on one tile gets selected, so they have to be there for it.
  const chipsMoving = walking || !!dragging;
  const chipsFade = useChipsFade(chipsMoving);
  /**
   * The chips as they last stood on a still floor. Laying them out again while
   * something is moving would be work spent on a readout nobody can read —
   * plates reflowing down the margin under the hand — so the element from the
   * last still frame is what stays on screen and fades. Held through a ref and
   * handed back unchanged, which is React's cue to leave the whole subtree
   * alone: no layout, no text measuring, no touching a single node. It stays
   * held while they are away, too: a run of step presses would otherwise relay
   * the whole margin, once per press, into a canvas nobody can see.
   */
  const chipsHeld = useRef<ReactNode>(null);
  if (!chipsMoving && chipsFade.shown) {
    chipsHeld.current = (
      <Chips
        entities={entities.filter(
          (e) =>
            (selectedIds.has(e.id) ||
              ((e.type === "player" ? chips.party : chips.others) && !frozen(e))) &&
            e.type !== "tether" &&
            // The copies of a counted bait share the bait's chip.
            !isFanCopy(e.id) &&
            !going.has(e.id)
        )}
        selectedIds={selectedIds}
        locked={locked}
        pixelsPerUnit={scale}
        viewHalf={size / 2 / scale}
        floorHalf={arena.width / 2}
        dress={dress}
        leaders={chipsFade.leaders}
      />
    );
  }
  const byId = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  /**
   * A counted bait is one selectable thing drawn several times, so every copy
   * answers for the entity it came from: clicking one selects the bait, and all
   * of them wear the selection outline.
   */
  const lit = (e: Entity) => selectedIds.has(fanOwnerId(e.id));

  const footprints = useMemo(
    () => new Map(entities.map((e) => [e.id, hitArea(e, byId)])),
    [entities, byId]
  );

  /**
   * Where each bait would sit with no nudge of its own — the point a drag is
   * measured against. A bait keeps following its target; dragging it says "and
   * a bit that way", which is the only reading that survives the target moving.
   */
  const anchorBase = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    const step = stepId ? plan.steps.find((candidate) => candidate.id === stepId) : undefined;
    const mechanic = step?.mechanic
      ? plan.mechanics.find((candidate) => candidate.id === step.mechanic)
      : undefined;
    const requested = mechanic ? shown?.[mechanic.id] : undefined;
    const variant = mechanic?.variants.length
      ? (mechanic.variants.find((candidate) => candidate.id === requested) ?? mechanic.variants[0]).id
      : undefined;
    const authoredScene =
      plan.variantModel === "step"
        ? composeStepVariantEntities(plan, stepId, shown).entities
        : authoredEntitiesForStep(plan, stepId, variant);
    for (const e of committed) {
      if (!e.anchor) continue;
      const authored = authoredScene.find((b) => b.id === e.id);
      if (!authored) continue;
      m.set(e.id, { x: e.x - authored.x, y: e.y - authored.y });
    }
    return m;
  }, [committed, plan, shown, stepId]);

  /** A node's live position as the entity would store it: an offset, if anchored. */
  const poseOf = (id: string, node: { x(): number; y(): number }) => {
    const base = anchorBase.get(id);
    return { x: node.x() - (base?.x ?? 0), y: node.y() - (base?.y ?? 0) };
  };

  // Every authored symmetry transform is centred on the arena. Keeping the
  // pivot fixed makes a selection's rotation predictable before, during, and
  // after entities cross one another.
  const selectionPivot = { x: 0, y: 0 };

  /**
   * What a group drag can carry. A tether is two endpoints with nothing in
   * between to move, and a bait is owned by whoever it is aimed at rather than
   * by a coordinate, so it already travels on its own. Selecting either is
   * still how their shared style becomes editable — the selection just leaves
   * them where they are.
   */
  const carriable = (e: Entity) => !frozen(e) && !locked(e) && e.type !== "tether" && !e.anchor;

  function beginGroupDrag(id: string, picked: Set<string> = selectedIds) {
    const source = committed.find((e) => e.id === id);
    if (!source) return;
    const members = new Map<string, { x: number; y: number; shownX: number; shownY: number }>();
    for (const e of committed) {
      // The bait you actually grabbed is the exception: dragging it by hand is
      // how its nudge off the target is authored. Swept up in a selection it
      // would instead take that nudge on top of the movement it inherits, so a
      // marquee over a party would leave every spread doubly displaced.
      const grabbedBait = e.id === id && !!e.anchor && !frozen(e) && !locked(e);
      if (!picked.has(e.id) || !(carriable(e) || grabbedBait)) continue;
      const base = anchorBase.get(e.id);
      members.set(e.id, {
        x: e.x - (base?.x ?? 0),
        y: e.y - (base?.y ?? 0),
        shownX: e.x,
        shownY: e.y,
      });
    }
    const sourceBase = members.get(id);
    if (!sourceBase) return;
    dragStart.current = {
      source: id,
      sourceAt: { x: sourceBase.x, y: sourceBase.y },
      pivot: selectionPivot,
      snapSymmetry: symmetryCount > 1 && (selected.length === 1 || !selectedIds.has(id)),
      moved: false,
      members,
    };
  }

  /**
   * An anchored offset dropped within a hand's breadth of zero means "just
   * follow the target again": snap it home so the plan does not accumulate
   * meaningless two-unit nudges.
   */
  function settleAnchorSnap(live: Map<string, { x: number; y: number }>) {
    if (!snapping) return live;
    for (const [id, p] of live) {
      if (anchorBase.has(id) && Math.hypot(p.x, p.y) < 12 / scale) live.set(id, { x: 0, y: 0 });
    }
    return live;
  }

  /**
   * FFXIV positioning is radial: intercardinal spokes, shared rings, waymark
   * tiles. A lone unanchored drag snaps to those — angle to 45° spokes, radius
   * to other tokens' rings, position to a waymark — unless Alt says free-hand.
   * Returns the settled point and remembers which guides earned drawing.
   */
  function radialSnap(id: string, p: { x: number; y: number }) {
    const grip = 8 / scale;
    for (const o of committed) {
      if (o.type !== "marker" || o.id === id) continue;
      if (Math.hypot(o.x - p.x, o.y - p.y) < 12 / scale) {
        setGuides({ point: { x: o.x, y: o.y } });
        return { x: o.x, y: o.y };
      }
    }
    const r = Math.hypot(p.x, p.y);
    if (r < 1) {
      setGuides(null);
      return p;
    }
    let ang = Math.atan2(p.y, p.x);
    const spoke = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
    const onSpoke = Math.abs(ang - spoke) * r < grip;
    if (onSpoke) ang = spoke;
    let ringAt: number | undefined;
    for (const o of committed) {
      if ((o.type !== "player" && o.type !== "enemy") || o.id === id) continue;
      const or = Math.hypot(o.x, o.y);
      if (Math.abs(or - r) < grip && (ringAt === undefined || Math.abs(or - r) < Math.abs(ringAt - r)))
        ringAt = or;
    }
    if (!onSpoke && ringAt === undefined) {
      setGuides(null);
      return p;
    }
    setGuides({ spoke: onSpoke ? spoke : undefined, radius: ringAt });
    const useR = ringAt ?? r;
    return { x: useR * Math.cos(ang), y: useR * Math.sin(ang) };
  }

  function moveGroup(id: string, at: { x: number; y: number }, alt = false) {
    const start = dragStart.current;
    if (!start || start.source !== id) return null;
    const dx = at.x - start.sourceAt.x;
    const dy = at.y - start.sourceAt.y;
    // Four screen pixels of intent before anything counts as a move: a click
    // that wobbles in the hand must select, not nudge.
    if (Math.hypot(dx, dy) > 4 / scale) start.moved = true;
    if (start.members.size > 1 && symmetryKind === "rotate") {
      const source = start.members.get(id)!;
      const sourceBase = { x: source.shownX - source.x, y: source.shownY - source.y };
      const targetShown = { x: at.x + sourceBase.x, y: at.y + sourceBase.y };
      const fromAngle = Math.atan2(source.shownY - start.pivot.y, source.shownX - start.pivot.x);
      const toAngle = Math.atan2(targetShown.y - start.pivot.y, targetShown.x - start.pivot.x);
      const angle = toAngle - fromAngle;
      const fromRadius = Math.hypot(source.shownX - start.pivot.x, source.shownY - start.pivot.y);
      const toRadius = Math.hypot(targetShown.x - start.pivot.x, targetShown.y - start.pivot.y);
      const radialScale = fromRadius > 0.001 ? toRadius / fromRadius : 1;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const live = new Map<string, { x: number; y: number }>();
      for (const [memberId, member] of start.members) {
        const relX = member.shownX - start.pivot.x;
        const relY = member.shownY - start.pivot.y;
        const shownX = start.pivot.x + (relX * cos - relY * sin) * radialScale;
        const shownY = start.pivot.y + (relX * sin + relY * cos) * radialScale;
        // Anchored entities store an offset rather than their resolved position.
        live.set(memberId, {
          x: member.x + shownX - member.shownX,
          y: member.y + shownY - member.shownY,
        });
      }
      setDragging(settleAnchorSnap(live));
      return live;
    }
    if (start.snapSymmetry) {
      const updates = symmetricUpdates(
        plan,
        { op: "update_entity", id, patch: { x: at.x, y: at.y } },
        symmetryKind,
        symmetryCount as 2 | 4,
        committed
      );
      const live = new Map(
        updates.map((update) => [
          update.id,
          { x: Number(update.patch.x), y: Number(update.patch.y) },
        ])
      );
      setDragging(live);
      return live;
    }
    const source = start.members.get(id)!;
    const live = new Map<string, { x: number; y: number }>();
    for (const [memberId, member] of start.members) {
      let mx = dx;
      let my = dy;
      if (symmetryCount > 1 && symmetryKind === "mirror") {
        const sx = source.shownX < start.pivot.x ? -1 : 1;
        const sy = source.shownY < start.pivot.y ? -1 : 1;
        const tx = member.shownX < start.pivot.x ? -1 : 1;
        const ty = member.shownY < start.pivot.y ? -1 : 1;
        mx *= sx * tx;
        if (symmetryCount === 4) my *= sy * ty;
      }
      live.set(memberId, { x: member.x + mx, y: member.y + my });
    }
    // A lone unanchored token gets the arena's radial snap; anything grouped,
    // mirrored, or anchored keeps its own settling rules.
    if (live.size === 1 && symmetryCount === 1 && !anchorBase.has(id) && start.moved && !alt && snapping) {
      live.set(id, radialSnap(id, live.get(id)!));
    } else {
      setGuides(null);
    }
    setDragging(settleAnchorSnap(live));
    return live;
  }

  /**
   * Konva would hand us the topmost shape, which means a big AoE drawn over the
   * party makes the party unclickable. Pick whichever candidate under the pointer
   * covers the least ground instead — the one you had to aim at is the one you
   * meant — and start its drag by hand, so draw order stays purely visual.
   * A player beats everything else, whatever its size: the party is what gets
   * moved most, and a marker or icon parked on someone must not hide them.
   */
  function under(
    evt: Konva.KonvaEventObject<MouseEvent | TouchEvent | WheelEvent>,
    /** The wheel resizes a bonded set through any of its faces; a click cannot. */
    include: (e: Entity) => boolean = (e) => !frozen(e) && !locked(e)
  ) {
    const stage = evt.target.getStage();
    const point = stage?.getPointerPosition();
    if (!stage || !point) return undefined;

    const hits = stage.getAllIntersections(point);
    const arenaAt = { x: (point.x - size / 2) / scale, y: (point.y - size / 2) / scale };
    let best: { node: Konva.Group; id: string } | undefined;
    let bestSize = Infinity;
    let bestRank = Infinity;
    for (const shape of hits) {
      const hitGroup = shape.findAncestor(".entity", true) as Konva.Group | undefined;
      const hitId = hitGroup?.id();
      if (!hitGroup || !hitId) continue;
      // Grabbing copy three of a counted bait grabs the bait: the drag becomes
      // the one nudge every copy shares, so it is the owner's node that moves.
      const id = fanOwnerId(hitId);
      const group = (id === hitId ? hitGroup : (stage.findOne(`#${id}`) as Konva.Group | undefined)) ?? hitGroup;
      // A short tether covers less ground than the tokens it joins, which made
      // the token at either end unclickable — you would grab the tether instead,
      // and tethers do not drag, so the token simply stopped responding. A
      // tether is grabbed along its length, not on the people it connects.
      const entity = byId.get(id);
      if (entity && !include(entity)) continue;
      if (entity?.type === "tether" && onTetherEnd(entity, arenaAt, byId)) continue;
      const footprint = footprints.get(id) ?? Infinity;
      const rank = entity?.type === "player" ? 0 : 1;
      if (rank < bestRank || (rank === bestRank && footprint < bestSize)) {
        best = { node: group, id };
        bestSize = footprint;
        bestRank = rank;
      }
    }
    return best;
  }

  /** Hand the press to the nearest selection grip within reach, if there is one. */
  function gripWithinReach(evt: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    const stage = evt.target.getStage();
    const point = stage?.getPointerPosition();
    if (!stage || !point) return false;
    let nearest: Konva.Node | undefined;
    let distance = GRIP_REACH;
    for (const grip of stage.find(".pin-grab")) {
      const at = grip.getAbsolutePosition();
      const d = Math.hypot(at.x - point.x, at.y - point.y);
      if (d < distance) {
        nearest = grip;
        distance = d;
      }
    }
    if (!nearest) return false;
    nearest.fire(evt.evt instanceof MouseEvent ? "mousedown" : "touchstart", { evt: evt.evt });
    return true;
  }

  function pickAt(evt: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    // Only the left button picks. A right-press must leave the selection, the
    // pick, the group drag and the marquee exactly as they were: the menu it
    // opens describes what is already in hand.
    if (evt.evt instanceof MouseEvent && evt.evt.button !== 0) return;
    const stagePoint = evt.target.getStage()?.getPointerPosition();
    const onFrozenMarker =
      layer !== "markers" &&
      !!stagePoint &&
      entities.some(
        (entity) =>
          entity.type === "marker" &&
          Math.hypot(
            (stagePoint.x - size / 2) / scale - entity.x,
            (stagePoint.y - size / 2) / scale - entity.y,
          ) <= entity.size * entity.scale * 0.55
      );
    const additive = "shiftKey" in evt.evt && evt.evt.shiftKey;
    // A chip stands in for the thing it names: clicking it selects
    // that thing, and with shift held adds it to (or drops it from) the set.
    // That is what makes a stack of things on one tile pickable one by one.
    const chip = evt.target.findAncestor(".chip", true) as Konva.Group | undefined;
    const chipFor = chip?.getAttr("entityId") as string | undefined;
    if (chipFor) {
      const named = byId.get(chipFor);
      if (named && locked(named)) return;
      if (additive) {
        onSelect(selected.includes(chipFor) ? selected.filter((id) => id !== chipFor) : [...selected, chipFor]);
      } else {
        onSelect([chipFor]);
      }
      return;
    }
    const best = under(evt, picking ? (e) => !frozen(e) : undefined);
    // A grip the press only just missed still takes it over whatever else is
    // there: sizing what is already selected beats selecting something new.
    // The selected thing's own body still moves it, and shift still selects.
    if (editable && !picking && !additive && best?.id !== pinnedId && gripWithinReach(evt)) return;
    // A bare waymark is frozen scenery on the Step layer. An editable shape
    // visibly on top of it still wins, though: otherwise a player parked on a
    // waymark (R1 on D in the final P11S slide) cannot be grabbed at all.
    if (onFrozenMarker && !best) {
      onSelect([]);
      return;
    }
    if (!best) {
      const stage = evt.target.getStage();
      const point = stage?.getPointerPosition();
      if (editable && stage && point && evt.evt instanceof MouseEvent && evt.evt.button === 0) {
        startMarquee(stage, point, additive);
      } else if (!additive) {
        onSelect([]);
      }
      return;
    }
    if (onPick?.(best.id)) return;
    if (additive) {
      onSelect(selected.includes(best.id) ? selected.filter((id) => id !== best.id) : [...selected, best.id]);
      return;
    }
    if (!selectedIds.has(best.id)) onSelect([best.id]);
    const entity = entities.find((e) => e.id === best!.id);
    // A tether is two endpoints and nothing else, so there is nothing to drag.
    // A bait can be dragged: the drop lands as an offset from its anchor.
    if (editable && entity && !locked(entity) && entity.type !== "tether") {
      const node = best.node;
      // React has not rendered a newly clicked selection yet, so resolve its
      // symmetry partners now instead of waiting for a second gesture.
      const picked = selectedIds.has(best.id)
        ? selectedIds
        : new Set(
            symmetryCount > 1
              ? symmetryMemberIds(plan, best.id, symmetryKind, symmetryCount as 2 | 4, committed)
              : [best.id]
          );
      beginGroupDrag(best.id, picked);
      node.startDrag(evt.evt as never);
      // A drag we started by hand is not always ended by Konva: a click with no
      // movement can leave the node latched to the pointer, so it then follows
      // the mouse across the whole page — over the sidebar, out of the arena —
      // until something else happens to end it. The button being up means
      // nothing is being dragged, full stop.
      const release = () => {
        if (node.isDragging()) node.stopDrag();
      };
      window.addEventListener("mouseup", release, { once: true });
      window.addEventListener("touchend", release, { once: true });
    }
  }

  /**
   * The marquee follows the pointer off the canvas too. A sweep down the
   * margin's chips runs right along the stage edge, and the stage stops
   * hearing the mouse the moment it crosses that edge: the box would freeze
   * there and a release outside would never finish it.
   */
  function startMarquee(stage: Konva.Stage, from: { x: number; y: number }, additive: boolean) {
    let to = from;
    setMarquee({ from, to, additive });
    const track = (move: MouseEvent) => {
      stage.setPointersPositions(move);
      const point = stage.getPointerPosition();
      if (!point) return;
      to = point;
      setMarquee({ from, to, additive });
    };
    const release = () => {
      window.removeEventListener("mousemove", track);
      window.removeEventListener("mouseup", release);
      finishSelection.current(stage, from, to, additive);
    };
    window.addEventListener("mousemove", track);
    window.addEventListener("mouseup", release);
  }

  // Read through a ref at release time, so the sweep settles against the
  // floor as it is then, not as it was when the button went down.
  const finishSelection = useRef(finishMarquee);
  finishSelection.current = finishMarquee;

  const stageRef = useRef<Konva.Stage>(null);
  useEffect(() => {
    if (!sweep) return;
    sweep.current = (ev: MouseEvent) => {
      const stage = stageRef.current;
      if (!stage || !editable || ev.button !== 0) return;
      stage.setPointersPositions(ev);
      const point = stage.getPointerPosition();
      if (point) startMarquee(stage, point, ev.shiftKey);
    };
    return () => {
      sweep.current = null;
    };
  });
  function finishMarquee(
    stage: Konva.Stage,
    from: { x: number; y: number },
    point: { x: number; y: number },
    additive: boolean
  ) {
    const left = Math.min(from.x, point.x);
    const top = Math.min(from.y, point.y);
    const box = { x: left, y: top, width: Math.abs(point.x - from.x), height: Math.abs(point.y - from.y) };
    const inBox = (node: Konva.Node | undefined) => {
      if (!node) return false;
      const r = node.getClientRect();
      return r.x <= box.x + box.width && r.x + r.width >= box.x && r.y <= box.y + box.height && r.y + r.height >= box.y;
    };
    // A chip stands in for its thing here too: sweeping a box down the margin
    // over a run of chips is how a pile of things on one tile gets selected.
    const swept = new Set(
      stage.find(".chip").filter(inBox).map((chip) => chip.getAttr("entityId") as string)
    );
    const hits = [
      ...new Set(
        entities
          .filter((e) => !frozen(e) && !locked(e))
          .filter((e) => swept.has(e.id) || inBox(stage.findOne(`#${e.id}`)))
          .map((e) => fanOwnerId(e.id))
      ),
    ];
    onSelect(additive ? [...new Set([...selected, ...hits])] : hits);
    setMarquee(null);
  }

  /**
   * A right-click resolves its target the way a pick does, and reports it. The
   * one difference is what it does to the selection: something already in a
   * multi-selection keeps the whole set — the menu is about all of them —
   * while anything else becomes the selection first, so the menu and the
   * inspector are talking about the same thing.
   */
  function contextAt(evt: Konva.KonvaEventObject<PointerEvent>) {
    if (!onContextMenu) return;
    evt.evt.preventDefault();
    const stage = evt.target.getStage();
    if (!stage) return;
    stage.setPointersPositions(evt.evt);
    const point = { x: evt.evt.clientX, y: evt.evt.clientY };
    const chip = evt.target.findAncestor(".chip", true) as Konva.Group | undefined;
    const chipFor = chip?.getAttr("entityId") as string | undefined;
    const hit = chipFor ?? under(evt as never, (e) => !frozen(e))?.id;
    if (hit) {
      if (!selectedIds.has(hit)) onSelect([hit]);
      onContextMenu({ kind: "entity", id: hit, point });
      return;
    }
    const at = stage.getPointerPosition();
    if (!at) return;
    onContextMenu({
      kind: "floor",
      arenaPoint: {
        x: Math.round((at.x - size / 2) / scale),
        y: Math.round((at.y - size / 2) / scale),
      },
      point,
    });
  }

  /**
   * The wheel sizes whatever is under the pointer, without selecting it first —
   * one gesture, no mode. For a tether that means its required range, not its
   * visual stroke. A bonded shape updates its whole set, because the set is the
   * thing you are pointing at.
   */
  function wheelAt(evt: Konva.KonvaEventObject<WheelEvent>) {
    if (!editable || !onResize) return;
    const hit = under(evt, (e) => (!frozen(e) || !!e.bond) && !locked(e));
    if (!hit) return;
    evt.evt.preventDefault();
    const step = evt.evt.shiftKey ? 1.02 : 1.08;
    // Plain wheel is size; with ctrl held it is how solid the thing is drawn.
    // Shift, marquee, and symmetry selection all resolve into `selectedIds`.
    // Pointing at one member makes that whole selection the wheel target;
    // pointing elsewhere keeps the no-selection-required wheel behavior.
    const ids = selectedIds.size > 1 && selectedIds.has(hit.id) ? [...selectedIds] : [hit.id];
    onResize(ids, evt.evt.deltaY < 0 ? step : 1 / step, evt.evt.ctrlKey ? "opacity" : "size");
  }

  // The one thing the pins are on, if any: its hairline is theirs to draw, so
  // it can follow a resize or a turn mid-gesture.
  const pinnedId = (() => {
    if (!editable || selectedIds.size !== 1) return null;
    const entity = entities.find((candidate) => selectedIds.has(candidate.id));
    return entity && !frozen(entity) && !locked(entity) && entity.type !== "tether" ? entity.id : null;
  })();

  return (
    <Stage
      ref={stageRef}
      width={size}
      height={size}
      onMouseDown={pickAt}
      onTouchStart={pickAt}
      onContextMenu={contextAt}
      onWheel={wheelAt}
    >
      <Layer>
        <Group x={size / 2} y={size / 2} scaleX={scale} scaleY={scale}>
          <ArenaFloor plan={plan} />
          {entities.map((e) =>
            e.type === "tether" ? (
              <Tether key={e.id} entity={e} byId={byId} selected={selectedIds.has(e.id)} dim={offLayer(e)} />
            ) : (
              <Group
                key={e.id}
                id={e.id}
                name="entity"
                x={e.x}
                y={e.y}
                rotation={e.rotation}
                scaleX={e.scale}
                scaleY={e.scale}
                opacity={e.opacity * (offLayer(e) ? 0.4 : 1)}
                onDragMove={(ev) =>
                  moveGroup(e.id, poseOf(e.id, ev.target), "altKey" in ev.evt && ev.evt.altKey)
                }
                onDragEnd={(ev) => {
                  const pose = poseOf(e.id, ev.target);
                  if (!dragStart.current?.moved) {
                    setGuides(null);
                    dragStart.current = null;
                    setDragging(null);
                    return;
                  }
                  // Held until the new revision arrives, so the shape does not
                  // snap back to its old pose for the length of a round trip.
                  const final =
                    moveGroup(e.id, pose, "altKey" in ev.evt && ev.evt.altKey) ??
                    new Map([[e.id, pose]]);
                  setGuides(null);
                  const moves = [...final].map(([id, p]) => ({
                    id,
                    x: Math.round(p.x),
                    y: Math.round(p.y),
                  }));
                  onMove(moves);
                  dragStart.current = null;
                }}
              >
                <GrabTarget entity={e} />
                <EntityShape entity={e} blast={blast.get(e.id) ?? 0} dress={dress?.get(e.id)} />
                {/* A selected thing wears a hairline in its own colour, hugging
                    its silhouette; the one under the pins draws it there
                    instead. A highlighted row's shapes light up in the accent. */}
                {lit(e) && e.id !== pinnedId ? (
                  <SilhouetteEdge
                    name="selection"
                    silhouette={silhouetteOf(e)}
                    unit={1 / scale / e.scale}
                    color={chipColor(e)}
                  />
                ) : (
                  !!highlight &&
                  (e.bond?.id === highlight || e.mech === highlight) && (
                    <SilhouetteEdge
                      silhouette={silhouetteOf(e)}
                      unit={1 / scale / e.scale}
                      color={ACCENT}
                      width={2}
                    />
                  )
                )}
              </Group>
            )
          )}
          {preview.map((e) => (
            <Group
              key={e.id}
              id={e.id}
              name="drop-preview"
              x={e.x}
              y={e.y}
              rotation={e.rotation}
              scaleX={e.scale}
              scaleY={e.scale}
              opacity={e.opacity * 0.62}
              listening={false}
            >
              <EntityShape entity={e} />
              <SilhouetteEdge silhouette={silhouetteOf(e)} unit={1 / scale / e.scale} color={ACCENT} width={2} />
            </Group>
          ))}
          {/*
            The waymarks again, faint, over everything: a telegraph covering an
            A should not make the A disappear, since "A" is how the plan is
            going to be called out. On the waymark layer they are already on
            top and the ghost would only double them.
          */}
          {layer !== "markers" &&
            entities
              .filter((e) => e.type === "marker")
              .map((e) => (
                <Group
                  key={"ghost-" + e.id}
                  x={e.x}
                  y={e.y}
                  rotation={e.rotation}
                  scaleX={e.scale}
                  scaleY={e.scale}
                  opacity={e.opacity * 0.25}
                  listening={false}
                >
                  <EntityShape entity={e} />
                </Group>
              ))}
          {/* Transform geometry is guidance, so it stays legible over tokens,
              telegraphs, labels, and the waymark ghost pass. */}
          {guides && (
            <Group listening={false}>
              {guides.spoke !== undefined && (
                <Line
                  points={[
                    0,
                    0,
                    Math.cos(guides.spoke) * Math.max(arena.width, arena.height) * 0.7,
                    Math.sin(guides.spoke) * Math.max(arena.width, arena.height) * 0.7,
                  ]}
                  stroke="rgba(125, 211, 252, 0.75)"
                  strokeWidth={1.5 / scale}
                  dash={[5 / scale, 4 / scale]}
                />
              )}
              {guides.radius !== undefined && (
                <Circle
                  radius={guides.radius}
                  stroke="rgba(125, 211, 252, 0.6)"
                  strokeWidth={1.5 / scale}
                  dash={[2 / scale, 5 / scale]}
                />
              )}
              {guides.point && (
                <Circle
                  x={guides.point.x}
                  y={guides.point.y}
                  radius={14 / scale}
                  stroke="rgba(125, 211, 252, 0.85)"
                  strokeWidth={2 / scale}
                />
              )}
            </Group>
          )}
          {/* Dragging an anchored bait edits "and a bit that way", not a place:
              the leash makes that reading visible, and the small ring is the
              drop zone that puts the offset back to zero. */}
          {dragging &&
            [...dragging].map(([id, off]) => {
              const base = anchorBase.get(id);
              if (!base) return null;
              const u = 1 / scale;
              const home = Math.hypot(off.x, off.y) < 0.5;
              return (
                <Group key={"leash-" + id} listening={false}>
                  <Circle
                    x={base.x}
                    y={base.y}
                    radius={12 * u}
                    stroke="#fcd34d"
                    strokeWidth={1.5 * u}
                    dash={[2 * u, 4 * u]}
                    opacity={home ? 1 : 0.6}
                  />
                  {!home && (
                    <>
                      <Line
                        points={[base.x, base.y, base.x + off.x, base.y + off.y]}
                        stroke="#fcd34d"
                        strokeWidth={2 * u}
                        dash={[5 * u, 5 * u]}
                      />
                      <Group x={base.x + off.x / 2 + 10 * u} y={base.y + off.y / 2 + 10 * u}>
                        <Rect
                          width={84 * u}
                          height={20 * u}
                          cornerRadius={5 * u}
                          fill="#232833"
                          stroke="#2e3543"
                          strokeWidth={1 * u}
                        />
                        <Text
                          width={84 * u}
                          height={20 * u}
                          align="center"
                          verticalAlign="middle"
                          fontSize={12 * u}
                          fill="#e6ebf2"
                          text={`${off.x >= 0 ? "+" : ""}${Math.round(off.x)}, ${off.y >= 0 ? "+" : ""}${Math.round(off.y)}`}
                        />
                      </Group>
                    </>
                  )}
                </Group>
              );
            })}
          {selectedIds.size > 1 && (
            <TransformAxis
              kind={symmetryKind}
              count={symmetryCount}
              pivot={selectionPivot}
              entities={entities.filter((e) => selectedIds.has(e.id) && carriable(e))}
            />
          )}
          {pinnedId && (() => {
            const entity = byId.get(pinnedId);
            return entity && entity.type !== "tether" ? (
              <SelectionPins
                entity={entity}
                pixelsPerUnit={scale}
                viewHalf={size / 2 / scale}
                snapping={snapping}
                onTransform={(patch) => onTransform?.(entity.id, patch)}
              />
            ) : null;
          })()}
        </Group>
      </Layer>
      {/* Every selected thing gets a leader out to a chip in the margin: the
          readout that says what is selected, and stays clickable when the
          things themselves are piled on one tile.

          It gets a canvas of its own. A Konva layer is only redrawn when
          something in it changes, so while the floor is moving — and it is the
          floor that is moving, not the margin — this one is simply left alone,
          holding the picture it already had. Nothing about a walk or a drag
          costs it a single pixel, and the fade is done on the canvas element
          rather than by drawing, so it costs nothing either. */}
      <Layer ref={chipsFade.layer} listening={chipsFade.shown && !chipsMoving}>
        <Group x={size / 2} y={size / 2} scaleX={scale} scaleY={scale}>
          <Group ref={chipsFade.group}>{chipsHeld.current}</Group>
        </Group>
      </Layer>
      {marquee && (
        <Layer listening={false}>
          <Rect
            x={Math.min(marquee.from.x, marquee.to.x)}
            y={Math.min(marquee.from.y, marquee.to.y)}
            width={Math.abs(marquee.to.x - marquee.from.x)}
            height={Math.abs(marquee.to.y - marquee.from.y)}
            fill="rgba(122, 162, 247, 0.14)"
            stroke="#7aa2f7"
            strokeWidth={1.5}
            dash={[6, 4]}
          />
        </Layer>
      )}
    </Stage>
  );
}

/**
 * Contextual direct-manipulation handles for one selected floor object.
 *
 * The handles are ticks on a hairline selection ring: a radial tick pushes and
 * pulls the object's size, an amber arc tick along the ring turns it. Each mark
 * crosses the edge it edits, so its shape says what dragging it does. Visuals
 * stay 6–8px quiet and bloom under the cursor; the grabbable area is a larger
 * invisible disc, so small never means fiddly. The rotate tick only appears
 * where turning the object communicates something: facing actors, waymarks,
 * art, paths, and directional telegraphs. Round, position-only objects do not
 * grow a decorative control that cannot change their meaning.
 */
type PinKind = "resize" | "rotate" | "inner" | "angle" | "width" | "length" | "corner";

/** Screen pixels from a grip's centre within which a press on anything else still takes the grip. */
const GRIP_REACH = 26;

/**
 * Which of a box's edges a grip holds, in the shape's own axes: `w` the pair
 * across its width, `l` the pair along its length, `0` neither. An edge pill
 * holds one, a corner bracket holds one of each, and whatever a grip does not
 * hold stands still while it is dragged.
 */
type Grip = { w: -1 | 0 | 1; l: -1 | 0 | 1 };

/** A grip's identity: the same string on the tick that draws it and the gesture it starts. */
const gripId = (kind: PinKind, grip: Grip) =>
  grip.w || grip.l ? `${kind}:${grip.w}:${grip.l}` : kind;

function SelectionPins({
  entity,
  pixelsPerUnit,
  viewHalf,
  snapping,
  onTransform,
}: {
  entity: Exclude<Entity, { type: "tether" }>;
  pixelsPerUnit: number;
  /** Half-extent (arena units) of the visible canvas around the arena centre. */
  viewHalf: number;
  /** Turns settle onto 45° and cone spreads onto 15° while this is on. */
  snapping: boolean;
  onTransform(patch: {
    factor: number;
    rotation?: number;
    innerRadius?: number;
    angle?: number;
    width?: number;
    length?: number;
    x?: number;
    y?: number;
  }): Promise<unknown> | void;
}) {
  const group = useRef<Konva.Group>(null);
  const gesture = useRef(0);
  const [hover, setHover] = useState<string | null>(null);
  const [live, setLive] = useState<{
    id: string;
    kind: PinKind;
    grip: Grip;
    factor: number;
    rotation: number;
    inner: number;
    angle: number;
    width: number;
    length: number;
    /** How far the centre has walked, since holding one edge still moves it. */
    dx: number;
    dy: number;
  } | null>(null);
  const directional =
    entity.type === "marker" ||
    entity.type === "icon" ||
    entity.type === "path" ||
    (entity.type === "player" && entity.showFacing) ||
    (entity.type === "enemy" && entity.showFacing) ||
    (entity.type === "zone" &&
      ["cone", "rect", "line", "knockback", "arrow", "exaflare", "linestack", "cross"].includes(entity.shape));

  // Handle dimensions are expressed in arena units because this group sits
  // inside the scaled floor group. Divide by the canvas scale to keep the
  // ticks finger-sized and the strokes crisp on every arena/viewport size.
  const unit = 1 / Math.max(0.001, pixelsPerUnit);
  const factor = live?.factor ?? 1;
  const rotation = live?.rotation ?? entity.rotation;
  // Rectangular shapes have two independent dimensions the corner tick cannot
  // separate: width gets grips on the side edges, length on the ends.
  const boxy =
    entity.type === "zone" &&
    ["rect", "line", "knockback", "arrow", "linestack"].includes(entity.shape)
      ? (entity as Extract<Entity, { type: "zone" }> & { width: number; length: number })
      : null;
  const liveW = boxy ? (live?.width ?? boxy.width) : 0;
  const liveL = boxy ? (live?.length ?? boxy.length) : 0;
  // The ticks ride the hairline that hugs the shape, so how far out one sits
  // depends on which way it faces: a token's corner is further out than its
  // side. Everything follows the dimensions being dragged, not the authored
  // ones, so the hairline keeps hugging the shape mid-gesture.
  const silhouette = silhouetteOf(entity, { width: liveW, length: liveL });
  const edgeScale = entity.scale * factor;
  const edgeAt = (dx: number, dy: number) => {
    const d = Math.max(rayOut(silhouette, edgeScale, rotation, dx, dy) + 2 * unit, 14 * unit);
    return { x: dx * d, y: dy * d };
  };
  // Stretching one edge leaves the opposite one standing, so the centre walks
  // half of what that edge gained. The pins ride the shape as dragged, which
  // means they ride that walked centre rather than the authored pose.
  const centre = { x: entity.x + (live?.dx ?? 0), y: entity.y + (live?.dy ?? 0) };
  // No grip may leave the visible floor, wherever its edge or ring point
  // lands: pull it straight back inside, keeping its grab disc whole.
  const clampView = (p: { x: number; y: number }) => ({
    x: Math.min(Math.max(p.x, -viewHalf - centre.x + 12 * unit), viewHalf - centre.x - 12 * unit),
    y: Math.min(Math.max(p.y, -viewHalf - centre.y + 12 * unit), viewHalf - centre.y - 12 * unit),
  });
  // The resize tick keeps the old corner convention (south-east); the rotate
  // tick rides the ring at the object's facing, so it follows a turn.
  const resizeAt = clampView(edgeAt(Math.SQRT1_2, Math.SQRT1_2));
  const rotateRad = ((rotation - 90) * Math.PI) / 180;
  const rotateAt = clampView(edgeAt(Math.cos(rotateRad), Math.sin(rotateRad)));
  // A donut's hole and a cone's spread are the values the wheel cannot reach:
  // each gets a tick directly on the edge it edits.
  const donut = entity.type === "zone" && entity.shape === "donut" ? entity : null;
  const cone = entity.type === "zone" && entity.shape === "cone" ? entity : null;
  const innerDist = donut
    ? Math.max((live?.inner ?? donut.innerRadius) * donut.scale, 18 * unit)
    : 0;
  const innerAt = clampView({ x: -innerDist * Math.SQRT1_2, y: -innerDist * Math.SQRT1_2 });
  const coneAngle = live?.angle ?? (cone ? cone.angle : 0);
  const coneEdgeRad = ((rotation + coneAngle / 2 - 90) * Math.PI) / 180;
  const coneAt = cone
    ? clampView({
        x: cone.radius * cone.scale * factor * Math.cos(coneEdgeRad),
        y: cone.radius * cone.scale * factor * Math.sin(coneEdgeRad),
      })
    : { x: 0, y: 0 };
  const boxRad = (rotation * Math.PI) / 180;
  // Local +x (the width axis) and local -y (the facing / length axis) in
  // arena space, given the node's clockwise rotation.
  const xAxis = { x: Math.cos(boxRad), y: Math.sin(boxRad) };
  const frontAxis = { x: Math.sin(boxRad), y: -Math.cos(boxRad) };
  const halfW = boxy ? Math.max((liveW / 2) * boxy.scale * factor, 14 * unit) : 0;
  const halfL = boxy ? Math.max((liveL / 2) * boxy.scale * factor, 14 * unit) : 0;
  const widthAt = { x: xAxis.x * halfW, y: xAxis.y * halfW };
  const lengthAt = { x: frontAxis.x * halfL, y: frontAxis.y * halfL };
  const cornerAt = (sw: 1 | -1, sl: 1 | -1) => ({
    x: xAxis.x * halfW * sw + frontAxis.x * halfL * sl,
    y: xAxis.y * halfW * sw + frontAxis.y * halfL * sl,
  });
  // The resize arrows must point along the direction the grip actually drags
  // on screen, which turns with the shape.
  const axisCursor = (axis: { x: number; y: number }) => {
    const deg = ((Math.atan2(axis.y, axis.x) * 180) / Math.PI + 180) % 180;
    if (deg < 22.5 || deg >= 157.5) return "ew-resize";
    if (deg < 67.5) return "nwse-resize";
    if (deg < 112.5) return "ns-resize";
    return "nesw-resize";
  };

  const cursor = (style: string) => {
    const container = group.current?.getStage()?.container();
    if (container) container.style.cursor = style;
  };

  function begin(
    kind: PinKind,
    evt: Konva.KonvaEventObject<MouseEvent | TouchEvent>,
    grip: Grip = { w: 0, l: 0 }
  ) {
    const id = gripId(kind, grip);
    // A right-press on a pin opens the menu; it never starts a resize or a turn.
    if (evt.evt instanceof MouseEvent && evt.evt.button !== 0) return;
    evt.cancelBubble = true;
    const stage = group.current?.getStage();
    const node = stage?.findOne(`#${entity.id}`) as Konva.Group | undefined;
    if (!stage || !node) return;
    // A fresh direct manipulation replaces an older released gesture even
    // while that older request is settling.
    gesture.current += 1;
    const center = node.getAbsolutePosition();
    const point = stage.getPointerPosition();
    if (!point) return;
    const fromDist = Math.max(1, Math.hypot(point.x - center.x, point.y - center.y));
    const fromAngle = Math.atan2(point.y - center.y, point.x - center.x);
    const state = {
      factor: 1,
      rotation: entity.rotation,
      inner: donut ? donut.innerRadius : 0,
      angle: cone ? cone.angle : 0,
      width: boxy ? boxy.width : 0,
      length: boxy ? boxy.length : 0,
      dx: 0,
      dy: 0,
    };
    // A stretch is measured from the anchor — the edge the grip does not hold,
    // left exactly where the grab found it — so the shape grows out of the side
    // being pulled instead of out of both. The axes are the authored ones,
    // since no stretch turns the shape.
    const rad = (entity.rotation * Math.PI) / 180;
    const along = { x: Math.cos(rad), y: Math.sin(rad) };
    const front = { x: Math.sin(rad), y: -Math.cos(rad) };
    const halfW0 = boxy ? (boxy.width / 2) * entity.scale : 0;
    const halfL0 = boxy ? (boxy.length / 2) * entity.scale : 0;
    // Where in its grab disc the pointer took the edge: the edge follows the
    // pointer's travel from there, rather than jumping under it.
    const held = {
      x: (point.x - center.x) / pixelsPerUnit,
      y: (point.y - center.y) / pixelsPerUnit,
    };
    const slopW = grip.w ? held.x * along.x + held.y * along.y - grip.w * halfW0 : 0;
    const slopL = grip.l ? held.x * front.x + held.y * front.y - grip.l * halfL0 : 0;
    /** The extent from the anchor out to a held edge now under `at`, and the centre's walk. */
    const stretched = (
      side: -1 | 1,
      axis: { x: number; y: number },
      slop: number,
      half0: number,
      at: { x: number; y: number }
    ) => {
      const edge = at.x * axis.x + at.y * axis.y - slop;
      const span = Math.max(8 * entity.scale, side * edge + half0);
      return { span, walk: side * (span / 2 - half0) };
    };

    const track = (move: MouseEvent | TouchEvent) => {
      stage.setPointersPositions(move);
      const at = stage.getPointerPosition();
      if (!at) return;
      if (kind === "resize") {
        const raw = Math.hypot(at.x - center.x, at.y - center.y) / fromDist;
        // Never let the ring collapse under the pointer: the handle must stay
        // grabbable, whatever the entity's own minimum turns out to be.
        state.factor = Math.max(0.04, ((radiusHint(entity) + 14) * entity.scale * raw < 12 * unit)
          ? state.factor
          : raw);
        node.scaleX(entity.scale * state.factor);
        node.scaleY(entity.scale * state.factor);
      } else if (kind === "rotate") {
        const turned = ((Math.atan2(at.y - center.y, at.x - center.x) - fromAngle) * 180) / Math.PI;
        let deg = (((entity.rotation + turned) % 360) + 360) % 360;
        const snap = Math.round(deg / 45) * 45;
        if (snapping && Math.abs(deg - snap) <= 5) deg = snap % 360;
        state.rotation = deg;
        node.rotation(deg);
      } else if ((kind === "width" || kind === "length" || kind === "corner") && boxy) {
        const now = {
          x: (at.x - center.x) / pixelsPerUnit,
          y: (at.y - center.y) / pixelsPerUnit,
        };
        let walkW = 0;
        let walkL = 0;
        if (grip.w) {
          const w = stretched(grip.w, along, slopW, halfW0, now);
          state.width = w.span / entity.scale;
          walkW = w.walk;
        }
        if (grip.l) {
          const l = stretched(grip.l, front, slopL, halfL0, now);
          state.length = l.span / entity.scale;
          walkL = l.walk;
        }
        state.dx = along.x * walkW + front.x * walkL;
        state.dy = along.y * walkW + front.y * walkL;
        node.scaleX((entity.scale * state.width) / boxy.width);
        node.scaleY((entity.scale * state.length) / boxy.length);
        node.x(entity.x + state.dx);
        node.y(entity.y + state.dy);
      } else if (kind === "inner" && donut) {
        const raw = Math.hypot(at.x - center.x, at.y - center.y) / fromDist;
        state.inner = Math.max(0, Math.min(donut.radius - 2, donut.innerRadius * raw));
      } else if (kind === "angle" && cone) {
        // The grip lives on the cone's clockwise edge; the pointer's bearing
        // from the facing line reads directly as half the spread.
        const bearing = (Math.atan2(at.y - center.y, at.x - center.x) * 180) / Math.PI + 90;
        let off = ((bearing - entity.rotation) % 360 + 360) % 360;
        if (off > 180) off = 360 - off;
        let deg = Math.max(5, Math.min(360, off * 2));
        const snap = Math.round(deg / 15) * 15;
        if (snapping && Math.abs(deg - snap) <= 3 && snap >= 5) deg = snap;
        state.angle = deg;
      }
      setLive({ id, kind, grip, ...state });
    };
    const release = () => {
      window.removeEventListener("mousemove", track);
      window.removeEventListener("touchmove", track);
      window.removeEventListener("mouseup", release);
      window.removeEventListener("touchend", release);
      cursor("");
      setLive(null);
      setHover(null);
      const stretch = !!boxy && !!(grip.w || grip.l);
      const moved = stretch
        ? Math.abs(state.width - boxy!.width) > 0.4 ||
          Math.abs(state.length - boxy!.length) > 0.4
        : kind === "resize"
          ? Math.abs(state.factor - 1) > 0.002
          : kind === "rotate"
            ? state.rotation !== entity.rotation
            : kind === "inner"
              ? !!donut && Math.abs(state.inner - donut.innerRadius) > 0.4
              : !!cone && Math.abs(state.angle - cone.angle) > 0.4;
      // The preview lived on the Konva node itself. The document stores
      // meaningful dimensions instead (the same fields the wheel changes),
      // so restore the authored node transform before the optimistic op
      // paints those dimensions in this same release turn.
      node.scaleX(entity.scale);
      node.scaleY(entity.scale);
      node.rotation(entity.rotation);
      node.x(entity.x);
      node.y(entity.y);
      if (!moved) return;
      // The document keeps whole dimensions, so the centre is worked out from
      // the rounded ones: the edge nobody touched must not creep by the
      // rounding of the edge that was dragged.
      const width = Math.round(state.width);
      const length = Math.round(state.length);
      const walkW = grip.w * ((width / 2) * entity.scale - halfW0);
      const walkL = grip.l * ((length / 2) * entity.scale - halfL0);
      void onTransform({
        factor: kind === "resize" ? Math.round(state.factor * 1000) / 1000 : 1,
        ...(kind === "rotate" && directional ? { rotation: Math.round(state.rotation * 10) / 10 } : {}),
        ...(kind === "inner" ? { innerRadius: Math.round(state.inner) } : {}),
        ...(kind === "angle" ? { angle: Math.round(state.angle) } : {}),
        ...(grip.w ? { width } : {}),
        ...(grip.l ? { length } : {}),
        ...(stretch && (walkW || walkL)
          ? {
              x: Math.round(entity.x + along.x * walkW + front.x * walkL),
              y: Math.round(entity.y + along.y * walkW + front.y * walkL),
            }
          : {}),
      });
    };
    window.addEventListener("mousemove", track);
    window.addEventListener("touchmove", track);
    window.addEventListener("mouseup", release);
    window.addEventListener("touchend", release);
  }

  /** One tick: the quiet visible mark, its hover halo, and a fat invisible grab disc. */
  const tick = (
    kind: PinKind,
    at: { x: number; y: number },
    mark: ReactNode,
    grabCursor: string,
    opts: { hitRadius?: number; grip?: Grip } = {}
  ) => {
    const grip = opts.grip ?? { w: 0 as const, l: 0 as const };
    const hitRadius = opts.hitRadius ?? 11;
    // Each edge and corner is its own grip, so only the one in the hand lights:
    // lighting a whole pair would say the pair moves, and it does not.
    const id = gripId(kind, grip);
    const lit = hover === id || live?.id === id;
    return (
      <Group key={id} x={at.x} y={at.y}>
        {lit && <Circle radius={hitRadius * unit} fill="rgba(122, 162, 247, 0.25)" listening={false} />}
        {mark}
        <Circle
          name="pin-grab"
          radius={hitRadius * unit}
          fill="#000"
          opacity={0}
          onMouseEnter={() => { setHover(id); cursor(grabCursor); }}
          onMouseLeave={() => { if (!live) { setHover(null); cursor(""); } }}
          onMouseDown={(evt) => begin(kind, evt, grip)}
          onTouchStart={(evt) => begin(kind, evt, grip)}
        />
      </Group>
    );
  };

  // A stretch grip's readout sits by the grip itself, which is the edge or the
  // corner in the hand — and that one keeps moving while the rest hold still.
  const stretchAt =
    live && live.grip.w && live.grip.l
      ? cornerAt(live.grip.w as 1 | -1, live.grip.l as 1 | -1)
      : live?.grip.w
        ? { x: widthAt.x * live.grip.w, y: widthAt.y * live.grip.w }
        : live?.grip.l
          ? { x: lengthAt.x * live.grip.l, y: lengthAt.y * live.grip.l }
          : null;
  const readoutAt = stretchAt
    ? { x: stretchAt.x + 16 * unit, y: stretchAt.y + 16 * unit }
    : live?.kind === "resize"
      ? { x: resizeAt.x + 16 * unit, y: resizeAt.y + 16 * unit }
      : live?.kind === "inner"
        ? { x: innerAt.x - 70 * unit, y: innerAt.y - 30 * unit }
        : live?.kind === "angle"
          ? { x: coneAt.x + 16 * unit, y: coneAt.y + 16 * unit }
          : { x: resizeAt.x + 16 * unit, y: edgeAt(0, -1).y - 30 * unit };
  const readoutW = (live?.kind === "corner" ? 74 : 54) * unit;
  const readout = live && (
    <Group x={readoutAt.x} y={readoutAt.y}>
      <Rect width={readoutW} height={20 * unit} cornerRadius={5 * unit} fill="#232833" stroke="#2e3543" strokeWidth={1 * unit} />
      <Text
        width={readoutW}
        height={20 * unit}
        align="center"
        verticalAlign="middle"
        fontSize={12 * unit}
        fill="#e6ebf2"
        text={
          live.kind === "corner"
            ? `${Math.round(live.width)}×${Math.round(live.length)}`
            : live.kind === "resize"
              ? `${Math.round(live.factor * 100)}%`
              : live.kind === "inner"
                ? `${Math.round(live.inner)}`
                : live.kind === "width"
                  ? `${Math.round(live.width)}`
                  : live.kind === "length"
                    ? `${Math.round(live.length)}`
                    : `${Math.round(live.kind === "angle" ? live.angle : live.rotation)}°`
        }
      />
    </Group>
  );

  const grew = (id: string) => (hover === id || live?.id === id ? 1.4 : 1);
  return (
    <Group ref={group} name="selection-pins" x={centre.x} y={centre.y}>
      <SilhouetteEdge
        name="selection"
        silhouette={silhouette}
        scale={edgeScale}
        rotation={rotation}
        unit={unit}
        color={chipColor(entity)}
      />
      {/* A boxy shape wears eight grips of its own, each holding the side
          opposite it still; a uniform centre scale would only fight them. */}
      {!boxy &&
        tick(
        "resize",
        resizeAt,
        <Line
          points={[-6 * unit * Math.SQRT1_2, -6 * unit * Math.SQRT1_2, 6 * unit * Math.SQRT1_2, 6 * unit * Math.SQRT1_2].map(
            (v) => v * grew("resize")
          )}
          stroke="#e6ebf2"
          strokeWidth={3 * unit}
          lineCap="round"
          listening={false}
          shadowColor="#14171c"
          shadowBlur={2 * unit}
        />,
        "nwse-resize"
      )}
      {directional &&
        tick(
          "rotate",
          rotateAt,
          <Shape
            listening={false}
            sceneFunc={(ctx, shape) => {
              // A short arc curving around the entity centre, through the
              // tick's (possibly view-clamped) position.
              const r = Math.max(1, Math.hypot(rotateAt.x, rotateAt.y));
              const a = Math.atan2(rotateAt.y, rotateAt.x);
              const span = (8 * unit * grew("rotate")) / r;
              ctx.beginPath();
              ctx.arc(-rotateAt.x, -rotateAt.y, r, a - span, a + span);
              ctx.strokeShape(shape);
            }}
            stroke="#fcd34d"
            strokeWidth={3 * unit}
            lineCap="round"
            shadowColor="#14171c"
            shadowBlur={2 * unit}
          />,
          "grab"
        )}
      {donut &&
        tick(
          "inner",
          innerAt,
          <Line
            points={[-6 * unit * Math.SQRT1_2, -6 * unit * Math.SQRT1_2, 6 * unit * Math.SQRT1_2, 6 * unit * Math.SQRT1_2].map(
              (v) => v * grew("inner")
            )}
            stroke="#e6ebf2"
            strokeWidth={3 * unit}
            lineCap="round"
            listening={false}
            shadowColor="#14171c"
            shadowBlur={2 * unit}
          />,
          "nwse-resize"
        )}
      {cone &&
        tick(
          "angle",
          coneAt,
          <Shape
            listening={false}
            sceneFunc={(ctx, shape) => {
              // A short arc along the cone's own rim, centred on the edge grip
              // (or on its view-clamped stand-in near the wall).
              const rim = Math.max(1, Math.hypot(coneAt.x, coneAt.y));
              const a = Math.atan2(coneAt.y, coneAt.x);
              const span = (8 * unit * grew("angle")) / rim;
              ctx.beginPath();
              ctx.arc(-coneAt.x, -coneAt.y, rim, a - span, a + span);
              ctx.strokeShape(shape);
            }}
            stroke="#e6ebf2"
            strokeWidth={3 * unit}
            lineCap="round"
            shadowColor="#14171c"
            shadowBlur={2 * unit}
          />,
          "grab"
        )}
      {boxy &&
        // A pill riding the middle of each of the four edges, long side lying
        // along its edge: the pair on the sides edits width, the pair on the
        // ends edits length. Dragging one walks that edge and leaves the one
        // across from it standing, so the box grows the way you pull it.
        ([1, -1] as const).flatMap((side) => {
          const w = grew(gripId("width", { w: side, l: 0 }));
          const l = grew(gripId("length", { w: 0, l: side }));
          return [
            tick(
              "width",
              clampView({ x: widthAt.x * side, y: widthAt.y * side }),
              <Rect
                width={8 * unit * w}
                height={36 * unit * w}
                offsetX={(8 * unit * w) / 2}
                offsetY={(36 * unit * w) / 2}
                cornerRadius={4 * unit * w}
                rotation={rotation}
                fill="#e6ebf2"
                listening={false}
                shadowColor="#14171c"
                shadowBlur={2 * unit}
              />,
              axisCursor(xAxis),
              { grip: { w: side, l: 0 }, hitRadius: 18 }
            ),
            tick(
              "length",
              clampView({ x: lengthAt.x * side, y: lengthAt.y * side }),
              <Rect
                width={36 * unit * l}
                height={8 * unit * l}
                offsetX={(36 * unit * l) / 2}
                offsetY={(8 * unit * l) / 2}
                cornerRadius={4 * unit * l}
                rotation={rotation}
                fill="#e6ebf2"
                listening={false}
                shadowColor="#14171c"
                shadowBlur={2 * unit}
              />,
              axisCursor(frontAxis),
              { grip: { w: 0, l: side }, hitRadius: 18 }
            ),
          ];
        })}
      {boxy &&
        // A bracket in each corner, its two arms lying inside the two edges it
        // holds: one drag stretches both, anchored on the corner across the
        // box. Drawn after the pills so on a shape too thin to keep them apart
        // the corner, which is the smaller target, wins the overlap.
        ([1, -1] as const).flatMap((sw) =>
          ([1, -1] as const).map((sl) => {
            const arm = 9 * unit * grew(gripId("corner", { w: sw, l: sl }));
            return tick(
              "corner",
              clampView(cornerAt(sw, sl)),
              <Line
                points={[-sw * arm, 0, 0, 0, 0, sl * arm]}
                rotation={rotation}
                stroke="#e6ebf2"
                strokeWidth={3 * unit}
                lineCap="round"
                lineJoin="round"
                listening={false}
                shadowColor="#14171c"
                shadowBlur={2 * unit}
              />,
              axisCursor({
                x: xAxis.x * sw + frontAxis.x * sl,
                y: xAxis.y * sw + frontAxis.y * sl,
              }),
              { grip: { w: sw, l: sl }, hitRadius: 10 }
            );
          })
        )}
      {readout}
    </Group>
  );
}

function TransformAxis({
  kind,
  count,
  pivot,
  entities,
}: {
  kind: SymmetryKind;
  count: SymmetryCount;
  pivot: { x: number; y: number };
  entities: Entity[];
}) {
  const reach = Math.max(55, ...entities.map((e) => Math.hypot(e.x - pivot.x, e.y - pivot.y) + radiusHint(e) + 18));
  // Rotate is amber, slide/mirror is sky — the same pair as the toolbar toggle,
  // so a glance at either tells you what a multi-select drag is about to do.
  const color = kind === "rotate" ? "rgba(252, 211, 77, 0.95)" : "rgba(125, 211, 252, 0.95)";
  const fill = kind === "rotate" ? "rgba(217, 119, 6, 0.78)" : "rgba(2, 132, 199, 0.78)";
  const under = "rgba(23, 26, 35, 0.68)";
  const label = kind === "rotate" ? "ROTATE" : count > 1 ? "MIRROR" : "TRANSLATE";

  const caption = (x: number, y: number) => (
    <Text
      x={x - 60}
      y={y}
      width={120}
      align="center"
      text={label}
      fontSize={15}
      fontStyle="bold"
      fill={color}
      stroke={under}
      strokeWidth={4}
      fillAfterStrokeEnabled
      letterSpacing={2}
    />
  );

  if (kind === "mirror" && count === 1) {
    // Symmetry is off, so a drag slides the whole selection; there is no axis
    // to show. Mark the selection centroid with a move cross instead.
    const cx = entities.reduce((sum, e) => sum + e.x, 0) / entities.length;
    const cy = entities.reduce((sum, e) => sum + e.y, 0) / entities.length;
    return (
      <Group name="transform-axis" x={cx} y={cy} listening={false} opacity={0.9}>
        {[0, 90, 180, 270].map((deg) => (
          <Arrow
            key={deg}
            points={[0, 0, 26, 0]}
            rotation={deg}
            stroke={under}
            fill={under}
            strokeWidth={7}
            pointerLength={9}
            pointerWidth={9}
          />
        ))}
        {[0, 90, 180, 270].map((deg) => (
          <Arrow
            key={`c${deg}`}
            points={[0, 0, 26, 0]}
            rotation={deg}
            stroke={color}
            fill={color}
            strokeWidth={3}
            pointerLength={9}
            pointerWidth={9}
          />
        ))}
        <Circle radius={10} fill={fill} stroke={under} strokeWidth={5} />
        <Circle radius={10} stroke={color} strokeWidth={3} />
        <Circle radius={3.5} fill="#ffffff" />
        {caption(0, 22)}
      </Group>
    );
  }

  if (kind === "mirror") {
    return (
      <Group name="transform-axis" listening={false} opacity={0.9}>
        <Line points={[pivot.x, pivot.y - reach, pivot.x, pivot.y + reach]} stroke={under} strokeWidth={7} dash={[10, 8]} />
        <Line points={[pivot.x, pivot.y - reach, pivot.x, pivot.y + reach]} stroke={color} strokeWidth={3} dash={[10, 8]} />
        {count === 4 && (
          <>
            <Line points={[pivot.x - reach, pivot.y, pivot.x + reach, pivot.y]} stroke={under} strokeWidth={7} dash={[10, 8]} />
            <Line points={[pivot.x - reach, pivot.y, pivot.x + reach, pivot.y]} stroke={color} strokeWidth={3} dash={[10, 8]} />
          </>
        )}
        <Circle x={pivot.x} y={pivot.y} radius={12} fill={fill} stroke={under} strokeWidth={7} />
        <Circle x={pivot.x} y={pivot.y} radius={12} stroke={color} strokeWidth={3} />
        <Circle x={pivot.x} y={pivot.y} radius={3.5} fill="#ffffff" />
        {caption(pivot.x, pivot.y + 22)}
      </Group>
    );
  }
  const guide = Math.max(40, ...entities.map((e) => Math.hypot(e.x - pivot.x, e.y - pivot.y)));
  return (
    <Group name="transform-axis" x={pivot.x} y={pivot.y} listening={false} opacity={0.9}>
      <Circle radius={guide} stroke={under} strokeWidth={7} dash={[12, 9]} />
      <Circle radius={guide} stroke={color} strokeWidth={3} dash={[12, 9]} />
      {/* Arrowhead on the guide ring, pointing along the direction of travel. */}
      <Arrow
        x={guide}
        y={0}
        points={[0, -14, 0, 14]}
        stroke={under}
        fill={under}
        strokeWidth={7}
        pointerLength={10}
        pointerWidth={10}
      />
      <Arrow
        x={guide}
        y={0}
        points={[0, -14, 0, 14]}
        stroke={color}
        fill={color}
        strokeWidth={3}
        pointerLength={10}
        pointerWidth={10}
      />
      <Circle radius={14} fill={fill} stroke={under} strokeWidth={7} />
      <Circle radius={14} stroke={color} strokeWidth={3} />
      <Line points={[-18, 0, 18, 0]} stroke={color} strokeWidth={3} />
      <Line points={[0, -18, 0, 18]} stroke={color} strokeWidth={3} />
      <Circle radius={4} fill="#ffffff" />
      {caption(0, 24)}
    </Group>
  );
}

function ArenaFloor({ plan }: { plan: Plan }) {
  const { arena } = plan;
  const w = arena.width;
  const h = arena.shape === "rect" ? arena.height : arena.width;
  const lines: React.ReactNode[] = [];
  const g = arena.grid;

  if (g.type === "square") {
    for (let i = 1; i < g.cols; i++) {
      const x = -w / 2 + (w / g.cols) * i;
      lines.push(<Line key={`v${i}`} points={[x, -h / 2, x, h / 2]} stroke={g.color} strokeWidth={2} />);
    }
    for (let i = 1; i < g.rows; i++) {
      const y = -h / 2 + (h / g.rows) * i;
      lines.push(<Line key={`h${i}`} points={[-w / 2, y, w / 2, y]} stroke={g.color} strokeWidth={2} />);
    }
  } else if (g.type === "radial") {
    for (let i = 1; i <= g.rings; i++)
      lines.push(
        <Circle key={`r${i}`} radius={(w / 2) * (i / g.rings)} stroke={g.color} strokeWidth={2} />
      );
    for (let i = 0; i < g.spokes; i++) {
      const a = ((i / g.spokes) * 360 + g.angle - 90) * (Math.PI / 180);
      lines.push(
        <Line
          key={`s${i}`}
          points={[0, 0, Math.cos(a) * (w / 2), Math.sin(a) * (w / 2)]}
          stroke={g.color}
          strokeWidth={2}
        />
      );
    }
  } else if (g.type === "cross") {
    lines.push(<Line key="cx" points={[-w / 2, 0, w / 2, 0]} stroke={g.color} strokeWidth={2} />);
    lines.push(<Line key="cy" points={[0, -h / 2, 0, h / 2]} stroke={g.color} strokeWidth={2} />);
  }

  const backdrop = assetUrl(arena.image);

  const floor =
    arena.shape === "circle" ? (
      <Circle radius={w / 2} fill={arena.color} stroke={arena.border} strokeWidth={4} />
    ) : (
      <Rect
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        fill={arena.color}
        stroke={arena.border}
        strokeWidth={4}
        cornerRadius={8}
      />
    );

  const clip =
    arena.shape === "circle"
      ? (ctx: Konva.Context) => {
          ctx.arc(0, 0, w / 2, 0, Math.PI * 2, false);
        }
      : undefined;

  return (
    <Group listening={false}>
      {floor}
      <Group clipFunc={clip}>
        {backdrop && (
          <Sprite src={backdrop} width={w} height={h} opacity={arena.imageOpacity} listening={false} />
        )}
        {lines}
      </Group>
    </Group>
  );
}

/**
 * An invisible disc under the token types whose art has transparent margins, so
 * the whole token is grabbable. Konva's hit graph ignores opacity, so a
 * 0-opacity fill is still hit-testable.
 *
 * Deliberately NOT applied to zones: a 400-unit cone would then swallow every
 * click inside its bounding circle, including tokens drawn under it.
 */
function GrabTarget({ entity }: { entity: Entity }) {
  switch (entity.type) {
    case "marker":
    case "player":
    case "icon":
      return <Circle radius={Math.max(20, entity.size / 2)} fill="#000" opacity={0} />;
    case "enemy":
      return <Circle radius={Math.max(20, entity.size * 0.55)} fill="#000" opacity={0} />;
    case "zone":
      // A donut's hole is a real gap in the shape; make it grabbable, nothing more.
      return entity.shape === "donut" ? (
        <Circle radius={entity.innerRadius} fill="#000" opacity={0} />
      ) : null;
    default:
      return null;
  }
}

const ACCENT = "#7aa2f7";

/**
 * The outline a selection hugs, in the entity's own unscaled, unrotated space:
 * a token's frame, a telegraph's rim, a beam's box, a cone's wedge. Drawn as a
 * hairline two pixels outside the thing, so the thing itself stays as drawn.
 */
type Silhouette =
  | { kind: "circle"; r: number }
  | { kind: "box"; hw: number; hh: number; corner: number }
  | { kind: "wedge"; r: number; angle: number };

function silhouetteOf(e: Entity, live?: { width?: number; length?: number }): Silhouette {
  switch (e.type) {
    case "player":
      return { kind: "box", hw: e.size / 2, hh: e.size / 2, corner: 8 };
    case "icon":
      return { kind: "box", hw: e.size / 2, hh: e.size / 2, corner: 6 };
    case "marker":
      return { kind: "circle", r: e.size / 2 };
    case "enemy":
      // The reticle's arms reach half again past its ring; the art is a touch
      // wider than the size it is stamped at.
      return { kind: "circle", r: e.role === "anchor" ? e.size * 0.55 * 1.5 : e.size * 0.575 };
    case "zone":
      switch (e.shape) {
        case "rect":
        case "line":
        case "knockback":
        case "arrow":
        case "linestack":
          return {
            kind: "box",
            hw: (live?.width || e.width) / 2,
            hh: (live?.length || e.length) / 2,
            corner: 0,
          };
        case "cone":
          return { kind: "wedge", r: e.radius, angle: e.angle };
        case "cross":
          // The hairline hugs the square the two bars span.
          return { kind: "box", hw: e.length / 2, hh: e.length / 2, corner: 0 };
        default:
          return { kind: "circle", r: e.radius };
      }
    case "text": {
      const w = Math.max(e.fontSize * 2, e.text.length * e.fontSize * 0.62);
      return { kind: "box", hw: w / 2, hh: e.fontSize / 2, corner: 4 };
    }
    case "path": {
      let reach = 0;
      for (let i = 0; i + 1 < e.points.length; i += 2) {
        reach = Math.max(reach, Math.hypot(e.points[i], e.points[i + 1]));
      }
      return { kind: "circle", r: reach + e.width / 2 };
    }
    default:
      return { kind: "circle", r: radiusHint(e) };
  }
}

/**
 * How far from the centre, along a direction in arena space, the silhouette's
 * edge lies, for an entity drawn at `scale` and turned by `rotation` degrees.
 * A wedge answers for its bounding circle; `edgePoint` knows its arc.
 */
function rayOut(s: Silhouette, scale: number, rotation: number, dx: number, dy: number): number {
  if (s.kind !== "box") return s.r * scale;
  const rad = (-rotation * Math.PI) / 180;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.min(s.hw / Math.max(1e-6, Math.abs(lx)), s.hh / Math.max(1e-6, Math.abs(ly))) * scale;
}

/** The point `pad` outside the silhouette in a direction, relative to the centre. */
function edgePoint(
  s: Silhouette,
  scale: number,
  rotation: number,
  dx: number,
  dy: number,
  pad: number
): { x: number; y: number } {
  if (s.kind === "wedge") {
    // The arc spans the facing ± half the spread; a direction outside it
    // lands on the nearer end of the arc rather than on empty floor.
    const facing = ((rotation - 90) * Math.PI) / 180;
    const raw = Math.atan2(dy, dx) - facing;
    const off = Math.atan2(Math.sin(raw), Math.cos(raw));
    const half = (s.angle * Math.PI) / 360;
    const a = facing + Math.max(-half, Math.min(half, off));
    const d = s.r * scale + pad;
    return { x: Math.cos(a) * d, y: Math.sin(a) * d };
  }
  const d = rayOut(s, scale, rotation, dx, dy) + pad;
  return { x: dx * d, y: dy * d };
}

/** How far above and below its centre the silhouette reaches, at `scale` and `rotation`. */
function extentY(s: Silhouette, scale: number, rotation: number): number {
  if (s.kind !== "box") return s.r * scale;
  const rad = (rotation * Math.PI) / 180;
  return (Math.abs(s.hw * Math.sin(rad)) + Math.abs(s.hh * Math.cos(rad))) * scale;
}

/**
 * Where a level line at `dy` below the centre meets the silhouette's flank on
 * one side, or null when the line misses it. A wedge answers for its arc's
 * circle, so a leader always has somewhere to leave from.
 */
function flankX(s: Silhouette, scale: number, rotation: number, dy: number, side: -1 | 1): number | null {
  if (s.kind !== "box") {
    const r = s.r * scale;
    return Math.abs(dy) > r ? null : side * Math.sqrt(r * r - dy * dy);
  }
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    [-s.hw, -s.hh],
    [s.hw, -s.hh],
    [s.hw, s.hh],
    [-s.hw, s.hh],
  ].map(([x, y]) => ({ x: (x * cos - y * sin) * scale, y: (x * sin + y * cos) * scale }));
  let best: number | null = null;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    if ((dy < Math.min(a.y, b.y)) || (dy > Math.max(a.y, b.y))) continue;
    const x = a.y === b.y ? (side > 0 ? Math.max(a.x, b.x) : Math.min(a.x, b.x)) : a.x + ((dy - a.y) * (b.x - a.x)) / (b.y - a.y);
    if (best === null || side * x > side * best) best = x;
  }
  return best;
}

/**
 * The hairline that says "this one": two screen pixels outside the silhouette,
 * in the thing's own colour. `unit` is one screen pixel in the enclosing
 * group's units, so the line stays a hairline whatever the group's scale.
 */
function SilhouetteEdge({
  silhouette: s,
  scale = 1,
  rotation = 0,
  unit,
  color,
  width = 1.2,
  opacity = 0.9,
  name,
}: {
  silhouette: Silhouette;
  scale?: number;
  rotation?: number;
  unit: number;
  color: string;
  width?: number;
  opacity?: number;
  name?: string;
}) {
  const pad = 2 * unit;
  const common = { name, stroke: color, strokeWidth: width * unit, opacity, listening: false };
  if (s.kind === "circle") return <Circle {...common} radius={s.r * scale + pad} />;
  if (s.kind === "wedge") {
    return (
      <Wedge
        {...common}
        radius={s.r * scale + pad}
        angle={s.angle}
        rotation={rotation - 90 - s.angle / 2}
      />
    );
  }
  const w = s.hw * scale + pad;
  const h = s.hh * scale + pad;
  return (
    <Rect
      {...common}
      offsetX={w}
      offsetY={h}
      width={2 * w}
      height={2 * h}
      rotation={rotation}
      cornerRadius={s.corner ? s.corner * scale + pad : 0}
    />
  );
}

/** The colour a thing is drawn in, which its leader and chip borrow. */
function chipColor(e: Entity): string {
  switch (e.type) {
    case "player":
      return e.color ?? jobColor(e.job);
    case "marker":
      return e.color ?? MARKER_COLORS[e.marker] ?? "#e6edf3";
    case "enemy":
      return e.color ?? (e.role === "anchor" ? "#e0b152" : "#c0392b");
    case "zone":
      return e.color ?? ZONE_DEFAULT;
    case "text":
    case "path":
      return e.color ?? "#e6edf3";
    default:
      return "#e6edf3";
  }
}

const SHAPE_NAMES: Partial<Record<ZoneEntity["shape"], string>> = {
  circle: "AoE",
  linestack: "Line stack",
};

/** A cross squared to the cardinals is a plus; anything else is an ×. */
const crossName = (rotation: number) => (((rotation % 90) + 90) % 90 === 0 ? "Plus" : "Cross");

/** What a chip says: a name, and the one dimension a raider would ask about. */
function chipText(e: Entity): { label: string; sub: string } {
  const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  switch (e.type) {
    case "player":
      // The callout name is the whole identity a raider needs ("R2"); the
      // job on top of it only makes the chip longer.
      return { label: e.name || jobLabel(e.job), sub: "" };
    case "enemy":
      return {
        label: e.name || (e.role === "anchor" ? "Anchor" : "Enemy"),
        sub: e.name && e.role === "anchor" ? "anchor" : "",
      };
    case "marker":
      return { label: e.marker, sub: "waymark" };
    case "zone": {
      const k = e.scale;
      const turn = e.rotation ? ` · ${Math.round(e.rotation)}°` : "";
      const boxy = ["rect", "line", "knockback", "arrow", "linestack", "cross"].includes(e.shape);
      const sub = boxy
        ? `${Math.round(e.width * k)} × ${Math.round(e.length * k)}${turn}`
        : e.shape === "cone"
          ? `r ${Math.round(e.radius * k)} · ${Math.round(e.angle)}°`
          : e.shape === "donut"
            ? `r ${Math.round(e.innerRadius * k)}–${Math.round(e.radius * k)}`
            : `r ${Math.round(e.radius * k)}`;
      const many = e.anchor?.pick && e.anchor.count > 1 ? ` · ×${e.anchor.count}` : "";
      const shapeName = e.shape === "cross" ? crossName(e.rotation) : SHAPE_NAMES[e.shape] || cap(e.shape);
      return { label: e.name || e.bond?.label || shapeName, sub: sub + many };
    }
    case "text":
      return { label: e.text.length > 18 ? `${e.text.slice(0, 17)}…` : e.text, sub: "text" };
    case "path":
      return { label: e.name || "Path", sub: `${Math.floor(e.points.length / 2)} pts` };
    case "icon":
      return { label: e.name || "Icon", sub: "" };
    default:
      return { label: e.type, sub: "" };
  }
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Width of a run of text in the chip's font, in screen pixels. */
function textWidth(text: string, font: string): number {
  if (measureCtx === undefined) {
    measureCtx =
      typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  if (!measureCtx) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/**
 * Konva draws a shape that has both a fill and a stroke through a stage-sized
 * buffer canvas whenever the shape is transparent or carries a shadow, so that
 * the stroke cannot bleed into the fill underneath it. That buffer is cleared
 * and composited once per shape per frame, and a step walk or a drag redraws
 * the whole floor every frame: sixteen such shapes — the party's hitbox pips
 * and their name labels — were a two-frames-a-second drag on a slow machine,
 * and turning chips on added twenty more. What the buffer buys is half a
 * stroke's width of blending under a translucent fill, which no one reading a
 * plan can see. The frames are worth more.
 */
const NO_BUFFER = { perfectDrawEnabled: false, shadowForStrokeEnabled: false } as const;

const CHIP_H = 26;
const CHIP_GAP = 4;
const CHIP_PAD = 8;
const GLYPH = 16;
/** The debuff badge: taller than the glyph, in the 0.76 ratio of FFXIV status art. */
const BADGE_H = 22;
const BADGE_W = BADGE_H * 0.76;
const LABEL_FONT = "bold 12px Arial";
const SUB_FONT = "11px Arial";

/** The small picture of what a chip stands for: its art, or its shape in outline. */
function ChipGlyph({
  entity: e,
  unit,
  color,
  dress,
}: {
  entity: Entity;
  unit: number;
  color: string;
  /** A debuff mech is on the floor: the art the token wears, so the chip matches. */
  dress?: DebuffDress;
}) {
  const g = GLYPH * unit;
  const line = { stroke: color, strokeWidth: 1.5 * unit, listening: false };
  switch (e.type) {
    case "player":
      return (
        <Sprite
          src={assetUrl((dress ? dressIconKey(e, dress.mode) : undefined) ?? e.icon ?? jobIconKey(e.job, e.name))}
          width={g}
          height={g}
          listening={false}
          fallback={<Circle radius={g * 0.45} fill={color} listening={false} />}
        />
      );
    case "marker":
      return (
        <Sprite
          src={assetUrl(waymarkIconKey(e.marker))}
          width={g}
          height={g}
          listening={false}
          fallback={<Circle {...line} radius={g * 0.45} />}
        />
      );
    case "enemy":
      return e.role === "anchor" ? (
        <Circle {...line} radius={g * 0.4} dash={[2 * unit, 2 * unit]} />
      ) : (
        <Sprite
          src={assetUrl(e.icon ?? enemyIconKey(e.size))}
          width={g}
          height={g}
          listening={false}
          fallback={<Circle radius={g * 0.45} fill={color} listening={false} />}
        />
      );
    case "icon":
      return <Sprite src={assetUrl(e.src)} width={g} height={g} listening={false} />;
    case "zone":
      if (["rect", "line", "knockback", "arrow", "linestack"].includes(e.shape)) {
        return (
          <Rect
            {...line}
            width={g * 0.55}
            height={g * 0.9}
            offsetX={g * 0.275}
            offsetY={g * 0.45}
            rotation={e.rotation}
            cornerRadius={1 * unit}
          />
        );
      }
      if (e.shape === "cone") {
        return (
          <Wedge
            {...line}
            radius={g * 0.5}
            angle={e.angle}
            rotation={e.rotation - 90 - e.angle / 2}
          />
        );
      }
      if (e.shape === "donut") {
        return <Ring {...line} innerRadius={g * 0.2} outerRadius={g * 0.45} />;
      }
      if (e.shape === "cross") {
        return (
          <Line
            {...line}
            points={crossOutline(g * 0.2, g * 0.9)}
            closed
            rotation={e.rotation}
          />
        );
      }
      return <Circle {...line} radius={g * 0.45} />;
    case "path":
      return (
        <Line
          {...line}
          points={[-g / 2, g / 3, -g / 6, -g / 3, g / 6, g / 3, g / 2, -g / 3]}
          lineCap="round"
          lineJoin="round"
        />
      );
    default:
      return null;
  }
}

/**
 * The selection's readout, outside the floor. Each selected thing gets a
 * leader in its own colour, running from its silhouette at 45° to a knee and
 * then level out to the nearer margin, where a chip names it: art or shape,
 * name, and the one dimension that matters. The chips stack down the margin
 * so none overlap, whatever is piled up on the floor, and each is a click
 * target for the thing it names.
 */
function Chips({
  entities,
  selectedIds,
  locked,
  pixelsPerUnit,
  viewHalf,
  floorHalf,
  dress,
  leaders,
}: {
  entities: Entity[];
  selectedIds: Set<string>;
  /** Locked things say so on their chip, which is not a way to click them. */
  locked: (e: Entity) => boolean;
  pixelsPerUnit: number;
  /** Half-extent (arena units) of the visible canvas around the arena centre. */
  viewHalf: number;
  /** Half the floor's width: where the margin starts. */
  floorHalf: number;
  /** What the party wears while a debuff mech is on the floor, by player id. */
  dress?: Map<string, DebuffDress> | null;
  /** The leaders, held apart so they can be cut the instant the floor moves. */
  leaders?: MutableRefObject<Konva.Group | null>;
}) {
  const group = useRef<Konva.Group>(null);
  const [hover, setHover] = useState<string | null>(null);
  const unit = 1 / Math.max(0.001, pixelsPerUnit);
  const px = (n: number) => n * unit;
  const cursor = (style: string) => {
    const container = group.current?.getStage()?.container();
    if (container) container.style.cursor = style;
  };

  const slots = entities.map((e) => {
    const text = chipText(e);
    const label = text.label;
    const sub = locked(e) ? (text.sub ? `${text.sub} · locked` : "locked") : text.sub;
    const glyph = e.type !== "text";
    // A debuffed player carries their status on the chip too, drawn taller
    // than the token glyph so "who has it" reads without hunting the floor.
    const worn = dress?.get(e.id);
    const badge = worn?.debuff?.icon;
    const labelW = textWidth(label, LABEL_FONT);
    const subW = sub ? textWidth(sub, SUB_FONT) : 0;
    const w = px(
      CHIP_PAD * 2 +
        (glyph ? GLYPH + 6 : 0) +
        (badge ? BADGE_W + 6 : 0) +
        labelW +
        (sub ? 5 + subW : 0)
    );
    const side: -1 | 1 = e.x < 0 ? -1 : 1;
    // Preferred height: a short 45° run above the top of the shape, so the
    // leader leaves it diagonally and then runs level to the margin.
    const reach = extentY(silhouetteOf(e), e.scale, e.rotation);
    return { e, side, pref: e.y - reach - px(40), y: 0, w, label, sub, glyph, badge, dress: worn, labelW, lane: 0, lanes: 1 };
  });
  // Stack each margin's chips from their preferred heights, pushing down to
  // clear the one above, then back up from the bottom edge if that overflowed.
  const top = -viewHalf + px(6 + CHIP_H / 2);
  const bottom = viewHalf - px(6 + CHIP_H / 2);
  const step = px(CHIP_H + CHIP_GAP);
  for (const side of [-1, 1]) {
    const mine = slots.filter((slot) => slot.side === side).sort((a, b) => a.pref - b.pref);
    let last = -Infinity;
    for (const slot of mine) {
      slot.y = Math.max(top, slot.pref, last + step);
      last = slot.y;
    }
    let next = Infinity;
    for (let i = mine.length - 1; i >= 0; i--) {
      mine[i].y = Math.min(mine[i].y, next - step, bottom);
      next = mine[i].y;
    }
    // Things piled on one tile would all leave from the same point: fan them
    // out instead, each a few pixels further down the flank, in chip order,
    // so their leaders run parallel and never cross.
    const piles: (typeof mine)[] = [];
    for (const slot of mine) {
      const pile = piles.find((members) =>
        members.some(
          (other) => Math.abs(other.e.x - slot.e.x) < px(24) && Math.abs(other.e.y - slot.e.y) < px(24)
        )
      );
      if (pile) pile.push(slot);
      else piles.push([slot]);
    }
    for (const pile of piles) {
      pile.forEach((slot, lane) => {
        slot.lane = lane;
        slot.lanes = pile.length;
      });
    }
  }

  // Where each chip and its leader end up, worked out once so the leaders can
  // be drawn as one group: they are switched off together the moment the floor
  // starts moving, while the plates stay where they are and fade.
  const drawn = slots.map((slot) => {
    const { e, side, y, w } = slot;
    const silhouette = silhouetteOf(e);
    // The chip hugs the floor's edge from outside, and only creeps over
    // the floor when the margin is too narrow for it.
    const inner = side * (floorHalf + px(12));
    const outer = side * (viewHalf - px(6));
    const chipX = side < 0 ? Math.max(inner - w, outer) : Math.min(inner, outer - w);
    const end = side < 0 ? chipX + w : chipX;
    // A leader is only ever level or at 45°. It leaves the flank facing
    // the chip at the chip's own height when that height lies within the
    // shape, and otherwise from the shape's upper or lower shoulder,
    // running 45° to a knee and then level. A pile's members leave a
    // lane apart down the flank.
    const reach = extentY(silhouette, e.scale, e.rotation);
    const shoulder = silhouette.kind === "box" ? reach : reach * Math.SQRT1_2;
    const fan = px(6) * (slot.lane - (y > e.y ? slot.lanes - 1 : 0));
    const dy = Math.max(-shoulder, Math.min(shoulder, y - e.y + fan));
    const fx = flankX(silhouette, e.scale, e.rotation, dy, side) ?? 0;
    const from = { x: e.x + fx + side * px(2), y: e.y + dy };
    const kx = from.x + side * Math.abs(y - from.y);
    const points =
      side * (end - kx) >= 0 ? [from.x, from.y, kx, y, end, y] : [from.x, from.y, end, y];
    // With every chip showing, the chips are the selection's readout as well as
    // its targets: a selected one wears the accent, and the others' leaders
    // step back so the selected ones' stand out.
    const picked = selectedIds.has(e.id);
    return {
      slot,
      color: chipColor(e),
      points,
      chipX,
      picked,
      quiet: selectedIds.size > 0 && !picked,
    };
  });

  return (
    <Group ref={group} name="chips">
      <Group ref={leaders} listening={false}>
        {drawn.map(({ slot, color, points, quiet }) => (
          <Line
            key={slot.e.id}
            points={points}
            stroke={color}
            strokeWidth={px(1.5)}
            opacity={quiet ? 0.35 : 1}
            lineCap="round"
            lineJoin="round"
            listening={false}
          />
        ))}
      </Group>
      {drawn.map(({ slot, color, chipX, picked, quiet }) => {
        const { e, y, w } = slot;
        const lit = hover === e.id;
        const badgeX = px(CHIP_PAD + (slot.glyph ? GLYPH + 6 : 0));
        const textX = badgeX + px(slot.badge ? BADGE_W + 6 : 0);
        return (
          <Group
            key={e.id}
            name="chip"
            entityId={e.id}
            x={chipX}
            y={y - px(CHIP_H / 2)}
            opacity={quiet && !lit ? 0.45 : 1}
            onMouseEnter={() => {
              setHover(e.id);
              cursor(locked(e) ? "" : "pointer");
            }}
            onMouseLeave={() => {
              setHover(null);
              cursor("");
            }}
          >
            <Rect
              width={w}
              height={px(CHIP_H)}
              cornerRadius={px(5)}
              fill={picked ? "rgba(122, 162, 247, 0.18)" : lit ? "#2e3543" : "#232833"}
              stroke={picked ? ACCENT : color}
              strokeWidth={px(picked ? 2 : 1.2)}
              shadowColor="#0d1117"
              shadowBlur={px(6)}
              shadowOpacity={0.5}
              {...NO_BUFFER}
            />
            {slot.glyph && (
              <Group x={px(CHIP_PAD + GLYPH / 2)} y={px(CHIP_H / 2)} listening={false}>
                <ChipGlyph entity={e} unit={unit} color={color} dress={slot.dress} />
              </Group>
            )}
            {slot.badge && (
              <Group x={badgeX + px(BADGE_W / 2)} y={px(CHIP_H / 2)} listening={false}>
                <Sprite src={slot.badge} width={px(BADGE_W)} height={px(BADGE_H)} />
              </Group>
            )}
            <Text
              x={textX}
              height={px(CHIP_H)}
              verticalAlign="middle"
              fontSize={px(12)}
              fontStyle="bold"
              fill="#e6ebf2"
              text={slot.label}
              listening={false}
            />
            {slot.sub && (
              <Text
                x={textX + px(slot.labelW + 5)}
                height={px(CHIP_H)}
                verticalAlign="middle"
                fontSize={px(11)}
                fill="#b8c0cc"
                text={slot.sub}
                listening={false}
              />
            )}
          </Group>
        );
      })}
    </Group>
  );
}

const TETHER_HIT_WIDTH = 30;

/**
 * Roughly how much arena a click on this entity could have landed on. Used to
 * resolve overlapping hits: the smaller the target, the more deliberate the aim,
 * so a token beats the AoE painted over it and a tether beats a huge zone.
 */
function hitArea(e: Entity, byId: Map<string, Entity>): number {
  const disc = (r: number) => Math.PI * r * r;
  const scale = e.scale * e.scale;
  switch (e.type) {
    case "marker":
    case "player":
    case "icon":
      return disc(e.size / 2) * scale;
    case "enemy":
      return disc(e.size * 0.55) * scale;
    case "text":
      return e.text.length * e.fontSize * e.fontSize * 0.62 * scale;
    case "path": {
      const xs = e.points.filter((_, i) => i % 2 === 0);
      const ys = e.points.filter((_, i) => i % 2 === 1);
      const w = Math.max(...xs) - Math.min(...xs) || e.width;
      const h = Math.max(...ys) - Math.min(...ys) || e.width;
      return (w + e.width) * (h + e.width) * scale;
    }
    case "tether": {
      const ends = tetherEnds(e, byId);
      if (!ends) return Infinity;
      return Math.hypot(ends.to.x - ends.from.x, ends.to.y - ends.from.y) * TETHER_HIT_WIDTH;
    }
    case "zone":
      switch (e.shape) {
        case "cone":
          return disc(e.radius) * (e.angle / 360) * scale;
        case "rect":
        case "line":
        case "knockback":
        case "arrow":
          return e.width * e.length * scale;
        case "donut":
          return (disc(e.radius) - disc(e.innerRadius)) * scale;
        case "cross":
          return (2 * e.width * e.length - e.width * e.width) * scale;
        case "exaflare":
          return disc(e.radius) * e.count * scale;
        default:
          return disc(e.radius) * scale;
      }
  }
}

/** Is this pointer sitting on one of the tokens a tether connects? */
function onTetherEnd(
  tether: Extract<Entity, { type: "tether" }>,
  at: { x: number; y: number },
  byId: Map<string, Entity>
): boolean {
  return [tether.from, tether.to].some((id) => {
    const end = byId.get(id);
    return end ? Math.hypot(end.x - at.x, end.y - at.y) <= radiusHint(end) : false;
  });
}

function radiusHint(e: Entity): number {
  switch (e.type) {
    case "player":
    case "marker":
      return e.size / 2;
    case "enemy":
      return e.size;
    case "zone":
      return e.shape === "rect" || e.shape === "line" || e.shape === "knockback" || e.shape === "arrow" || e.shape === "cross"
        ? Math.max(e.width, e.length) / 2
        : e.radius;
    case "text":
      return e.fontSize;
    default:
      return 40;
  }
}

function EntityShape({
  entity,
  blast = 0,
  dress,
}: {
  entity: Entity;
  blast?: number;
  /** A debuff mech is on the floor: what this token wears instead. */
  dress?: DebuffDress;
}) {
  switch (entity.type) {
    case "marker": {
      const color = entity.color ?? MARKER_COLORS[entity.marker];
      const r = entity.size / 2;
      return (
        <Sprite
          src={assetUrl(waymarkIconKey(entity.marker))}
          width={entity.size}
          height={entity.size}
          fallback={
            <>
              <Circle radius={r} fill={color} opacity={0.35} stroke={color} strokeWidth={4} {...NO_BUFFER} />
              <Label text={entity.marker} size={entity.size * 0.7} color={color} />
            </>
          }
        />
      );
    }

    case "player": {
      const color = entity.color ?? jobColor(entity.job);
      const r = entity.size / 2;
      // A debuff mech on the floor can re-dress the token: role or generic
      // art in place of the job's, and the status it carries as a badge.
      const worn = dress ? dressIconKey(entity, dress.mode) : undefined;
      const icon = assetUrl(worn ?? entity.icon ?? jobIconKey(entity.job, entity.name));
      return (
        <>
          <Sprite
            src={icon}
            width={entity.size}
            height={entity.size}
            fallback={
              <>
                <Circle radius={r} fill={color} stroke="#0d1117" strokeWidth={3} {...NO_BUFFER} />
                <Label text={jobLabel(entity.job)} size={entity.size * 0.38} color="#0d1117" bold />
              </>
            }
          />
          {/*
            The hitbox. A player in FFXIV is a point, so the token art around it
            is decoration: this pip is the thing an AoE either covers or does
            not, and without it a beam that clips the art reads as a hit.
          */}
          <Circle radius={5} fill="#f7fafc" stroke="#0d1117" strokeWidth={2} listening={false} {...NO_BUFFER} />
          {/* Role-coloured frame: the job art alone does not read as tank/healer/dps. */}
          <Rect
            x={-r}
            y={-r}
            width={entity.size}
            height={entity.size}
            stroke={color}
            strokeWidth={6}
            cornerRadius={8}
            listening={false}
          />
          {/* The status this token carries, riding the shoulder, drawn as tall
              as the token itself so it reads at a glance. FFXIV status icons
              are taller than wide; keeping the ratio is what makes the art
              recognisable. */}
          {dress?.debuff?.icon && (
            <Group x={r * 1.04} y={-r * 0.94} listening={false}>
              <Sprite src={dress.debuff.icon} width={entity.size * 0.76} height={entity.size} />
            </Group>
          )}
          {/* A genericized token (role, S/D, or generic art) has already
              dropped the identity that a callout name would still claim —
              the label would say "MT" over a token that no longer means MT. */}
          {entity.name && !worn && (
            <EntityName
              text={entity.name}
              y={r + 4}
              rotation={entity.rotation}
              width={200}
              fontSize={entity.size * 0.36}
              strokeWidth={4}
            />
          )}
          {entity.showFacing && (
            <Line points={[0, -r, 0, -r - 18]} stroke="#e6edf3" strokeWidth={6} lineCap="round" />
          )}
        </>
      );
    }

    case "enemy": {
      // An anchor is a place, not a creature: no art, no facing, just a reticle
      // you can see well enough to drop a bait on.
      if (entity.role === "anchor") {
        const r = entity.size * 0.55;
        const color = entity.color ?? "#e0b152";
        return (
          <>
            <Circle radius={r} stroke={color} strokeWidth={5} dash={[10, 8]} />
            <Circle radius={r * 0.28} fill={color} />
            <Line points={[-r * 1.5, 0, -r * 0.6, 0]} stroke={color} strokeWidth={5} />
            <Line points={[r * 0.6, 0, r * 1.5, 0]} stroke={color} strokeWidth={5} />
            <Line points={[0, -r * 1.5, 0, -r * 0.6]} stroke={color} strokeWidth={5} />
            <Line points={[0, r * 0.6, 0, r * 1.5]} stroke={color} strokeWidth={5} />
            {entity.name && (
              <EntityName
                text={entity.name}
                y={r * 1.7}
                rotation={entity.rotation}
                width={400}
                fontSize={32}
                color={color}
                strokeWidth={5}
              />
            )}
          </>
        );
      }
      const color = entity.color ?? "#c0392b";
      return (
        <>
          {/* The art is the whole token: stamped as it is, no frame around it. */}
          <Sprite
            src={assetUrl(entity.icon ?? enemyIconKey(entity.size))}
            width={entity.size * 1.15}
            height={entity.size * 1.15}
            fallback={<Circle radius={entity.size * 0.55} fill={color} />}
          />
          {entity.showFacing && (
            <Line
              points={[0, -entity.size * 0.55, 0, -entity.size * 0.55 - 24]}
              stroke="#e6edf3"
              strokeWidth={8}
              lineCap="round"
            />
          )}
          {entity.name && (
            <EntityName
              text={entity.name}
              y={entity.size * 0.62}
              rotation={entity.rotation}
              width={400}
              fontSize={38}
              strokeWidth={5}
            />
          )}
        </>
      );
    }

    case "zone":
      return <ZoneShape zone={entity} blast={blast} />;

    case "text": {
      // Width drives both centring and the hit box, so keep it near the content.
      const boxWidth = Math.max(entity.fontSize * 2, entity.text.length * entity.fontSize * 0.62);
      return (
        <Text
          text={entity.text}
          fontSize={entity.fontSize}
          width={boxWidth}
          offsetX={boxWidth / 2}
          offsetY={entity.fontSize / 2}
          align={entity.align}
          fill={entity.color ?? "#e6edf3"}
          stroke={entity.outline ? "#0d1117" : undefined}
          strokeWidth={entity.outline ? 6 : 0}
          fillAfterStrokeEnabled
        />
      );
    }

    case "path":
      return (
        <Line
          points={entity.points}
          hitStrokeWidth={Math.max(40, entity.width * 3)}
          stroke={entity.color ?? "#e6edf3"}
          strokeWidth={entity.width}
          closed={entity.closed}
          dash={entity.dashed ? [20, 14] : undefined}
          lineCap="round"
          lineJoin="round"
        />
      );

    case "icon":
      return <Sprite src={assetUrl(entity.src)} width={entity.size} height={entity.size} />;

    default:
      return null;
  }
}

/** Keep an entity's identifying label upright while its art turns to face. */
function EntityName({
  text,
  y,
  rotation,
  width,
  fontSize,
  color = "#e6edf3",
  strokeWidth,
}: {
  text: string;
  y: number;
  rotation: number;
  width: number;
  fontSize: number;
  color?: string;
  strokeWidth: number;
}) {
  return (
    <Group name="entity-name" rotation={-rotation} listening={false}>
      <Text
        text={text}
        y={y}
        width={width}
        offsetX={width / 2}
        align="center"
        fontSize={fontSize}
        fill={color}
        stroke="#0d1117"
        strokeWidth={strokeWidth}
        fillAfterStrokeEnabled
        {...NO_BUFFER}
      />
    </Group>
  );
}

/**
 * FFXIV-style telegraph fill: faint at the heart, dense at the rim, so the
 * border reads as the danger edge instead of a flat tint. Falls back to the
 * old flat fill when the color is not a plain hex we can make translucent.
 */
function telegraphFill(
  zone: ZoneEntity,
  radius: number,
  /** 0 normally; 1 at the height of the cast going off, which floods the fill. */
  blast = 0
): Partial<Konva.ShapeConfig> {
  if (zone.hollow) return {};
  const rgba = (alpha: number) => {
    const hex = zone.color ?? ZONE_DEFAULT;
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
    if (!m) return undefined;
    const digits = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    const n = parseInt(digits, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  };
  // Clear at the heart and only really there at the rim, the way the game
  // draws them: two casts on the same floor stay legible, and the tokens
  // standing in one are not swallowed.
  // Going off, the ground it covers fills in: the heart of it stops being a
  // hole you can read a plan through and becomes the hit.
  const core = rgba(0.62 * blast);
  const mid = rgba(0.1 + 0.55 * blast);
  const rim = rgba(0.32 + 0.45 * blast);
  if (!core || !mid || !rim)
    return { fill: zone.color ?? ZONE_DEFAULT, opacity: 0.2 + 0.6 * blast };
  // Konva types the stop list as number[] even though it holds colours.
  const stops = [0, core, 0.75, mid, 1, rim] as unknown as number[];
  return {
    fillRadialGradientStartRadius: 0,
    fillRadialGradientEndRadius: radius,
    fillRadialGradientColorStops: stops,
  };
}

/** The outline of a + with bars `width` thick and `span` end to end, clockwise from the top bar. */
function crossOutline(width: number, span: number): number[] {
  const w = width / 2;
  const s = span / 2;
  return [-w, -s, w, -s, w, -w, s, -w, s, w, w, w, w, s, -w, s, -w, w, -s, w, -s, -w, -w, -w];
}

function ZoneShape({ zone, blast = 0 }: { zone: ZoneEntity; blast?: number }) {
  const color = zone.color ?? ZONE_DEFAULT;
  const border = { stroke: color, strokeWidth: 5, hitStrokeWidth: zone.hollow ? 40 : undefined };

  switch (zone.shape) {
    case "circle":
      return <Circle radius={zone.radius} {...telegraphFill(zone, zone.radius, blast)} {...border} />;

    case "donut":
      return (
        <Ring
          innerRadius={zone.innerRadius}
          outerRadius={zone.radius}
          {...telegraphFill(zone, zone.radius, blast)}
          {...border}
        />
      );

    case "cone":
      // Konva wedges sweep clockwise from +x; rotate so the cone straddles north.
      return (
        <Wedge
          radius={zone.radius}
          angle={zone.angle}
          rotation={-90 - zone.angle / 2}
          {...telegraphFill(zone, zone.radius, blast)}
          {...border}
        />
      );

    case "rect":
    case "line":
      return (
        <Rect
          x={-zone.width / 2}
          y={-zone.length / 2}
          width={zone.width}
          height={zone.length}
          {...telegraphFill(zone, Math.hypot(zone.width, zone.length) / 2, blast)}
          {...border}
        />
      );

    case "cross":
      // One outline, not two overlapping bars: the middle is no hotter than the arms.
      return (
        <Line
          points={crossOutline(zone.width, zone.length)}
          closed
          {...telegraphFill(zone, zone.length / 2, blast)}
          {...border}
        />
      );

    case "knockback":
      return (
        <>
          <Rect
            x={-zone.width / 2}
            y={-zone.length / 2}
            width={zone.width}
            height={zone.length}
            {...telegraphFill(zone, Math.hypot(zone.width, zone.length) / 2, blast)}
            {...border}
          />
          <Stamp
            art="linear-knockback"
            size={stampSize(zone.width)}
            fallback={
              <>
                {[-1, 0, 1].map((i) => (
                  <Arrow
                    key={i}
                    points={[i * zone.width * 0.3, zone.length / 2, i * zone.width * 0.3, -zone.length / 2]}
                    stroke={color}
                    fill={color}
                    strokeWidth={6}
                    pointerLength={22}
                    pointerWidth={20}
                  />
                ))}
              </>
            }
          />
        </>
      );

    case "arrow":
      return (
        <Arrow
          points={[0, zone.length / 2, 0, -zone.length / 2]}
          stroke={color}
          fill={color}
          strokeWidth={zone.width / 4}
          pointerLength={zone.width}
          pointerWidth={zone.width}
          opacity={0.9}
        />
      );

    case "triangle":
      return (
        <RegularPolygon
          sides={3}
          radius={zone.radius}
          {...telegraphFill(zone, zone.radius, blast)}
          {...border}
        />
      );

    case "exaflare":
      return (
        <>
          {Array.from({ length: zone.count }, (_, i) => (
            <Circle
              key={i}
              y={-i * zone.radius * 2.1}
              radius={zone.radius}
              {...telegraphFill(zone, zone.radius, blast)}
              {...border}
              opacity={1 - i / (zone.count + 1)}
            />
          ))}
          <Arrow
            points={[0, zone.radius, 0, -zone.count * zone.radius * 2.1]}
            stroke={color}
            fill={color}
            strokeWidth={5}
            pointerLength={20}
            pointerWidth={18}
            opacity={0.8}
          />
        </>
      );

    case "stack":
      // Always the game's stack marker — the arrows pointing in — with how
      // many it wants written under it. The N-person discs are towers.
      return (
        <>
          <Circle radius={zone.radius} {...telegraphFill(zone, zone.radius, blast)} {...border} />
          <Stamp
            art="stack"
            size={stampSize(zone.radius)}
            fallback={<Circle radius={zone.radius * 0.6} stroke={color} strokeWidth={6} dash={[18, 12]} />}
          />
          <Label
            y={stampSize(zone.radius) * 0.7}
            text={`${zone.soak}`}
            size={stampSize(zone.radius) * 0.35}
            color="#f7fafc"
            bold
          />
        </>
      );

    case "linestack": {
      // The beam, with chevrons marching up it: "line up in here", and how many.
      const w = zone.width;
      const chevrons = Math.max(2, Math.floor(zone.length / (w * 0.9)));
      return (
        <>
          <Rect
            x={-w / 2}
            y={-zone.length / 2}
            width={w}
            height={zone.length}
            {...telegraphFill(zone, zone.length / 2, blast)}
            {...border}
          />
          <Stamp
            art="line-stack"
            size={stampSize(w)}
            fallback={
              <>
                {Array.from({ length: chevrons }, (_, i) => {
                  const y = zone.length / 2 - (i + 0.5) * (zone.length / chevrons);
                  return (
                    <Line
                      key={i}
                      points={[-w * 0.28, y + w * 0.18, 0, y - w * 0.18, w * 0.28, y + w * 0.18]}
                      stroke="#f7fafc"
                      strokeWidth={5}
                      opacity={0.8}
                      lineCap="round"
                      lineJoin="round"
                    />
                  );
                })}
              </>
            }
          />
          <Label
            y={stampSize(w) * 0.75}
            text={`${zone.soak}`}
            size={stampSize(w) * 0.35}
            color="#f7fafc"
            bold
          />
        </>
      );
    }

    case "flare": {
      // A burst: spokes out from the carrier, so it reads as "take this away".
      const spokes = 8;
      return (
        <>
          <Circle radius={zone.radius} {...telegraphFill(zone, zone.radius, blast)} {...border} />
          <Stamp
            art="player-proximity"
            size={stampSize(zone.radius)}
            fallback={
              <>
                {Array.from({ length: spokes }, (_, i) => {
                  const a = (i / spokes) * Math.PI * 2;
                  return (
                    <Line
                      key={i}
                      points={[
                        Math.cos(a) * zone.radius * 0.3,
                        Math.sin(a) * zone.radius * 0.3,
                        Math.cos(a) * zone.radius * 0.92,
                        Math.sin(a) * zone.radius * 0.92,
                      ]}
                      stroke={color}
                      strokeWidth={4}
                      opacity={0.6}
                    />
                  );
                })}
                <Circle radius={zone.radius * 0.18} fill={color} opacity={0.7} />
              </>
            }
          />
        </>
      );
    }

    case "spread":
      return (
        <>
          <Circle
            radius={zone.radius}
            {...telegraphFill(zone, zone.radius, blast)}
            {...border}
            dash={[24, 16]}
          />
          <Stamp
            art="one-person-aoe"
            size={stampSize(zone.radius)}
            fallback={
              <>
                <Line points={[-zone.radius, 0, zone.radius, 0]} stroke={color} strokeWidth={5} />
                <Line points={[0, -zone.radius, 0, zone.radius]} stroke={color} strokeWidth={5} />
              </>
            }
          />
        </>
      );

    case "tower": {
      // The game draws a tower wanting two, three or four with that many discs
      // in it; anything else gets the plain tower and the count underneath.
      const art = { 1: "one-person-aoe", 2: "two-person-aoe", 3: "three-person-aoe", 4: "four-person-aoe" }[
        zone.soak
      ];
      return (
        <>
          <Circle radius={zone.radius} {...telegraphFill(zone, zone.radius, blast)} {...border} />
          <Stamp
            art={art ?? "tower"}
            size={stampSize(zone.radius)}
            fallback={<Circle radius={zone.radius * 0.7} stroke={color} strokeWidth={8} />}
          />
          {!art && (
            <Label
              y={stampSize(zone.radius) * 0.7}
              text={`${zone.soak}`}
              size={stampSize(zone.radius) * 0.35}
              color="#f7fafc"
              bold
            />
          )}
        </>
      );
    }

    case "eye":
      return (
        <>
          <Ellipse
            radiusX={zone.radius}
            radiusY={zone.radius * 0.6}
            {...telegraphFill(zone, zone.radius, blast)}
            {...border}
          />
          <Stamp
            art="gaze"
            size={stampSize(zone.radius)}
            fallback={<Circle radius={zone.radius * 0.28} fill="#0d1117" />}
          />
        </>
      );

    case "meteor":
      return (
        <>
          <Circle radius={zone.radius} {...telegraphFill(zone, zone.radius, blast)} {...border} />
          <Circle radius={zone.radius * 0.45} fill={color} opacity={0.9} />
        </>
      );

    case "proximity":
      return (
        <>
          <Circle
            radius={zone.radius}
            {...telegraphFill(zone, zone.radius, blast)}
            {...border}
            opacity={0.5}
          />
          <Stamp
            art="proximity"
            size={stampSize(zone.radius)}
            fallback={
              <>
                <Circle radius={zone.radius * 0.66} fill={color} opacity={0.3} />
                <Circle radius={zone.radius * 0.33} fill={color} opacity={0.5} />
              </>
            }
          />
        </>
      );

    default:
      return <Circle radius={zone.radius} {...telegraphFill(zone, zone.radius, blast)} {...border} />;
  }
}

function Tether({
  entity,
  byId,
  selected,
  dim,
}: {
  entity: Extract<Entity, { type: "tether" }>;
  byId: Map<string, Entity>;
  selected: boolean;
  dim?: boolean;
}) {
  const ends = tetherEnds(entity, byId);
  if (!ends) return null;
  const { from: a, to: b } = ends;
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const satisfied = entity.range === undefined
    ? undefined
    : entity.style === "close"
      ? distance <= entity.range
      : entity.style === "far"
        ? distance >= entity.range
        : undefined;
  const defaultColor = entity.style === "far" ? "#e05252" : entity.style === "close" ? "#5aa8e0" : "#e0c452";
  // Red/green is the default tether's status language. Once the author picks
  // another colour, that explicit choice is the stronger instruction and must
  // remain stable as the endpoints move in and out of range. Explicitly
  // choosing the style's default colour keeps the useful status feedback.
  const customColor = entity.color && entity.color.toLowerCase() !== defaultColor.toLowerCase()
    ? entity.color
    : undefined;
  const color = customColor ?? (satisfied === true
    ? "#54d68b"
    : satisfied === false
      ? "#f05b67"
      : defaultColor);
  const dash =
    entity.style === "minus" ? [26, 18] : entity.style === "chain" ? [8, 10] : undefined;
  const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  const arrow = Math.max(8, Math.min(16, distance / 14));
  const inward = entity.style === "close";
  const directional = inward || entity.style === "far";
  const showChevrons = directional && distance > arrow * 5;
  // Add a pair at a time as the link grows, keeping the field symmetrical so
  // the movement direction remains unambiguous at any length.
  const chevronCount = showChevrons
    ? Math.max(4, Math.min(12, Math.ceil(distance / 180) * 2))
    : 0;
  const chevronSpacing = arrow * 2.15;
  const chevronLength = arrow * 1.12;
  const chevronHeight = arrow * 0.46;
  const chevrons = Array.from({ length: chevronCount }, (_, i) => {
    const x = distance / 2 + (i - (chevronCount - 1) / 2) * chevronSpacing;
    const left = x < distance / 2;
    return { x, dir: inward ? (left ? 1 : -1) : (left ? -1 : 1) };
  });
  // Directional tethers are read by their chevrons. Cut the quiet guide out
  // around the entire chevron field instead of drawing through the marks.
  const lineWidth = directional ? Math.max(1.5, entity.width * 0.3) : entity.width;
  const chevronWidth = Math.max(2.5, entity.width * 0.4);
  const guideSegments = showChevrons
    ? [
        [0, Math.max(0, chevrons[0].x - arrow * 1.35)],
        [Math.min(distance, chevrons.at(-1)!.x + arrow * 1.35), distance],
      ]
    : [[0, distance]];
  return (
    <Group
      id={entity.id}
      name="entity"
      x={a.x}
      y={a.y}
      rotation={angle}
      opacity={entity.opacity * (dim ? 0.4 : 1)}
    >
      {/* The visual guide has a deliberate central gap, but the full tether
          remains one continuous target for selecting and wheel gestures. */}
      <Shape
        name="tether-hit"
        fill="#000"
        sceneFunc={() => undefined}
        hitFunc={(context, shape) => {
          context.beginPath();
          context.rect(0, -15, distance, 30);
          context.closePath();
          context.fillShape(shape);
        }}
      />
      {guideSegments.map(([from, to], i) => (
        <Line
          key={`guide-${i}`}
          name="tether-guide"
          points={[from, 0, to, 0]}
          stroke={color}
          strokeWidth={selected ? lineWidth * 1.6 : lineWidth}
          dash={dash}
          lineCap="round"
          listening={false}
        />
      ))}
      {showChevrons && (
        <Group listening={false}>
          {chevrons.map((mark, i) => (
            <Line
              key={i}
              name="tether-chevron"
              points={[
                mark.x - mark.dir * chevronLength, -chevronHeight,
                mark.x, 0,
                mark.x - mark.dir * chevronLength, chevronHeight,
              ]}
              stroke={color}
              strokeWidth={chevronWidth}
              lineCap="square"
              lineJoin="miter"
            />
          ))}
        </Group>
      )}
      {(entity.style === "plus" || entity.style === "minus") && (
        <Label
          x={distance / 2}
          y={0}
          text={entity.style === "plus" ? "+" : "−"}
          size={70}
          color={color}
        />
      )}
    </Group>
  );
}

function Label({
  text,
  size,
  color,
  bold,
  x = 0,
  y = 0,
}: {
  text: string;
  size: number;
  color: string;
  bold?: boolean;
  x?: number;
  y?: number;
}) {
  return (
    <Text
      x={x}
      y={y}
      text={text}
      fontSize={size}
      fontStyle={bold ? "bold" : "normal"}
      width={600}
      offsetX={300}
      offsetY={size / 2}
      align="center"
      fill={color}
      listening={false}
    />
  );
}

/**
 * A centred bitmap. Renders `fallback` (the old vector token) until the art
 * loads, or forever if the URL is bad — the canvas never goes blank.
 */
/**
 * A mechanic's in-game marker, stamped on its shape. The art is the thing a
 * raider recognises at a glance, so it sits at token scale in the middle of
 * the footprint rather than stretching to fill it, and is never the grab
 * target. Until it loads, the drawn stand-in does the job.
 */
function Stamp({ art, size, fallback }: { art: string; size: number; fallback?: React.ReactNode }) {
  return (
    <Sprite src={assetUrl(`mechanic/${art}`)} width={size} height={size} listening={false} fallback={fallback} />
  );
}

/** Marker art is token-sized: it grows with a small shape and stops with a big one. */
const stampSize = (extent: number) => Math.min(Math.max(extent * 1.1, 70), 150);

function Sprite({
  src,
  width,
  height,
  opacity,
  listening = true,
  fallback = null,
}: {
  src: string | undefined;
  width: number;
  height: number;
  opacity?: number;
  /** The token art *is* the grab target, so this defaults to true. */
  listening?: boolean;
  fallback?: React.ReactNode;
}) {
  const image = useImage(src);
  if (!image) return <>{fallback}</>;
  return (
    <KonvaImage
      image={image}
      width={width}
      height={height}
      offsetX={width / 2}
      offsetY={height / 2}
      opacity={opacity}
      listening={listening}
    />
  );
}

/** Tiny local image loader, so the canvas needs no extra dependency. */
function useImage(src: string | undefined) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) return;
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.src = src;
    img.onload = () => setImage(img);
    return () => {
      img.onload = null;
    };
  }, [src]);
  return image;
}
