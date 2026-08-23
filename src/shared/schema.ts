import { z } from "zod";

/**
 * The plan document.
 *
 * Coordinate system: arena-local units, origin at the arena centre,
 * +x = east (right), +y = south (down). `rotation` is in degrees, 0 = north,
 * increasing clockwise — so a cone at rotation 90 points east.
 *
 * The arena is `arena.width` x `arena.height` units across; everything scales
 * to whatever pixel size the canvas happens to be.
 */

export const ARENA_SHAPES = ["circle", "square", "rect"] as const;
export const GRID_TYPES = ["none", "square", "radial", "cross"] as const;

export const ArenaSchema = z.object({
  shape: z.enum(ARENA_SHAPES).default("square"),
  width: z.number().positive().default(1000),
  height: z.number().positive().default(1000),
  color: z.string().default("#252a33"),
  border: z.string().default("#4a525f"),
  /** Backdrop: an asset key ("arena/p12_octagon"), absolute URL or /path. */
  image: z.string().optional(),
  /** Backdrop opacity. */
  imageOpacity: z.number().min(0).max(1).default(1),
  grid: z
    .object({
      type: z.enum(GRID_TYPES).default("none"),
      rows: z.number().int().min(1).max(32).default(4),
      cols: z.number().int().min(1).max(32).default(4),
      rings: z.number().int().min(1).max(12).default(2),
      spokes: z.number().int().min(1).max(32).default(8),
      angle: z.number().default(0),
      color: z.string().default("#4a525f"),
    })
    .prefault({}),
});
export type Arena = z.infer<typeof ArenaSchema>;

export const ZONE_SHAPES = [
  "circle",
  "donut",
  "cone",
  "rect",
  "line",
  "arrow",
  "triangle",
  "exaflare",
  "knockback",
  "stack",
  "spread",
  "tower",
  "eye",
  "meteor",
  "proximity",
] as const;
export type ZoneShape = (typeof ZONE_SHAPES)[number];

export const TETHER_STYLES = [
  "line",
  "close",
  "far",
  "plus",
  "minus",
  "chain",
] as const;
export const MARKER_IDS = ["A", "B", "C", "D", "1", "2", "3", "4"] as const;
export type MarkerId = (typeof MARKER_IDS)[number];

/**
 * A loose bag of entity properties: per-step overrides and patch payloads.
 * Deliberately `any`-valued — these cross Durable Object RPC, which rejects
 * `unknown`, and every write is re-validated against the entity schema anyway.
 */
// biome-ignore lint/suspicious/noExplicitAny: JSON prop bag crossing the RPC boundary
export type PropBag = Record<string, any>;

/** Per-step property overrides. Validated loosely, re-checked when resolved. */
const OverridesSchema = z
  .record(z.string(), z.record(z.string(), z.any()))
  .default({});

/**
 * Bind an entity to the people it belongs to, so the plan stays true when the
 * party moves. A baited AoE authored with `anchor` has no fixed pose: it is
 * recomputed from its target every time the plan is drawn, in every step.
 *
 * - `to` alone: the entity sits on the target (its own x/y becomes an offset).
 * - `to` + `from`: the entity is *aimed* — it starts at `from`, points at `to`,
 *   and takes its facing from that line. The classic boss-to-bait beam.
 */
export const BAIT_RULES = ["closest", "farthest"] as const;
export type BaitRule = (typeof BAIT_RULES)[number];

