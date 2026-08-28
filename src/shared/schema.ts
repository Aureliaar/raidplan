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
  /**
   * The physical width of the floor in FFXIV yalms. Coordinates stay in the
   * stable authoring space above; this calibrates those units without moving
   * or resizing an existing plan.
   */
  widthYalms: z.number().positive().optional(),
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

/** Convert a distance in authoring units using an effective physical width. */
export function arenaUnitsToYalms(arena: Arena, units: number, widthYalms = arena.widthYalms ?? 40): number {
  return units * (widthYalms / arena.width);
}

/** Convert an in-game distance to the authoring units stored in the document. */
export function yalmsToArenaUnits(arena: Arena, yalms: number, widthYalms = arena.widthYalms ?? 40): number {
  return yalms * (arena.width / widthYalms);
}

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
  /** A stack you line up for: a beam from the boss that several people share. */
  "linestack",
  /** A big circle on one person that they carry away from everyone else. */
  "flare",
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
  /**
   * Copies made by the canvas symmetry tool. Keeping the relationship in the
   * document means any face can be edited later and the rest of the set can
   * follow, rather than symmetry being a temporary rendering trick.
   */
  symmetry: z
    .object({
      id: z.string(),
      kind: z.enum(["mirror", "rotate"]),
      count: z.union([z.literal(2), z.literal(4)]),
      index: z.number().int().min(0).max(3),
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
  // Small enough that eight of them leave the floor readable: the token is
  // decoration around a point, and the AoEs are what the plan is about.
  size: z.number().positive().default(60),
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
  /** circle / donut / proximity / stack / flare / spread / tower outer radius. */
  radius: z.number().positive().default(150),
  /** donut hole radius. */
  innerRadius: z.number().min(0).default(75),
  /** cone width in degrees. */
  angle: z.number().min(1).max(360).default(90),
  /** rect / line / arrow / knockback / linestack footprint. */
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
  /** Distance at which a close/far tether changes from failing to satisfied. */
  range: z.number().positive().optional(),
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

/**
 * One Beat Variant's detached content for one Step.
 *
 * This deliberately contains only Parts owned by the Beat. Actors, waymarks,
 * Step structure and the Beat's timing stay in their shared document layers.
 * Absence from `Step.beatVariantContent` means the Variant still follows the
 * live shared Parts for that Beat at that Step.
 */
export const BeatVariantContentSchema = z.object({
  /** A detached Variant may say that this Beat does not happen in this Step. */
  active: z.boolean().default(true),
  /** Beat colour/style at the copy-on-write boundary. */
  color: z.string().optional(),
  /** Ordered Parts for this Beat only. */
  parts: z.array(EntitySchema).default([]),
});
export type BeatVariantContent = z.infer<typeof BeatVariantContentSchema>;

/** A sparse absolute actor pose owned by one Beat Variant at one Step. */
export const BeatVariantPoseSchema = z.object({
  x: z.number(),
  y: z.number(),
  rotation: z.number(),
});
export type BeatVariantPose = z.infer<typeof BeatVariantPoseSchema>;

export const StepSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  notes: z.string().default(""),
  /**
   * The section of the fight this step is part of, if any. Steps of one
   * mechanic are kept contiguous in `plan.steps`, in the order its variants
   * are listed — the flat array stays the single ordering everything else
   * (poses, mech spans, `move_step`) is written against.
   */
  mechanic: z.string().optional(),

  /**
   * Ordered authored scenes for readings that have diverged in this step.
   * Absence means the reading still resolves the live shared entity list;
   * presence means membership, order and authored properties are a standalone
   * copy-on-write snapshot. Waymarks remain plan-wide and are not stored here.
   */
  variantScenes: z.record(z.string(), z.array(EntitySchema)).optional(),

  /**
   * Additive Beat-scoped copy-on-write domains. Keys are globally unique
   * Beat Variant ids. These fields are read only when `Plan.variantModel` is
   * `beat`; legacy Mechanic-wide scenes remain untouched beside them.
   */
  beatVariantContent: z.record(z.string(), BeatVariantContentSchema).optional(),
  beatVariantMovement: z
    .record(z.string(), z.record(z.string(), BeatVariantPoseSchema))
    .optional(),

});
export type Step = z.infer<typeof StepSchema>;

