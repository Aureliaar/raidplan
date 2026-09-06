import { z } from "zod";
import type { Op } from "./apply";
import {
  AnchorSchema,
  ARENA_SHAPES,
  authoredEntitiesForStep,
  beatVariantOwner,
  composeBeatVariantEntities,
  DEBUFF_GROUPS,
  DEBUFF_MODES,
  GRID_TYPES,
  MARKER_IDS,
  TETHER_STYLES,
  ZONE_SHAPES,
  type Entity,
  type Plan,
} from "./schema";
import { validateOpContext } from "./apply";

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const id = z.string().min(1);
const ids = z.array(id).max(512);
const steps = z.union([z.literal("all"), z.array(id).max(512)]);

const bond = strict({
  id,
  group: z.string(),
  label: z.string().optional(),
}).nullable();
const symmetry = strict({
  id,
  kind: z.enum(["mirror", "rotate"]),
  count: z.union([z.literal(2), z.literal(4)]),
  index: z.number().int().min(0).max(3),
}).nullable();

// These validators deliberately carry no defaults: parsing a patch must never
// turn an omitted property into an edit. EntitySchema supplies defaults only
// after a complete entity has been created or merged with its current value.
const commonCreate = {
  id: id.optional(),
  name: z.string().optional(),
  notes: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  rotation: z.number().optional(),
  scale: z.number().positive().optional(),
  opacity: z.number().min(0).max(1).optional(),
  color: z.string().optional(),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  anchor: AnchorSchema.nullish().optional(),
  bond: bond.optional(),
  symmetry: symmetry.optional(),
  steps: steps.optional(),
  mech: id.optional(),
  declaredIn: id.optional(),
};
const commonPatch = {
  name: z.string().optional(),
  notes: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  rotation: z.number().optional(),
  scale: z.number().positive().optional(),
  opacity: z.number().min(0).max(1).optional(),
  color: z.string().optional(),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  anchor: AnchorSchema.nullish().optional(),
  steps: steps.optional(),
};

const markerFields = { marker: z.enum(MARKER_IDS).optional(), size: z.number().positive().optional() };
const playerFields = {
  job: z.string().optional(),
  icon: z.string().optional(),
  size: z.number().positive().optional(),
  showFacing: z.boolean().optional(),
};
const enemyFields = {
  icon: z.string().optional(),
  size: z.number().positive().optional(),
  ring: z.boolean().optional(),
  showFacing: z.boolean().optional(),
  role: z.enum(["enemy", "anchor"]).optional(),
};
const zoneFields = {
  shape: z.enum(ZONE_SHAPES).optional(),
  radius: z.number().positive().optional(),
  innerRadius: z.number().min(0).optional(),
  angle: z.number().min(1).max(360).optional(),
  width: z.number().positive().optional(),
  length: z.number().positive().optional(),
  count: z.number().int().min(1).max(32).optional(),
  soak: z.number().int().min(1).max(8).optional(),
  hollow: z.boolean().optional(),
};
const tetherFields = {
  from: id.optional(),
  to: id.optional(),
  style: z.enum(TETHER_STYLES).optional(),
  width: z.number().positive().optional(),
  range: z.number().positive().optional(),
};
const textFields = {
  text: z.string().optional(),
  fontSize: z.number().positive().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  outline: z.boolean().optional(),
};
const pathFields = {
  points: z.array(z.number()).max(20_000).optional(),
  width: z.number().positive().optional(),
  closed: z.boolean().optional(),
  arrow: z.boolean().optional(),
  dashed: z.boolean().optional(),
};
const iconFields = { src: z.string().optional(), size: z.number().positive().optional() };

const createFor = <T extends Entity["type"], S extends z.ZodRawShape>(type: T, shape: S) =>
  strict({ ...commonCreate, type: z.literal(type), ...shape });
const patchFor = <S extends z.ZodRawShape>(shape: S) => strict({ ...commonPatch, ...shape });