export const AnchorSchema = z.object({
  /**
   * Who gets hit. Either a fixed entity id, or — the point of an autobait —
   * left empty with a `pick` rule, so the game's own targeting is modelled:
   * whoever is nearest when the cast goes off is who eats it.
   */
  to: z.string().default(""),
  /** Resolve the target by proximity instead of naming it. */
  pick: z.enum(BAIT_RULES).optional(),
  /** 1 = the closest, 2 = the second closest… so N baits cover N players. */
  rank: z.number().int().min(1).max(8).default(1),
  /** Which entities are eligible. Players, by default. */
  of: z.enum(["player", "enemy", "any"]).default("player"),
  /** Optional origin. With it the shape aims from `from` through the target. */
  from: z.string().optional(),
  /**
   * Rank candidates by their distance from this entity, without aiming at it.
   * A desolation baited off an orb lands *on* the nearest player to the orb —
   * `from` would put it on the orb instead, because `from` means "aimed".
   */
  near: z.string().optional(),
  /** Aimed shapes: stretch past the target to the arena wall. */
  extend: z.boolean().default(false),
  /** Follow the target's facing too (cones stapled to a player). */
  face: z.boolean().default(false),
});
export type EntityAnchor = z.infer<typeof AnchorSchema>;

const BaseEntity = {
  id: z.string(),
  name: z.string().optional(),
  notes: z.string().optional(),
  x: z.number().default(0),
  y: z.number().default(0),
  rotation: z.number().default(0),
  scale: z.number().positive().default(1),
  opacity: z.number().min(0).max(1).default(1),
  color: z.string().optional(),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
  /** Bind this entity to another one instead of a fixed pose. `null` unbinds. */
  anchor: AnchorSchema.nullish(),
  /**
   * Part of a set dropped on a group — eight proteans that are really one
   * mechanic. The set owns them: on the canvas they are drawn and nothing else,
   * and you handle them through the group they came from.
   */
  bond: z
    .object({
      /** Which drop they came from — one set of many a group may hold. */
      id: z.string(),
      /** The group that owns them, e.g. "party". */
      group: z.string(),
      /** What was dropped, for the group to label its sets with. */
      label: z.string().optional(),
    })
    .nullish(),
  /** `"all"` or the list of step ids this entity exists in. */
  steps: z.union([z.literal("all"), z.array(z.string())]).default("all"),
  /**
   * The mech slot this belongs to. A mech owns its shapes' timing: they exist
   * from the step it snapshots in to the step it goes off in, and nowhere else,
   * so `steps` is not consulted for them.
   */
  mech: z.string().optional(),
  /**
   * The step this was authored in. A binding is solved against *that* step's
   * poses: eight donuts dropped on the party in step 1 mark where the party
   * stood in step 1, and stay there while step 2 shows everyone running out.
   * Absent — anything from before this existed, or authored plan-wide — a
   * binding follows its target step by step instead.
   */
  declaredIn: z.string().optional(),
  overrides: OverridesSchema,
};

export const MarkerEntitySchema = z.object({
  ...BaseEntity,
  type: z.literal("marker"),
  marker: z.enum(MARKER_IDS),
  size: z.number().positive().default(90),
});

export const PlayerEntitySchema = z.object({
  ...BaseEntity,
  type: z.literal("player"),
  /** Job id (WAR), role (tank) or party slot (MT). */
  job: z.string().default("any"),
  /** Override the art picked from `job` — an asset key or image URL. */
  icon: z.string().optional(),
  size: z.number().positive().default(72),
  /** Draw a facing pip so "face north" plans read at a glance. */
  showFacing: z.boolean().default(false),
});

export const EnemyEntitySchema = z.object({
  ...BaseEntity,
  type: z.literal("enemy"),
  /** Override the art picked from `size` — an asset key or image URL. */
  icon: z.string().optional(),
  size: z.number().positive().default(120),
  /** Draw the aggro/hitbox ring. */
  ring: z.boolean().default(true),
  showFacing: z.boolean().default(true),
  /**
   * An anchor is not a creature: it is a bare point a mechanic is baited from,
   * drawn as a target reticle. Drop a bait on one and the bait fires off it.
   */
  role: z.enum(["enemy", "anchor"]).default("enemy"),
});