/**
 * One way a mechanic is played: "Near first" against "Far first". A mechanic
 * either has none — it happens one way — or two and up, each owning its own
 * run of steps.
 */
export const VariantSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  /**
   * Whose reading this is. Set by the server to whoever added it, and it is the
   * whole of "who edits what": one plan can hold everybody's answer to the same
   * mechanic, and only the person whose answer it is can change theirs. A
   * variant with no owner — every one written before this existed — is the
   * plan's, and anyone who can edit the plan can edit it.
   */
  ownerId: z.string().optional(),
  /** Their name as it read when they claimed it, so the pill can say whose it is. */
  ownerName: z.string().optional(),
  /** Beat Variant attribution only; normal plan editor permissions govern it. */
  createdBy: z.string().optional(),
  createdByName: z.string().optional(),
});
export type Variant = z.infer<typeof VariantSchema>;

/**
 * A non-owning preset of mutually exclusive Beat choices. Compatibility
 * Routes are produced by legacy conversion; Routes never own Parts or poses.
 */
export const BeatVariantRouteSchema = z.object({
  id: z.string(),
  name: z.string().default("Route"),
  selections: z.record(z.string(), z.string()).default({}),
  compatibility: z.boolean().default(false),
});
export type BeatVariantRoute = z.infer<typeof BeatVariantRouteSchema>;

/**
 * A section of the encounter — "Witch Hunt", "Electrope Edge 1" — owning an
 * ordered run of steps. This is the outline of the fight, not to be confused
 * with `Mech` below, which is one cast written as two moments.
 *
 * `variants` is a flat list on purpose: v1 offers one A/B axis per mechanic,
 * and a third reading is one more entry rather than a new dimension.
 */
export const MechanicSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  variants: z.array(VariantSchema).default([]),
});
export type Mechanic = z.infer<typeof MechanicSchema>;

/**
 * One status a debuff mech deals: what the plan needs to draw it, copied out
 * of the FF Logs dump it was picked from. Denormalized on purpose — a shared
 * plan renders without ever seeing the log.
 */
export const DebuffRefSchema = z.object({
  /** The game's status id, from the log. */
  id: z.number(),
  name: z.string(),
  /** Absolute icon URL (xivapi PNG). */
  icon: z.string().optional(),
});
export type DebuffRef = z.infer<typeof DebuffRefSchema>;

/** How player tokens are drawn while a debuff mech is active. */
export const DEBUFF_MODES = ["normal", "thd", "sd", "generic"] as const;
export type DebuffMode = (typeof DEBUFF_MODES)[number];

/** The groups a debuff pool can be dealt to. A `supports` pool present means
 * tanks and healers are being played as one interchangeable four. */
export const DEBUFF_GROUPS = ["tanks", "healers", "damagers", "supports"] as const;
export type DebuffGroup = (typeof DEBUFF_GROUPS)[number];

/**
 * The deal of a debuff mech: which statuses each role pool holds, and what
 * the party's tokens look like while the mech is on the floor. Pools are
 * role-scoped, never per-player — "the tanks have Burn" is the whole claim,
 * and which tank is not the plan's business.
 */
export const MechDebuffsSchema = z.object({
  mode: z.enum(DEBUFF_MODES).default("normal"),
  pools: z.partialRecord(z.enum(DEBUFF_GROUPS), z.array(DebuffRefSchema)).default({}),
});
export type MechDebuffs = z.infer<typeof MechDebuffsSchema>;

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
  /**
   * The colour everything in it is drawn in. Two casts on the floor at once
   * are only readable if you can tell at a glance which shapes belong together,
   * so the mech owns the colour and its shapes do not get a say. Unset on a
   * mech from before colours existed — `mechColor` picks one for it.
   */
  color: z.string().optional(),
  /**
   * Only in one reading of its mechanic. This is what a variant owns: the steps
   * are the same steps either way, and what differs is which casts land in them
   * — and, quietly, where the party stands.
   */
  variant: z.string().optional(),
  /**
   * Mutually exclusive child boxes of this timed Beat. Kept on persisted
   * `mech` for now so the wire format can evolve additively.
   */
  variants: z.array(VariantSchema).default([]),
  /** Set when this cast is a debuff deal: pools of statuses on role groups. */
  debuffs: MechDebuffsSchema.nullish(),
});
export type Mech = z.infer<typeof MechSchema>;

