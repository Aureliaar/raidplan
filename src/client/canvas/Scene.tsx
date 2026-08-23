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
  Stage,
  Text,
  Wedge,
} from "react-konva";
import type Konva from "konva";
import type { Entity, Plan, ZoneEntity } from "../../shared/schema";
import { entitiesForStep, resolveEntity } from "../../shared/schema";
import { jobColor, jobLabel } from "../../shared/jobs";
import { assetUrl, enemyIconKey, jobIconKey, waymarkIconKey } from "../../shared/assets";

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
  stepId?: string;
  /** Which reading of each mechanic is being played, by mechanic id. */
  shown?: Record<string, string>;
  size: number;
  selected: string | null;
  editable: boolean;
  layer?: EditLayer;
  /** A bond or mech id whose shapes should light up — the row being hovered. */
  highlight?: string | null;
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
  onSelect(id: string | null): void;
  onMove(id: string, x: number, y: number): void;
  /** Wheel over something: resize it by that factor. Absent, the wheel does nothing. */
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
  stepId,
  shown,
  size,
  selected,
  editable,
  layer = "step",
  highlight,
  glide = 0,
  onward = true,
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
  const [dragging, setDragging] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => setDragging(null), [plan.rev]);

  /**
   * Off-layer things are there for reference only: no clicks, no drags. A bonded
   * shape is off-layer too, always: it is one face of a set that lives with its
   * group, so grabbing the face would be grabbing the wrong thing.
   */
  /** The other layer's things: still drawn, but faded to say "not now". */
  const offLayer = (e: Entity) => (layer === "markers" ? e.type !== "marker" : e.type === "marker");
  const frozen = (e: Entity) => offLayer(e) || !!e.bond || going.has(e.id);

  const committed = useMemo(() => entitiesForStep(plan, stepId, undefined, shown), [plan, stepId, shown]);
  const settled = useMemo(() => {
    const live = dragging ? new Map([[dragging.id, { x: dragging.x, y: dragging.y }]]) : undefined;
    const sorted = sortForDrawing(live ? entitiesForStep(plan, stepId, live, shown) : committed);
    // On the waymark layer the marks come to the top: they normally lie on the
    // floor under the party, which is right for reading a plan and useless for
    // dropping an A on the exact tile you mean.
    return layer === "markers"
      ? [...sorted].sort((a, b) => Number(a.type === "marker") - Number(b.type === "marker"))
      : sorted;
  }, [plan, stepId, committed, dragging, layer]);
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
    for (const e of committed) {
      if (!e.anchor) continue;
      const authored = plan.entities.find((b) => b.id === e.id);
      if (!authored) continue;
      const nudge = resolveEntity(authored, stepId, stepId ? shown?.[plan.steps.find((s) => s.id === stepId)?.mechanic ?? ""] : undefined);
      m.set(e.id, { x: e.x - nudge.x, y: e.y - nudge.y });
    }
    return m;
  }, [committed, plan, stepId]);

  /** A node's live position as the entity would store it: an offset, if anchored. */
  const poseOf = (id: string, node: { x(): number; y(): number }) => {
    const base = anchorBase.get(id);
    return { x: node.x() - (base?.x ?? 0), y: node.y() - (base?.y ?? 0) };
  };

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
    if (!best) {
      onSelect(null);
      return;
    }
    onSelect(best.id);
    const entity = entities.find((e) => e.id === best!.id);
    // A tether is two endpoints and nothing else, so there is nothing to drag.
    // A bait can be dragged: the drop lands as an offset from its anchor.
    if (editable && entity && !entity.locked && entity.type !== "tether") {
      const node = best.node;
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
   * The wheel sizes whatever is under the pointer, without selecting it first —
   * one gesture, no mode. A bonded shape resizes its whole set, because the set
   * is the thing you are pointing at.
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
      onWheel={wheelAt}
    >
      <Layer>
        <Group x={size / 2} y={size / 2} scaleX={scale} scaleY={scale}>
          <ArenaFloor plan={plan} />
          {entities.map((e) =>
            e.type === "tether" ? (
              <Tether key={e.id} entity={e} byId={byId} selected={selected === e.id} dim={offLayer(e)} />
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
                onDragMove={(ev) => setDragging({ id: e.id, ...poseOf(e.id, ev.target) })}
                onDragEnd={(ev) => {
                  const pose = poseOf(e.id, ev.target);
                  // Held until the new revision arrives, so the shape does not
                  // snap back to its old pose for the length of a round trip.
                  setDragging({ id: e.id, ...pose });
                  onMove(e.id, Math.round(pose.x), Math.round(pose.y));
                }}
              >
                <GrabTarget entity={e} />
                <EntityShape entity={e} blast={blast.get(e.id) ?? 0} />
                {(selected === e.id ||
                  (!!highlight && (e.bond?.id === highlight || e.mech === highlight))) && (
                  <SelectionRing entity={e} />
                )}
              </Group>
            )
          )}
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
        </Group>
      </Layer>
    </Stage>
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
  return <Circle radius={r} stroke="#7aa2f7" strokeWidth={4} dash={[12, 8]} listening={false} />;
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

function EntityShape({ entity, blast = 0 }: { entity: Entity; blast?: number }) {
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
      const icon = assetUrl(entity.icon ?? jobIconKey(entity.job, entity.name));
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
          {entity.name && (
            <Text
              text={entity.name}
              y={r + 4}
              width={200}
              offsetX={100}
              align="center"
              fontSize={entity.size * 0.36}
              listening={false}
              fill="#e6edf3"
              stroke="#0d1117"
              strokeWidth={4}
              fillAfterStrokeEnabled
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
              <Text
                text={entity.name}
                y={r * 1.7}
                width={400}
                offsetX={200}
                align="center"
                fontSize={32}
                listening={false}
                fill={color}
                stroke="#0d1117"
                strokeWidth={5}
                fillAfterStrokeEnabled
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
            <Text
              text={entity.name}
              y={entity.size * (entity.ring ? 1.05 : 0.62)}
              width={400}
              offsetX={200}
              align="center"
              fontSize={38}
              listening={false}
              fill="#e6edf3"
              stroke="#0d1117"
              strokeWidth={5}
              fillAfterStrokeEnabled
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
  const color = entity.color ?? (entity.style === "far" ? "#e05252" : entity.style === "close" ? "#5aa8e0" : "#e0c452");
  const dash =
    entity.style === "minus" ? [26, 18] : entity.style === "chain" ? [8, 10] : undefined;
  return (
    <Fragment>
      <Line
        id={entity.id}
        name="entity"
        points={[a.x, a.y, b.x, b.y]}
        stroke={color}
        strokeWidth={selected ? entity.width * 1.6 : entity.width}
        dash={dash}
        opacity={entity.opacity * (dim ? 0.4 : 1)}
        lineCap="round"
        hitStrokeWidth={30}
      />
      {(entity.style === "plus" || entity.style === "minus") && (
        <Label
          x={(a.x + b.x) / 2}
          y={(a.y + b.y) / 2}
          text={entity.style === "plus" ? "+" : "−"}
          size={70}
          color={color}
        />
      )}
    </Fragment>
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