export const ZoneEntitySchema = z.object({
  ...BaseEntity,
  type: z.literal("zone"),
  shape: z.enum(ZONE_SHAPES),
  /** circle / donut / proximity / stack / spread / tower outer radius. */
  radius: z.number().positive().default(150),
  /** donut hole radius. */
  innerRadius: z.number().min(0).default(75),
  /** cone width in degrees. */
  angle: z.number().min(1).max(360).default(90),
  /** rect / line / arrow / knockback footprint. */
  width: z.number().positive().default(150),
  length: z.number().positive().default(400),
  /** exaflare / stack marker count. */
  count: z.number().int().min(1).max(32).default(4),
  /** Number of players a stack wants, or tower soak count. */
  soak: z.number().int().min(1).max(8).default(2),
  hollow: z.boolean().default(false),
});

export const TetherEntitySchema = z.object({
  ...BaseEntity,
  type: z.literal("tether"),
  /** Entity ids. Falls back to the entity's own x/y if an endpoint is missing. */
  from: z.string(),
  to: z.string(),
  style: z.enum(TETHER_STYLES).default("line"),
  width: z.number().positive().default(8),
});

export const TextEntitySchema = z.object({
  ...BaseEntity,
  type: z.literal("text"),
  text: z.string().default("text"),
  fontSize: z.number().positive().default(48),
  align: z.enum(["left", "center", "right"]).default("center"),
  outline: z.boolean().default(true),
});

export const PathEntitySchema = z.object({
  ...BaseEntity,
  type: z.literal("path"),
  /** Flat [x0,y0,x1,y1,...] relative to the entity origin. */
  points: z.array(z.number()).default([]),
  width: z.number().positive().default(8),
  closed: z.boolean().default(false),
  arrow: z.boolean().default(false),
  dashed: z.boolean().default(false),
});

export const IconEntitySchema = z.object({
  ...BaseEntity,
  type: z.literal("icon"),
  /** Absolute image URL. */
  src: z.string(),
  size: z.number().positive().default(80),
});

export const EntitySchema = z.discriminatedUnion("type", [
  MarkerEntitySchema,
  PlayerEntitySchema,
  EnemyEntitySchema,
  ZoneEntitySchema,
  TetherEntitySchema,
  TextEntitySchema,
  PathEntitySchema,
  IconEntitySchema,
]);

export type Entity = z.infer<typeof EntitySchema>;
export type EntityType = Entity["type"];
export type MarkerEntity = z.infer<typeof MarkerEntitySchema>;
export type PlayerEntity = z.infer<typeof PlayerEntitySchema>;
export type EnemyEntity = z.infer<typeof EnemyEntitySchema>;
export type ZoneEntity = z.infer<typeof ZoneEntitySchema>;
export type TetherEntity = z.infer<typeof TetherEntitySchema>;
export type TextEntity = z.infer<typeof TextEntitySchema>;
export type PathEntity = z.infer<typeof PathEntitySchema>;
export type IconEntity = z.infer<typeof IconEntitySchema>;

export const ENTITY_TYPES: EntityType[] = [
  "marker",
  "player",
  "enemy",
  "zone",
  "tether",
  "text",
  "path",
  "icon",
];

export const StepSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  notes: z.string().default(""),
});
export type Step = z.infer<typeof StepSchema>;

/**
 * A mechanic, as a slot in the plan's timeline.
 *
 * A cast is three moments — it appears, it snapshots, it goes off — and a plan
 * is written from the last two: "snapshot here", "explodes there". The shapes
 * that belong to the mech are visible for exactly that span, and they are aimed
 * at the snapshot: where people stood when the game took the picture. Whether
 * they then walk out of it is the whole content of the following steps.
 */
export const MechSchema = z.object({
  id: z.string(),
  /** Empty means "call it after the first thing in it" — see `mechLabel`. */
  name: z.string().default(""),
  /** The step it snapshots in. Its shapes appear here and are aimed here. */
  snap: z.string().default(""),
  /** The step it resolves in. Same as `snap` for anything instant. */
  boom: z.string().default(""),
});
export type Mech = z.infer<typeof MechSchema>;