/** Hues that stay apart on the dark arena and from each other. */
export const MECH_COLORS = [
  "#ff7043", // orange
  "#26c6da", // cyan
  "#ec407a", // magenta
  "#9ccc65", // lime
  "#ab47bc", // violet
  "#ffca28", // amber
  "#ef5350", // red
  "#4db6ac", // teal
];

/** A mech's colour, or a stable stand-in for one that was never given one. */
export function mechColor(plan: Plan, mech: Mech): string {
  if (mech.color) return mech.color;
  const i = Math.max(0, plan.mechs.findIndex((m) => m.id === mech.id));
  return MECH_COLORS[i % MECH_COLORS.length];
}

/**
 * What a shape is coloured before anyone says otherwise. A raider reads the
 * floor by family long before they read any legend: stacks are yellow, the
 * things the boss throws are red-orange, towers are purple, and whatever a
 * bait anchor puts down is green — an add's mechanic, not the boss's.
 * Several shades to a family so two of the same kind are still two.
 */
export const ZONE_FAMILIES = {
  stack: ["#ffd54f", "#ffca28", "#ffe082", "#fdd835"],
  cast: ["#ff7043", "#ef5350", "#ff8a65", "#e64a19", "#f4511e"],
  tower: ["#ab47bc", "#9575cd", "#8e24aa", "#ba68c8"],
  bait: ["#9ccc65", "#c0ca33", "#aed581", "#cddc39"],
} as const;

const FAMILY_OF: Record<string, keyof typeof ZONE_FAMILIES> = {
  stack: "stack",
  linestack: "stack",
  tower: "tower",
};

/** A stable pick inside a family, so a shape keeps its shade across reloads. */
function shadeOf(id: string, family: keyof typeof ZONE_FAMILIES): string {
  const shades = ZONE_FAMILIES[family];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return shades[h % shades.length];
}

/** The family colour for a zone, or undefined when it is not a zone at all. */
export function zoneFamilyColor(plan: Plan, e: Entity): string | undefined {
  if (e.type !== "zone") return undefined;
  const from = e.anchor?.from
    ? plan.entities.find((o) => o.id === e.anchor!.from)
    : undefined;
  // Where it comes from beats what shape it is: an add's stack is still the
  // add's colour, because that is the thing you have to look at.
  const family =
    from?.type === "enemy" && from.role === "anchor" ? "bait" : FAMILY_OF[e.shape] ?? "cast";
  // The family says what kind of thing it is; the shade says whose it is, so
  // two casts of the same shape are still told apart at a glance. Eight shapes
  // from one drop are one thing and take one shade.
  return shadeOf(e.mech ?? e.bond?.id ?? e.id, family);
}

