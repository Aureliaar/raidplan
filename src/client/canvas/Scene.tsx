import {
  Fragment,
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
import { authoredEntitiesForStep, entitiesForStep } from "../../shared/schema";
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
  /** Intercept a click before normal selection/dragging, for two-click authoring tools. */
  onPick?(id: string): boolean;
  onSelect(ids: string[]): void;
  onMove(moves: { id: string; x: number; y: number }[]): void;
  /** Wheel over something: resize it (or a tether's range) by that factor. */
  onResize?(id: string, factor: number, what: "size" | "opacity"): void;
}

/** How long the floor takes to walk into the next step, and its easing. */
const GLIDE_MS = 260;
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
): { entities: Entity[]; going: Set<string>; blast: Map<string, number> } {
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
    return { entities: target, going, blast };
  }

  const k = ease(p);
  // A shape that is in both steps slides and, if it is drawn fainter in one of
  // them, fades as it goes. One that is only in the step being walked into
  // comes up out of nothing.
  const moving = target.map((e) => {
    const was = from.current.get(e.id);
    if (!was) return { ...e, opacity: e.opacity * k };
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
  return { entities, going, blast };
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
  highlight,
  dress,
  glide = 0,
  onward = true,
  onPick,
  onSelect,
  onMove,
  onResize,
}: SceneProps) {
  const { arena } = plan;
  const scale = size / Math.max(arena.width, arena.height);

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
  const { entities, going, blast } = useGlide(settled, glide, onward);
  const byId = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);

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
    const authoredScene = authoredEntitiesForStep(plan, stepId, variant);
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

  function beginGroupDrag(id: string, picked: Set<string> = selectedIds) {
    const source = committed.find((e) => e.id === id);
    if (!source) return;
    const members = new Map<string, { x: number; y: number; shownX: number; shownY: number }>();
    for (const e of committed) {
      if (!picked.has(e.id) || frozen(e) || e.locked || e.type === "tether") continue;
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

  function moveGroup(id: string, at: { x: number; y: number }) {
    const start = dragStart.current;
    if (!start || start.source !== id) return null;
    const dx = at.x - start.sourceAt.x;
    const dy = at.y - start.sourceAt.y;
    if (Math.hypot(dx, dy) > 0.5) start.moved = true;
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
      setDragging(live);
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
    setDragging(live);
    return live;
  }

  /**
   * Konva would hand us the topmost shape, which means a big AoE drawn over the
   * party makes the party unclickable. Pick whichever candidate under the pointer
   * covers the least ground instead — the one you had to aim at is the one you
   * meant — and start its drag by hand, so draw order stays purely visual.
   */
  function under(
    evt: Konva.KonvaEventObject<MouseEvent | TouchEvent | WheelEvent>,
    /** The wheel resizes a bonded set through any of its faces; a click cannot. */
    include: (e: Entity) => boolean = (e) => !frozen(e)
  ) {
    const stage = evt.target.getStage();
    const point = stage?.getPointerPosition();
    if (!stage || !point) return undefined;

    const hits = stage.getAllIntersections(point);
    const arenaAt = { x: (point.x - size / 2) / scale, y: (point.y - size / 2) / scale };
    let best: { node: Konva.Group; id: string } | undefined;
    let bestSize = Infinity;
    for (const shape of hits) {
      const group = shape.findAncestor(".entity", true) as Konva.Group | undefined;
      const id = group?.id();
      if (!group || !id) continue;
      // A short tether covers less ground than the tokens it joins, which made
      // the token at either end unclickable — you would grab the tether instead,
      // and tethers do not drag, so the token simply stopped responding. A
      // tether is grabbed along its length, not on the people it connects.
      const entity = byId.get(id);
      if (entity && !include(entity)) continue;
      if (entity?.type === "tether" && onTetherEnd(entity, arenaAt, byId)) continue;
      const footprint = footprints.get(id) ?? Infinity;
      if (footprint < bestSize) {
        best = { node: group, id };
        bestSize = footprint;
      }
    }
    return best;
  }

  function pickAt(evt: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    const best = under(evt);
    const additive = "shiftKey" in evt.evt && evt.evt.shiftKey;
    if (!best) {
      const point = evt.target.getStage()?.getPointerPosition();
      if (editable && point && evt.evt instanceof MouseEvent && evt.evt.button === 0) {
        setMarquee({ from: point, to: point, additive });
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
    if (editable && entity && !entity.locked && entity.type !== "tether") {
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

  function dragSelection(evt: Konva.KonvaEventObject<MouseEvent>) {
    if (!marquee) return;
    const point = evt.target.getStage()?.getPointerPosition();
    if (point) setMarquee({ ...marquee, to: point });
  }

  function finishSelection(evt: Konva.KonvaEventObject<MouseEvent>) {
    if (!marquee) return;
    const point = evt.target.getStage()?.getPointerPosition() ?? marquee.to;
    const left = Math.min(marquee.from.x, point.x);
    const top = Math.min(marquee.from.y, point.y);
    const box = { x: left, y: top, width: Math.abs(point.x - marquee.from.x), height: Math.abs(point.y - marquee.from.y) };
    const hits = entities
      .filter((e) => !frozen(e))
      .filter((e) => {
        const node = evt.target.getStage()?.findOne(`#${e.id}`);
        if (!node) return false;
        const r = node.getClientRect();
        return r.x <= box.x + box.width && r.x + r.width >= box.x && r.y <= box.y + box.height && r.y + r.height >= box.y;
      })
      .map((e) => e.id);
    onSelect(marquee.additive ? [...new Set([...selected, ...hits])] : hits);
    setMarquee(null);
  }

  /**
   * The wheel sizes whatever is under the pointer, without selecting it first —
   * one gesture, no mode. For a tether that means its required range, not its
   * visual stroke. A bonded shape updates its whole set, because the set is the
   * thing you are pointing at.
   */
  function wheelAt(evt: Konva.KonvaEventObject<WheelEvent>) {
    if (!editable || !onResize) return;
    const hit = under(evt, (e) => !frozen(e) || !!e.bond);
    if (!hit) return;
    evt.evt.preventDefault();
    const step = evt.evt.shiftKey ? 1.02 : 1.08;
    // Plain wheel is size; with ctrl held it is how solid the thing is drawn.
    onResize(hit.id, evt.evt.deltaY < 0 ? step : 1 / step, evt.evt.ctrlKey ? "opacity" : "size");
  }

  return (
    <Stage
      width={size}
      height={size}
      onMouseDown={pickAt}
      onTouchStart={pickAt}
      onMouseMove={dragSelection}
      onMouseUp={finishSelection}
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
                onDragMove={(ev) => moveGroup(e.id, poseOf(e.id, ev.target))}
                onDragEnd={(ev) => {
                  const pose = poseOf(e.id, ev.target);
                  if (!dragStart.current?.moved) {
                    dragStart.current = null;
                    setDragging(null);
                    return;
                  }
                  // Held until the new revision arrives, so the shape does not
                  // snap back to its old pose for the length of a round trip.
                  const final = moveGroup(e.id, pose) ?? new Map([[e.id, pose]]);
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
                {(selectedIds.has(e.id) ||
                  (!!highlight && (e.bond?.id === highlight || e.mech === highlight))) && (
                  <SelectionRing entity={e} />
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
              <SelectionRing entity={e} />
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
          {selectedIds.size > 1 && (
            <TransformAxis
              kind={symmetryKind}
              count={symmetryCount}
              pivot={selectionPivot}
              entities={entities.filter((e) => selectedIds.has(e.id))}
            />
          )}
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

function SelectionRing({ entity }: { entity: Entity }) {
  const r = radiusHint(entity) + 14;
  return (
    <Circle
      name="selection"
      radius={r}
      stroke="#7aa2f7"
      strokeWidth={4}
      dash={[12, 8]}
      listening={false}
    />
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
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) return Infinity;
      return Math.hypot(b.x - a.x, b.y - a.y) * TETHER_HIT_WIDTH;
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
      return e.shape === "rect" || e.shape === "line" || e.shape === "knockback" || e.shape === "arrow"
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
              <Circle radius={r} fill={color} opacity={0.35} stroke={color} strokeWidth={4} />
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
                <Circle radius={r} fill={color} stroke="#0d1117" strokeWidth={3} />
                <Label text={jobLabel(entity.job)} size={entity.size * 0.38} color="#0d1117" bold />
              </>
            }
          />
          {/*
            The hitbox. A player in FFXIV is a point, so the token art around it
            is decoration: this pip is the thing an AoE either covers or does
            not, and without it a beam that clips the art reads as a hit.
          */}
          <Circle radius={5} fill="#f7fafc" stroke="#0d1117" strokeWidth={2} listening={false} />
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
          {/* The status this token carries, riding the shoulder. FFXIV status
              icons are taller than wide; keeping the ratio is what makes the
              art recognisable at token size. */}
          {dress?.debuff?.icon && (
            <Group x={r * 0.78} y={-r * 0.72} listening={false}>
              <Sprite src={dress.debuff.icon} width={entity.size * 0.5} height={entity.size * 0.66} />
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
          {entity.ring && <Circle radius={entity.size} stroke={color} strokeWidth={3} dash={[14, 10]} opacity={0.7} />}
          {/* The enemy art is a square tile; clip it to the hitbox circle. */}
          <Group
            clipFunc={(ctx: Konva.Context) => {
              ctx.arc(0, 0, entity.size * 0.55, 0, Math.PI * 2, false);
            }}
          >
            <Sprite
              src={assetUrl(entity.icon ?? enemyIconKey(entity.size))}
              width={entity.size * 1.15}
              height={entity.size * 1.15}
              fallback={<Circle radius={entity.size * 0.55} fill={color} />}
            />
          </Group>
          <Circle radius={entity.size * 0.55} stroke="#0d1117" strokeWidth={5} listening={false} />
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
              y={entity.size * (entity.ring ? 1.05 : 0.62)}
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
  const a = byId.get(entity.from);
  const b = byId.get(entity.to);
  if (!a || !b) return null;
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  const satisfied = entity.range === undefined
    ? undefined
    : entity.style === "close"
      ? distance <= entity.range
      : entity.style === "far"
        ? distance >= entity.range
        : undefined;
  // Direction says what to do; colour says whether the current positions do it.
  const color = satisfied === true
    ? "#54d68b"
    : satisfied === false
      ? "#f05b67"
      : entity.color ?? (entity.style === "far" ? "#e05252" : entity.style === "close" ? "#5aa8e0" : "#e0c452");
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