export const PlanSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string(),
  name: z.string().default("Untitled plan"),
  description: z.string().default(""),
  encounter: z.string().default(""),
  arena: ArenaSchema.prefault({}),
  steps: z.array(StepSchema).default([]),
  /** The mechanics of the fight, each spanning a run of steps. */
  mechs: z.array(MechSchema).default([]),
  /** Draw order: later entities render on top. */
  entities: z.array(EntitySchema).default([]),
  ownerId: z.string().default(""),
  createdAt: z.number().default(0),
  updatedAt: z.number().default(0),
  /** Monotonic edit counter — bumped on every mutation. */
  rev: z.number().int().default(0),
});
export type Plan = z.infer<typeof PlanSchema>;

/**
 * The floor of an encounter: its arena and where that group decided the
 * waymarks go. Saved once per encounter and applied to every plan for it, so
 * "A is north-ish, D is the west platform" holds across all your mechs.
 */
export const EncounterSetupSchema = z.object({
  arena: ArenaSchema.prefault({}),
  markers: z
    .array(
      z.object({
        marker: z.enum(MARKER_IDS),
        x: z.number(),
        y: z.number(),
        size: z.number().positive().optional(),
      }),
    )
    .default([]),
});
export type EncounterSetup = z.infer<typeof EncounterSetupSchema>;

/** A saved encounter as it appears in listings. */
export interface EncounterSummary {
  encounter: string;
  markers: number;
  updatedAt: number;
}

/** A plan as it appears in listings. */
export interface PlanSummary {
  id: string;
  name: string;
  encounter: string;
  ownerId: string;
  updatedAt: number;
  role: PlanRole;
}

export const PLAN_ROLES = ["owner", "editor", "viewer"] as const;
export type PlanRole = (typeof PLAN_ROLES)[number];

export interface User {
  id: string;
  /** "discord:<snowflake>" or "local:<name>" */
  provider: string;
  name: string;
  avatar?: string;
  createdAt: number;
  /** Global capability flags; `chat` gates the model-chat panel. */
  admin: boolean;
  chat: boolean;
}

/**
 * A stored plan as this build understands it.
 *
 * Documents outlive the code that wrote them: one saved before `mechs` existed
 * comes back without the field, and everything that reads it would sooner throw
 * than notice. Cheap, and applied wherever a plan arrives from storage or a
 * socket rather than from an op.
 */
export function hydratePlan(plan: Plan): Plan {
  return plan.mechs ? plan : { ...plan, mechs: [] };
}

/**
 * Resolve an entity's properties for a given step: base props with that
 * step's overrides merged on top.
 */
export function resolveEntity<T extends Entity>(
  entity: T,
  stepId: string | undefined,
): T {
  const ov = stepId ? entity.overrides?.[stepId] : undefined;
  if (!ov || Object.keys(ov).length === 0) return entity;
  return { ...entity, ...(ov as Partial<T>) };
}

/**
 * The steps a mech is on screen for: snapshot to explosion, inclusive.
 *
 * Read off the step order rather than stored, so reordering steps re-times the
 * mech instead of leaving it pointing at a gap. A half-declared mech — only one
 * end named — lasts exactly that one step.
 */
export function mechSpan(plan: Plan, mech: Mech): string[] {
  const index = (id: string) => plan.steps.findIndex((s) => s.id === id);
  const a = index(mech.snap);
  const b = index(mech.boom);
  if (a < 0 && b < 0) return [];
  const lo = a < 0 ? b : b < 0 ? a : Math.min(a, b);
  const hi = a < 0 ? b : b < 0 ? a : Math.max(a, b);
  return plan.steps.slice(lo, hi + 1).map((s) => s.id);
}

/** What a mech is called: its own name, or the first thing dropped into it. */
export function mechLabel(plan: Plan, mech: Mech): string {
  if (mech.name) return mech.name;
  const first = plan.entities.find((e) => e.mech === mech.id);
  return first?.bond?.label ?? first?.name ?? "Mech";
}