export const PlanSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string(),
  name: z.string().default("Untitled plan"),
  description: z.string().default(""),
  encounter: z.string().default(""),
  arena: ArenaSchema.prefault({}),
  steps: z.array(StepSchema).default([]),
  /** The outline of the fight: sections of it, each owning a run of steps. */
  mechanics: z.array(MechanicSchema).default([]),
  /** The casts, each spanning a run of steps. */
  mechs: z.array(MechSchema).default([]),
  /**
   * Explicit feature/version gate. Missing means the legacy Mechanic-wide
   * Variant reader; `beat` opts the document into Beat-owned Variants.
   */
  variantModel: z.literal("beat").optional(),
  /** Document-owned presets; browser preview overrides remain session-only. */
  variantRoutes: z.array(BeatVariantRouteSchema).optional(),
  /** Route used when a viewer has not made local preview choices. */
  defaultVariantRoute: z.string().optional(),
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
  const filled = {
    ...plan,
    mechs: (plan.mechs ?? []).map((beat) => ({ ...beat, variants: beat.variants ?? [] })),
    mechanics: plan.mechanics ?? [],
    ...(plan.variantModel === "beat" ? { variantRoutes: plan.variantRoutes ?? [] } : {}),
  };
  let hydrated = groupLooseSteps(filled);

  // Before variantScenes existed, the presence of any variant override was
  // the only evidence that this reading had been authored. Preserve the exact
  // state those documents currently resolve to, then opt them into the new
  // whole-step copy-on-write model. Untouched variants have no such override
  // and remain live views of shared state.
  for (const step of hydrated.steps) {
    const mechanic = hydrated.mechanics.find((candidate) => candidate.id === step.mechanic);
    for (const variant of mechanic?.variants ?? []) {
      if (variantStepEdited(hydrated, step.id, variant.id)) continue;
      const key = poseKey(step.id, variant.id);
      const legacyEdit = hydrated.entities.some((entity) =>
        Object.prototype.hasOwnProperty.call(entity.overrides ?? {}, key)
      );
      if (legacyEdit) hydrated = materializeVariantStep(hydrated, step.id, variant.id);
    }
  }
  return hydrated;
}

/**
 * Every step belongs to a mechanic.
 *
 * A plan written before the outline existed has steps and no sections at all,
 * and a rail that drew those loose above the sections read as two competing
 * lists. So a run of steps belonging to nothing becomes a mechanic of its own,
 * where that run sits — for an old plan, one section holding the whole fight.
 * Hydration runs on the way out of storage, so the next write persists it.
 */
function groupLooseSteps(plan: Plan): Plan {
  const known = new Set(plan.mechanics.map((m) => m.id));
  if (plan.steps.every((s) => s.mechanic && known.has(s.mechanic))) return plan;

  const mechanics: Mechanic[] = [];
  const steps: Step[] = [];
  let run: string | undefined;
  for (const step of plan.steps) {
    if (step.mechanic && known.has(step.mechanic)) {
      run = undefined;
      if (!mechanics.some((m) => m.id === step.mechanic))
        mechanics.push(plan.mechanics.find((m) => m.id === step.mechanic)!);
      steps.push(step);
      continue;
    }
    if (!run) {
      // Derived from the step it starts at rather than random, so the browser
      // and the server agree on it before anybody writes the plan back.
      run = `mechanic_${step.id.replace(/^step_/, "")}`;
      mechanics.push({ id: run, name: "", variants: [] });
    }
    steps.push({ ...step, mechanic: run });
  }
  // Sections follow their steps, so a mechanic nothing is in is not a section.
  return { ...plan, mechanics, steps };
}

/**
 * The steps of one mechanic, in plan order — of one variant if you name one.
 * A plan with no mechanics has every step in the ungrouped run, which is what
 * `mechanic: undefined` selects.
 */
export function mechanicSteps(plan: Plan, mechanicId: string | undefined): Step[] {
  return plan.steps.filter((s) => s.mechanic === mechanicId);
}

/** What a mechanic is called: its own name, or its place in the fight. */
export function mechanicLabel(plan: Plan, mechanic: Mechanic): string {
  if (mechanic.name) return mechanic.name;
  return `Mechanic ${plan.mechanics.indexOf(mechanic) + 1}`;
}

/**
 * What each reading of a mechanic is drawn in. Deliberately not the mech
 * palette: a lane in the rail is saying "this only happens the one way", not
 * "this cast is orange".
 */
export const VARIANT_COLORS = ["#7aa2f7", "#ab47bc", "#26c6da", "#9ccc65", "#ffca28"];

/** A variant's colour — its place in the mechanic, wrapped round the palette. */
export function variantColor(mechanic: Mechanic, variantId: string): string {
  const i = Math.max(0, mechanic.variants.findIndex((v) => v.id === variantId));
  return VARIANT_COLORS[i % VARIANT_COLORS.length];
}