const EntityCreateSchema = z.discriminatedUnion("type", [
  createFor("marker", markerFields),
  createFor("player", playerFields),
  createFor("enemy", enemyFields),
  createFor("zone", zoneFields),
  createFor("tether", tetherFields),
  createFor("text", textFields),
  createFor("path", pathFields),
  createFor("icon", iconFields),
]);
const EntityPatchSchemas = {
  marker: patchFor(markerFields),
  player: patchFor(playerFields),
  enemy: patchFor(enemyFields),
  zone: patchFor(zoneFields),
  tether: patchFor(tetherFields),
  text: patchFor(textFields),
  path: patchFor(pathFields),
  icon: patchFor(iconFields),
} satisfies Record<Entity["type"], z.ZodType>;
const EntityPatchSchema = z.union([
  EntityPatchSchemas.marker,
  EntityPatchSchemas.player,
  EntityPatchSchemas.enemy,
  EntityPatchSchemas.zone,
  EntityPatchSchemas.tether,
  EntityPatchSchemas.text,
  EntityPatchSchemas.path,
  EntityPatchSchemas.icon,
]);

const gridPatch = strict({
  type: z.enum(GRID_TYPES).optional(),
  rows: z.number().int().min(1).max(32).optional(),
  cols: z.number().int().min(1).max(32).optional(),
  rings: z.number().int().min(1).max(12).optional(),
  spokes: z.number().int().min(1).max(32).optional(),
  angle: z.number().optional(),
  color: z.string().optional(),
});
const arenaPatch = strict({
  shape: z.enum(ARENA_SHAPES).optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  widthYalms: z.number().positive().nullable().optional(),
  color: z.string().optional(),
  border: z.string().optional(),
  image: z.string().nullable().optional(),
  imageOpacity: z.number().min(0).max(1).optional(),
  grid: gridPatch.optional(),
});
const debuffRef = strict({ id: z.number(), name: z.string(), icon: z.string().optional() });
const debuffs = strict({
  mode: z.enum(DEBUFF_MODES).optional(),
  pools: z.partialRecord(z.enum(DEBUFF_GROUPS), z.array(debuffRef)).optional(),
}).nullable();
const encounterSetup = strict({
  arena: strict({
    shape: z.enum(ARENA_SHAPES).optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    widthYalms: z.number().positive().optional(),
    color: z.string().optional(),
    border: z.string().optional(),
    image: z.string().optional(),
    imageOpacity: z.number().min(0).max(1).optional(),
    grid: gridPatch.optional(),
  }),
  markers: z.array(strict({
    marker: z.enum(MARKER_IDS),
    x: z.number(),
    y: z.number(),
    size: z.number().positive().optional(),
  })).max(8),
});