/** Does this entity exist in the given step? */
export function entityInStep(
  entity: Entity,
  stepId: string | undefined,
  plan?: Plan,
): boolean {
  if (!stepId) return true;
  // Waymarks are placed before the pull and are the same all fight: they belong
  // to the plan, not to one step, so step membership does not apply to them.
  if (entity.type === "marker") return true;
  // A mech times its own shapes: they run from its snapshot to its explosion.
  const mech = entity.mech
    ? plan?.mechs?.find((m) => m.id === entity.mech)
    : undefined;
  if (mech) return mechSpan(plan!, mech).includes(stepId);
  if (entity.steps === "all") return true;
  return entity.steps.includes(stepId);
}

/**
 * How far the wall is from (ox, oy) along the unit vector (ux, uy).
 * Used by `extend`: a bait beam should reach the edge of *this* arena, whatever
 * shape it is, instead of carrying a length someone guessed once.
 */
function rayToWall(
  arena: Arena,
  ox: number,
  oy: number,
  ux: number,
  uy: number,
): number {
  if (arena.shape === "circle") {
    const r = arena.width / 2;
    const b = ox * ux + oy * uy;
    const c = ox * ox + oy * oy - r * r;
    const disc = b * b - c;
    return disc <= 0 ? r : -b + Math.sqrt(disc);
  }
  const tx =
    ux === 0 ? Infinity : (Math.sign(ux) * (arena.width / 2) - ox) / ux;
  const ty =
    uy === 0 ? Infinity : (Math.sign(uy) * (arena.height / 2) - oy) / uy;
  return Math.max(0, Math.min(tx, ty));
}

/** Shapes whose footprint runs along `length` from the entity's centre. */
const LENGTHWISE = new Set(["rect", "line", "knockback", "arrow"]);

/**
 * Who an anchored entity is currently pointed at.
 *
 * A `pick` rule is re-run against whoever is standing there now, which is the
 * whole point: the plan says "the beam goes to the nearest player", not "the
 * beam goes to Steve", so it stays true when you rearrange the party.
 */
export function anchorTarget(
  entity: Entity,
  byId: Map<string, Entity>,
): Entity | undefined {
  const a = entity.anchor;
  if (!a) return undefined;
  if (!a.pick) return a.to ? byId.get(a.to) : undefined;

  const fromId = a.from ?? a.near;
  const origin = fromId ? byId.get(fromId) : undefined;
  const ox = origin?.x ?? entity.x;
  const oy = origin?.y ?? entity.y;
  const candidates = [...byId.values()].filter(
    (e) =>
      e.id !== entity.id &&
      e.id !== fromId &&
      (a.of === "any"
        ? e.type === "player" || e.type === "enemy"
        : e.type === a.of),
  );
  // Ties are broken by id so the same party always yields the same assignment,
  // instead of two baits swapping places between renders.
  candidates.sort((p, q) => {
    const dp = Math.hypot(p.x - ox, p.y - oy);
    const dq = Math.hypot(q.x - ox, q.y - oy);
    return Math.abs(dp - dq) > 1e-9
      ? a.pick === "farthest"
        ? dq - dp
        : dp - dq
      : p.id < q.id
        ? -1
        : 1;
  });
  return candidates[a.rank - 1];
}

/**
 * The pose an anchored entity actually has right now, or `null` if the thing it
 * is bound to isn't in this step (in which case the bait doesn't happen here).
 */