/** What a variant is called: its own name, or its letter — A, B, C. */
export function variantLabel(mechanic: Mechanic, variantId: string): string {
  const i = mechanic.variants.findIndex((v) => v.id === variantId);
  if (i < 0) return "?";
  return mechanic.variants[i].name || String.fromCharCode(65 + i);
}

/**
 * Where a pose is filed. A shared step is one row of the rail but can hold two
 * readings of where the party stands, so an override is keyed by the step and,
 * when the move belongs to one variant, by that variant too.
 */
export function poseKey(stepId: string, variantId?: string): string {
  return variantId ? `${stepId}@${variantId}` : stepId;
}

/** The step half of a pose key — `poseKey` undone. */
export function poseStep(key: string): string {
  const at = key.indexOf("@");
  return at < 0 ? key : key.slice(0, at);
}

/** Has this reading stopped following the shared entity state in this step? */
export function variantStepEdited(plan: Plan, stepId: string, variantId: string): boolean {
  if (plan.variantModel === "beat") return beatVariantContentEdited(plan, stepId, variantId);
  const scenes = plan.steps.find((step) => step.id === stepId)?.variantScenes;
  return !!scenes && Object.prototype.hasOwnProperty.call(scenes, variantId);
}

/** The materialized scene for one reading, if it has crossed copy-on-write. */
export function variantStepScene(
  plan: Plan,
  stepId: string,
  variantId: string,
): Entity[] | undefined {
  return plan.steps.find((step) => step.id === stepId)?.variantScenes?.[variantId];
}

/**
 * Copy-on-write boundary for one moment in one reading.
 *
 * The first variant-scoped edit snapshots the ordered authored entity scene:
 * every non-waymark member, including hidden entities, with base + shared +
 * any legacy variant override resolved into a standalone full entity. Later
 * shared additions, deletion, reorder and property edits cannot leak into it.
 */
export function materializeVariantStep(plan: Plan, stepId: string, variantId: string): Plan {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`No step ${stepId}`);
  const mechanic = plan.mechanics.find((candidate) => candidate.id === step.mechanic);
  if (!mechanic?.variants.some((variant) => variant.id === variantId))
    throw new Error(`No variant ${variantId} in this step's mechanic`);
  if (variantStepEdited(plan, stepId, variantId)) return plan;

  const scene = plan.entities
    .filter((entity) => {
      if (entity.type === "marker" || !entityInStep(entity, stepId, plan)) return false;
      const mech = entity.mech ? plan.mechs.find((candidate) => candidate.id === entity.mech) : undefined;
      return !mech?.variant || mech.variant === variantId;
    })
    .map((entity) => EntitySchema.parse({ ...resolveEntity(entity, stepId, variantId), overrides: {} }));
  const steps = plan.steps.map((candidate) =>
    candidate.id === stepId
      ? {
          ...candidate,
          variantScenes: { ...candidate.variantScenes, [variantId]: scene },
        }
      : candidate
  );
  return { ...plan, steps };
}

/**
 * Resolve an entity's properties for a given step: base props, then that step's
 * overrides, then the ones belonging to the variant being played. So a move
 * made in one reading of a mechanic lands there and nowhere else, while a step
 * nobody has varied looks the same both ways.
 */
export function resolveEntity<T extends Entity>(
  entity: T,
  stepId: string | undefined,
  variantId?: string,
): T {
  if (!stepId) return entity;
  const shared = entity.overrides?.[stepId];
  const mine = variantId ? entity.overrides?.[poseKey(stepId, variantId)] : undefined;
  if (!shared && !mine) return entity;
  return { ...entity, ...(shared as Partial<T>), ...(mine as Partial<T>) };
}

/**
 * Plan-aware entity resolution. An untouched variant reads base + shared step
 * state. Once that variant-step has been edited, its materialized state is a
 * standalone snapshot: neither shared overrides nor later base-property edits
 * can leak into it.
 */