const context = { stepId: id.optional(), variant: id.optional() };
const beatSelections = z.record(id, id);
const PublicOpSchema = z.discriminatedUnion("op", [
  strict({ op: z.literal("set_meta"), name: z.string().optional(), description: z.string().optional(), encounter: z.string().optional() }),
  strict({ op: z.literal("set_arena"), patch: arenaPatch }),
  strict({ op: z.literal("add_entity"), spec: EntityCreateSchema, ...context }),
  strict({ op: z.literal("update_entity"), id, patch: EntityPatchSchema, ...context }),
  strict({ op: z.literal("clear_override"), id, stepId: id, variant: id.optional() }),
  strict({ op: z.literal("delete_entities"), ids, ...context }),
  strict({ op: z.literal("duplicate_entity"), id, offset: z.number().optional(), ...context }),
  strict({ op: z.literal("reorder_entity"), id, where: z.enum(["front", "back", "forward", "backward"]), ...context }),
  strict({ op: z.literal("add_step"), name: z.string().optional(), notes: z.string().optional(), index: z.number().int().optional(), mechanic: id.optional() }),
  strict({ op: z.literal("duplicate_step"), stepId: id, name: z.string().optional() }),
  strict({ op: z.literal("update_step"), stepId: id, patch: strict({ name: z.string().optional(), notes: z.string().optional(), notesPos: strict({ x: z.number(), y: z.number() }).optional() }) }),
  strict({ op: z.literal("delete_step"), stepId: id }),
  strict({ op: z.literal("move_step"), stepId: id, index: z.number().int() }),
  strict({ op: z.literal("add_mechanic"), name: z.string().optional(), after: id.optional(), stepIds: ids.optional() }),
  strict({ op: z.literal("update_mechanic"), mechanicId: id, patch: strict({ name: z.string().optional() }) }),
  strict({ op: z.literal("delete_mechanic"), mechanicId: id, keepSteps: z.boolean().optional() }),
  strict({ op: z.literal("move_mechanic"), mechanicId: id, index: z.number().int() }),
  strict({ op: z.literal("add_step_variant"), stepId: id, name: z.string().optional() }),
  strict({ op: z.literal("update_step_variant"), stepId: id, variantId: id, patch: strict({ name: z.string().optional() }) }),
  strict({ op: z.literal("move_step_variant_set"), stepId: id, snap: id, boom: id }),
  strict({ op: z.literal("assign_beats_to_step_variant"), stepId: id, beatIds: ids, variantId: id.optional() }),
  strict({ op: z.literal("delete_step_variant"), stepId: id, variantId: id }),
  strict({ op: z.literal("collapse_step_variants"), stepId: id, variantId: id }),
  strict({ op: z.literal("set_step_variant_movement"), stepId: id, variantId: id, actorId: id, pose: strict({ x: z.number(), y: z.number(), rotation: z.number() }) }),
  strict({ op: z.literal("clear_step_variant_movement"), stepId: id, variantId: id, actorId: id.optional() }),
  strict({ op: z.literal("add_beat_variant"), beatId: id, name: z.string().optional() }),
  strict({ op: z.literal("update_beat_variant"), beatId: id, variantId: id, patch: strict({ name: z.string().optional() }) }),
  strict({ op: z.literal("duplicate_beat_variant"), beatId: id, variantId: id, name: z.string().optional() }),
  strict({ op: z.literal("delete_beat_variant"), beatId: id, variantId: id }),
  strict({ op: z.literal("collapse_beat_variants"), beatId: id, variantId: id }),
  strict({ op: z.literal("resume_beat_variant_content"), stepId: id, variantId: id }),
  strict({ op: z.literal("update_beat_variant_content"), stepId: id, variantId: id, patch: strict({ active: z.boolean().optional(), color: z.string().nullable().optional() }) }),
  strict({ op: z.literal("clear_beat_variant_movement"), stepId: id, variantId: id }),
  strict({ op: z.literal("reset_beat_variant_step"), stepId: id, variantId: id }),
  strict({ op: z.literal("add_beat_variant_route"), name: z.string().optional(), selections: beatSelections, compatibility: z.boolean().optional() }),
  strict({ op: z.literal("update_beat_variant_route"), routeId: id, patch: strict({ name: z.string().optional(), selections: beatSelections.optional() }) }),
  strict({ op: z.literal("delete_beat_variant_route"), routeId: id }),
  strict({ op: z.literal("set_default_beat_variant_route"), routeId: id.optional() }),
  strict({ op: z.literal("add_mech"), id: id.optional(), name: z.string().optional(), snap: id.optional(), boom: id.optional(), color: z.string().optional(), plain: z.boolean().optional() }),
  strict({ op: z.literal("merge_mechs"), into: id, mechIds: ids }),
  strict({ op: z.literal("update_mech"), mechId: id, patch: strict({ name: z.string().optional(), snap: id.optional(), boom: id.optional(), color: z.string().optional(), debuffs: debuffs.optional() }) }),
  strict({ op: z.literal("delete_mech"), mechId: id, keepEntities: z.boolean().optional() }),
  strict({ op: z.literal("assign_mech"), ids, mechId: id.nullable(), ...context }),
  strict({ op: z.literal("add_waymarks"), distance: z.number().optional() }),
  strict({ op: z.literal("apply_encounter"), setup: encounterSetup }),
  strict({ op: z.literal("add_party"), party: z.array(strict({ job: z.string(), name: z.string() })).max(64).optional(), radiusFraction: z.number().optional() }),
  strict({ op: z.literal("arrange_party"), radiusFraction: z.number().optional(), ...context }),
]);

const PublicOpsRequestSchema = strict({
  ops: z.union([PublicOpSchema, z.array(PublicOpSchema).min(1).max(256)]),
  sessionId: z.string().max(128).optional(),
});

export function parsePublicOpsRequest(value: unknown): { ops: Op[]; sessionId?: string } {
  const parsed = PublicOpsRequestSchema.parse(value);
  return {
    ops: (Array.isArray(parsed.ops) ? parsed.ops : [parsed.ops]) as Op[],
    sessionId: parsed.sessionId,
  };
}