export function anchoredPose(
  entity: Entity,
  byId: Map<string, Entity>,
  arena: Arena,
): PropBag | null {
  const a = entity.anchor;
  if (!a) return null;
  const target = anchorTarget(entity, byId);
  if (!target) return null;

  const origin = a.from ? byId.get(a.from) : undefined;
  if (!a.from || !origin) {
    // Plain follow: sit on the target, keeping x/y as a nudge off it.
    return {
      x: target.x + entity.x,
      y: target.y + entity.y,
      ...(a.face ? { rotation: target.rotation } : {}),
    };
  }
  // x/y stays a nudge in the aimed case too, so a bait you dragged keeps the
  // displacement you gave it while still following whoever it is aimed at.
  const nudge = { x: entity.x, y: entity.y };

  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return { x: origin.x, y: origin.y };
  const ux = dx / dist;
  const uy = dy / dist;
  const rotation = (Math.atan2(ux, -uy) * 180) / Math.PI;

  const zone = entity as Partial<ZoneEntity>;
  const lengthwise =
    entity.type === "zone" && LENGTHWISE.has(zone.shape as string);
  const reach = a.extend
    ? rayToWall(arena, origin.x, origin.y, ux, uy)
    : undefined;

  if (!lengthwise) {
    // Cones and circles pivot on the source; only their facing is aimed.
    return {
      x: origin.x + nudge.x,
      y: origin.y + nudge.y,
      rotation,
      ...(reach ? { radius: reach } : {}),
    };
  }
  const length = reach ?? zone.length ?? dist;
  return {
    x: origin.x + ux * (length / 2) + nudge.x,
    y: origin.y + uy * (length / 2) + nudge.y,
    rotation,
    length,
  };
}

/**
 * Entities that should be drawn for a step, in draw order, already resolved:
 * per-step overrides merged in, an in-flight drag applied, then anchors solved
 * against the resulting poses.
 */
export function entitiesForStep(
  plan: Plan,
  stepId: string | undefined,
  live?: Map<string, { x: number; y: number }>,
): Entity[] {
  /** Every entity as it stands in one step, before any binding is solved. */
  const posesIn = (sid: string | undefined) =>
    plan.entities
      .filter((e) => entityInStep(e, sid, plan))
      .map((e) => {
        const base = resolveEntity(e, sid);
        // A drag in progress: the canvas hands us where the thing is *right
        // now*, before any of it has been committed, so bindings solve against
        // the pose you are looking at instead of the one you started from.
        // Only the step you are looking at has a drag in it.
        const at = sid === stepId ? live?.get(e.id) : undefined;
        return at ? ({ ...base, x: at.x, y: at.y } as Entity) : base;
      });

  const here = posesIn(stepId);
  const byId = new Map(here.map((e) => [e.id, e]));
  /** The same map for another step, built once each — bindings look back at it. */
  const elsewhere = new Map<string, Map<string, Entity>>();
  const posesFor = (sid: string) => {
    if (sid === stepId) return byId;
    let m = elsewhere.get(sid);
    if (!m)
      elsewhere.set(sid, (m = new Map(posesIn(sid).map((e) => [e.id, e]))));
    return m;
  };

  const resolved = here;
  const out: Entity[] = [];
  for (const raw of resolved) {
    if (raw.hidden) continue;
    const mech = raw.mech
      ? plan.mechs?.find((m) => m.id === raw.mech)
      : undefined;
    // Before it goes off a mech is a telegraph on the floor, so it is drawn
    // faint until the step it resolves in, where it reads as the hit it is.
    const e =
      mech && stepId && stepId !== (mech.boom || mech.snap)
        ? ({ ...raw, opacity: raw.opacity * 0.55 } as Entity)
        : raw;
    if (!e.anchor) {
      out.push(e);
      continue;
    }
    // A binding belongs to the step it was declared in: it marks where its
    // target stood then, not wherever that target has walked off to since. For
    // a mech that step is its snapshot, wherever the shape was first dropped.
    const declaredIn = mech ? mech.snap || e.declaredIn : e.declaredIn;
    const pose = anchoredPose(
      e,
      declaredIn ? posesFor(declaredIn) : byId,
      plan.arena,
    );
    // No target in this step means the bait has nobody to land on: skip it,
    // rather than drawing it at whatever pose it happened to be authored with.
    if (pose) out.push({ ...e, ...pose } as Entity);
  }
  return out;
}