export function resolveEntityForStep<T extends Entity>(
  plan: Plan,
  entity: T,
  stepId: string | undefined,
  variantId?: string,
): T {
  if (stepId && variantId) {
    const materialized = variantStepScene(plan, stepId, variantId)?.find(
      (candidate) => candidate.id === entity.id
    );
    if (materialized) return materialized as T;
  }
  return resolveEntity(entity, stepId, variantId);
}

/**
 * Ordered authored members before hidden filtering, binding and presentation
 * dressing. Detached variants return their standalone scene plus live global
 * waymarks; untouched variants resolve the shared entity source.
 */
export function authoredEntitiesForStep(
  plan: Plan,
  stepId: string | undefined,
  variantId?: string,
): Entity[] {
  if (stepId && variantId) {
    const scene = variantStepScene(plan, stepId, variantId);
    if (scene) return [...plan.entities.filter((entity) => entity.type === "marker"), ...scene];
  }
  return plan.entities
    .filter((entity) => entityInStep(entity, stepId, plan))
    .filter((entity) => {
      const mech = entity.mech ? plan.mechs.find((candidate) => candidate.id === entity.mech) : undefined;
      return !mech?.variant || mech.variant === variantId;
    })
    .map((entity) => resolveEntity(entity, stepId, variantId));
}

/** Actors and waymarks never enter a Beat content snapshot. */
export function isBeatPart(entity: Entity): boolean {
  return entity.type !== "marker" && entity.type !== "player" && entity.type !== "enemy";
}

/** The owning Beat and local Variant for a globally unique Variant id. */
export function beatVariantOwner(
  plan: Plan,
  variantId: string,
): { beat: Mech; variant: Variant } | undefined {
  for (const beat of plan.mechs) {
    const variant = beat.variants.find((candidate) => candidate.id === variantId);
    if (variant) return { beat, variant };
  }
  return undefined;
}

/** What a Beat-local Variant is called: its name or stable A/B/C fallback. */
export function beatVariantLabel(beat: Mech, variantId: string): string {
  const index = beat.variants.findIndex((candidate) => candidate.id === variantId);
  if (index < 0) return "?";
  return beat.variants[index].name || String.fromCharCode(65 + index);
}

/** Has this Beat Variant detached its content domain at this Step? */
export function beatVariantContentEdited(plan: Plan, stepId: string, variantId: string): boolean {
  const content = plan.steps.find((step) => step.id === stepId)?.beatVariantContent;
  return !!content && Object.prototype.hasOwnProperty.call(content, variantId);
}

/** Sparse movement owned by this Beat Variant at this Step. */
export function beatVariantMovement(
  plan: Plan,
  stepId: string,
  variantId: string,
): Record<string, BeatVariantPose> {
  return plan.steps.find((step) => step.id === stepId)?.beatVariantMovement?.[variantId] ?? {};
}

/**
 * Copy-on-write boundary for one Beat's content domain only.
 *
 * The snapshot is deliberately restricted to Parts assigned to this Beat.
 * Moving an actor never calls this function, and materializing it never copies
 * actors or their Step poses.
 */
export function materializeBeatVariantContent(
  plan: Plan,
  stepId: string,
  variantId: string,
): Plan {
  if (plan.variantModel !== "beat") throw new Error("This plan does not use Beat Variants");
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`No step ${stepId}`);
  const owner = beatVariantOwner(plan, variantId);
  if (!owner) throw new Error(`No Beat Variant ${variantId}`);
  if (!mechSpan(plan, owner.beat).includes(stepId))
    throw new Error(`Beat Variant ${variantId} is not active in step ${stepId}`);
  if (beatVariantContentEdited(plan, stepId, variantId)) return plan;

  const parts = plan.entities
    .filter((entity) => entity.mech === owner.beat.id && isBeatPart(entity) && entityInStep(entity, stepId, plan))
    .map((entity) => EntitySchema.parse({ ...resolveEntity(entity, stepId), overrides: {} }));
  const content: BeatVariantContent = {
    active: true,
    ...(owner.beat.color ? { color: owner.beat.color } : {}),
    parts,
  };
  return {
    ...plan,
    steps: plan.steps.map((candidate) =>
      candidate.id === stepId
        ? {
            ...candidate,
            beatVariantContent: { ...candidate.beatVariantContent, [variantId]: content },
          }
        : candidate
    ),
  };
}

