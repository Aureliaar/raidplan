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

export const TETHER_STYLES = ["line", "close", "far", "plus", "minus", "chain"] as const;
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
const OverridesSchema = z.record(z.string(), z.record(z.string(), z.any())).default({});

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
  /** `"all"` or the list of step ids this entity exists in. */
  steps: z.union([z.literal("all"), z.array(z.string())]).default("all"),
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

export const PlanSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string(),
  name: z.string().default("Untitled plan"),
  description: z.string().default(""),
  encounter: z.string().default(""),
  arena: ArenaSchema.prefault({}),
  steps: z.array(StepSchema).default([]),
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
      })
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
 * Resolve an entity's properties for a given step: base props with that
 * step's overrides merged on top.
 */
export function resolveEntity<T extends Entity>(entity: T, stepId: string | undefined): T {
  const ov = stepId ? entity.overrides?.[stepId] : undefined;
  if (!ov || Object.keys(ov).length === 0) return entity;
  return { ...entity, ...(ov as Partial<T>) };
}

/** Does this entity exist in the given step? */
export function entityInStep(entity: Entity, stepId: string | undefined): boolean {
  if (!stepId) return true;
  if (entity.steps === "all") return true;
  return entity.steps.includes(stepId);
}

/** Entities that should be drawn for a step, in draw order, already resolved. */
export function entitiesForStep(plan: Plan, stepId: string | undefined): Entity[] {
  return plan.entities
    .filter((e) => entityInStep(e, stepId))
    .map((e) => resolveEntity(e, stepId))
    .filter((e) => !e.hidden);
}