function addressedEntity(plan: Plan, op: Extract<Op, { op: "update_entity" }>): Entity | undefined {
  if (plan.variantModel === "beat" && op.stepId && op.variant) {
    const owner = beatVariantOwner(plan, op.variant);
    return owner
      ? composeBeatVariantEntities(
          plan,
          op.stepId,
          { [owner.beat.id]: op.variant }
        ).entities.find((entity) => entity.id === op.id)
      : undefined;
  }
  return op.stepId && op.variant
    ? authoredEntitiesForStep(plan, op.stepId, op.variant).find((entity) => entity.id === op.id)
    : plan.entities.find((entity) => entity.id === op.id);
}

function entityIdExists(plan: Plan, entityId: string): boolean {
  return plan.entities.some((entity) => entity.id === entityId) || plan.steps.some((step) =>
    Object.values(step.variantScenes ?? {}).some((scene) =>
      scene.some((entity) => entity.id === entityId)
    ) || Object.values(step.beatVariantContent ?? {}).some((content) =>
      content.parts.some((entity) => entity.id === entityId)
    )
  );
}

function validateStepRefs(plan: Plan, value: "all" | string[] | undefined): void {
  if (!Array.isArray(value)) return;
  for (const stepId of value)
    if (!plan.steps.some((step) => step.id === stepId)) throw new Error(`No step ${stepId}`);
}

/** Semantic checks that need the current document, after wire sanitization. */
export function validatePublicOp(plan: Plan, op: Op): void {
  validateOpContext(plan, op);
  if (op.op === "add_entity") {
    if (op.spec.id && entityIdExists(plan, op.spec.id)) throw new Error(`Entity id ${op.spec.id} is already in use`);
    validateStepRefs(plan, op.spec.steps);
    if (op.spec.mech && !plan.mechs.some((mech) => mech.id === op.spec.mech))
      throw new Error(`No mech ${op.spec.mech}`);
    if (op.spec.declaredIn && !plan.steps.some((step) => step.id === op.spec.declaredIn))
      throw new Error(`No step ${op.spec.declaredIn}`);
  }
  if (op.op === "update_entity") {
    const entity = addressedEntity(plan, op);
    if (!entity) throw new Error(`No entity ${op.id}`);
    EntityPatchSchemas[entity.type].parse(op.patch);
    validateStepRefs(plan, op.patch.steps);
  }
  if (op.op === "add_mech") {
    if (op.id && plan.mechs.some((mech) => mech.id === op.id)) throw new Error(`Mech id ${op.id} is already in use`);
    for (const stepId of [op.snap, op.boom])
      if (stepId && !plan.steps.some((step) => step.id === stepId)) throw new Error(`No step ${stepId}`);
  }
  if (op.op === "merge_mechs") {
    for (const mechId of [op.into, ...op.mechIds])
      if (!plan.mechs.some((mech) => mech.id === mechId)) throw new Error(`No mech ${mechId}`);
  }
  if (op.op === "update_mech") {
    if (!plan.mechs.some((mech) => mech.id === op.mechId)) throw new Error(`No mech ${op.mechId}`);
    for (const stepId of [op.patch.snap, op.patch.boom])
      if (stepId && !plan.steps.some((step) => step.id === stepId)) throw new Error(`No step ${stepId}`);
  }
}

/** Validate one wire batch, including identities introduced inside the batch. */
export function validatePublicOps(plan: Plan, ops: Op[]): void {
  const introduced = new Set<string>();
  const introducedMechs = new Set<string>();
  for (const op of ops) {
    // A drop is one batch: the Beat it makes and the Parts that join it.
    if (op.op === "add_entity" && op.spec.mech && introducedMechs.has(op.spec.mech)) {
      validatePublicOp(plan, { ...op, spec: { ...op.spec, mech: undefined } });
      continue;
    }
    validatePublicOp(plan, op);
    if (op.op === "add_mech" && op.id) {
      if (introducedMechs.has(op.id)) throw new Error(`Mech id ${op.id} is repeated in this batch`);
      introducedMechs.add(op.id);
    }
    if (op.op === "add_entity" && op.spec.id) {
      if (introduced.has(op.spec.id)) throw new Error(`Entity id ${op.spec.id} is repeated in this batch`);
      introduced.add(op.spec.id);
    }
  }
}