export interface BeatMovementConflict {
  actorId: string;
  beatIds: string[];
  variantIds: string[];
}

export interface BeatVariantComposition {
  entities: Entity[];
  conflicts: BeatMovementConflict[];
}

/** The document-owned default beneath this browser's session-only choices. */
export function defaultBeatVariantSelections(plan: Plan): Record<string, string> {
  const route = plan.variantRoutes?.find((candidate) => candidate.id === plan.defaultVariantRoute);
  return route ? route.selections : {};
}

/** Beat Variants active at one Step, each with exactly one selected sibling. */
export function activeBeatVariants(
  plan: Plan,
  stepId: string,
  shown: Record<string, string> = {},
): { beat: Mech; variant: Variant }[] {
  if (plan.variantModel !== "beat") return [];
  const selected = { ...defaultBeatVariantSelections(plan), ...shown };
  return plan.mechs.flatMap((beat) => {
    if (beat.variants.length < 2 || !mechSpan(plan, beat).includes(stepId)) return [];
    const requested = selected[beat.id];
    const variant = beat.variants.find((candidate) => candidate.id === requested) ?? beat.variants[0];
    return variant ? [{ beat, variant }] : [];
  });
}

/**
 * Compose independent Beat content and sparse movement domains before anchors
 * are solved. If two active Beats move the same actor, shared movement is the
 * safe preview; while authoring one of those Beats, its pose is shown instead.
 * Either result carries an explicit conflict record for the UI.
 */
export function composeBeatVariantEntities(
  plan: Plan,
  stepId: string | undefined,
  shown: Record<string, string> = {},
): BeatVariantComposition {
  const base = authoredEntitiesForStep(plan, stepId);
  if (plan.variantModel !== "beat" || !stepId)
    return { entities: base, conflicts: [] };

  const active = activeBeatVariants(plan, stepId, shown);
  const detachedByBeat = new Map<string, BeatVariantContent>();
  for (const { beat, variant } of active) {
    const content = plan.steps.find((step) => step.id === stepId)?.beatVariantContent?.[variant.id];
    if (content) detachedByBeat.set(beat.id, content);
  }

  // Shared scene layers (actors, waymarks and untimed Parts) keep their order.
  // Timed Parts then follow stable Beat order, with each Beat preserving its
  // own authored Part order. Variant count can therefore never create hidden
  // cross-Beat last-write ordering.
  const knownBeats = new Set(plan.mechs.map((beat) => beat.id));
  const entities: Entity[] = base.filter(
    (entity) => !isBeatPart(entity) || !entity.mech || !knownBeats.has(entity.mech)
  );
  for (const beat of plan.mechs) {
    if (!mechSpan(plan, beat).includes(stepId)) continue;
    const content = detachedByBeat.get(beat.id);
    const parts = content
      ? content.active
        ? content.parts
        : []
      : base.filter((entity) => entity.mech === beat.id && isBeatPart(entity));
    entities.push(
      ...parts.map((part) =>
        content?.color && !part.color ? ({ ...part, color: content.color } as Entity) : part
      )
    );
  }

  const movesByActor = new Map<
    string,
    { beatId: string; variantId: string; pose: BeatVariantPose }[]
  >();
  for (const { beat, variant } of active) {
    for (const [actorId, pose] of Object.entries(beatVariantMovement(plan, stepId, variant.id))) {
      const list = movesByActor.get(actorId) ?? [];
      list.push({ beatId: beat.id, variantId: variant.id, pose });
      movesByActor.set(actorId, list);
    }
  }

  const conflicts: BeatMovementConflict[] = [];
  const composed = entities.map((entity) => {
    const moves = movesByActor.get(entity.id);
    if (!moves?.length) return entity;
    if (moves.length === 1) return { ...entity, ...moves[0].pose } as Entity;
    conflicts.push({
      actorId: entity.id,
      beatIds: moves.map((move) => move.beatId),
      variantIds: moves.map((move) => move.variantId),
    });
    // Ambiguous movement never wins by order or editor focus. Shared Step pose
    // is the deterministic safe preview until the author resolves the clash.
    return entity;
  });
  return { entities: composed, conflicts };
}

/** Validate a complete saved Route without mutating preview state. */
export function validateBeatVariantSelections(
  plan: Plan,
  selections: Record<string, string>,
): string[] {
  const errors: string[] = [];
  if (plan.variantModel !== "beat") return ["This plan does not use Beat Variants"];
  const varying = plan.mechs.filter((beat) => beat.variants.length >= 2);
  if (!varying.length) return ["This plan has no varying Beats"];
  for (const beat of varying) {
    const selected = selections[beat.id];
    if (!selected) errors.push(`Route is missing Beat ${mechLabel(plan, beat)}`);
    else if (!beat.variants.some((variant) => variant.id === selected))
      errors.push(`Route selects a Variant that does not belong to Beat ${mechLabel(plan, beat)}`);
  }
  for (const beatId of Object.keys(selections))
    if (!varying.some((beat) => beat.id === beatId)) errors.push(`Route contains unknown Beat ${beatId}`);
  if (errors.length) return errors;
  for (const step of plan.steps) {
    const conflicts = composeBeatVariantEntities(plan, step.id, selections).conflicts;
    for (const conflict of conflicts)
      errors.push(`Movement conflict for ${conflict.actorId} at ${step.name || step.id}`);
  }
  return errors;
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
  const first =
    plan.entities.find((e) => e.mech === mech.id) ??
    plan.steps
      .flatMap((step) => Object.values(step.variantScenes ?? {}).flat())
      .find((e) => e.mech === mech.id);
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
  /** Legacy Mechanic or Beat Variant selections, keyed by their owner id. */
  shown?: Record<string, string>,
): Entity[] {
  /**
   * Which reading of a step's mechanic is being played. Nobody saying means the
   * one it opens on, so a plain read of the plan is a coherent fight rather
   * than every reading at once.
   */
  const variantOf = (sid: string | undefined) => {
    const step = sid ? plan.steps.find((s) => s.id === sid) : undefined;
    const mechanic = step?.mechanic ? plan.mechanics?.find((m) => m.id === step.mechanic) : undefined;
    if (!mechanic?.variants.length) return undefined;
    const playing = shown?.[mechanic.id];
    return mechanic.variants.some((v) => v.id === playing) ? playing : mechanic.variants[0].id;
  };
  /** Every entity as it stands in one step, before any binding is solved. */
  const posesIn = (sid: string | undefined) =>
    (plan.variantModel === "beat"
      ? composeBeatVariantEntities(plan, sid, shown).entities
      : authoredEntitiesForStep(plan, sid, variantOf(sid)))
      .map((base) => {
        // A drag in progress: the canvas hands us where the thing is *right
        // now*, before any of it has been committed, so bindings solve against
        // the pose you are looking at instead of the one you started from.
        // Only the step you are looking at has a drag in it.
        const at = sid === stepId ? live?.get(base.id) : undefined;
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
    // Live shared scenes were gated before this point; detached scenes already
    // captured their exact membership, even if the shared cast changes later.
    // A mech's shapes wear its colour, whatever they were dropped as. And
    // before it goes off a mech is a telegraph on the floor, so it is drawn
    // faint until the step it resolves in, where it reads as the hit it is.
    // Colour, most particular first: what you set on the thing, then a colour
    // picked for the mech by hand, then the family the shape belongs to, then
    // the mech's own stand-in colour for everything that has no family —
    // anchors, tethers, the marks that are not shapes.
    const dressed = raw.color
      ? undefined
      : mech?.color ?? zoneFamilyColor(plan, raw) ?? (mech ? mechColor(plan, mech) : undefined);
    const e =
      dressed || mech
        ? ({
            ...raw,
            ...(dressed ? { color: dressed } : {}),
            opacity:
              mech && stepId && stepId !== (mech.boom || mech.snap)
                ? raw.opacity * 0.55
                : raw.opacity,
          } as Entity)
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
