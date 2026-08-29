import { nanoid } from "nanoid";
import {
  type Arena,
  type BaitRule,
  type Entity,
  type EntityType,
  type Mech,
  type Mechanic,
  type Plan,
  type Step,
  type StepVariant,
  type Variant,
  type PropBag,
  type EncounterSetup,
  type MarkerId,
  type BeatVariantContent,
  type BeatVariantPose,
  type BeatVariantRoute,
  MARKER_IDS,
  ArenaSchema,
  EncounterSetupSchema,
  EntitySchema,
  PlanSchema,
  entityInStep,
  entitiesForStep,
  mechLabel,
  MECH_COLORS,
  mechColor,
  mechSpan,
  mechanicLabel,
  mechanicSteps,
  materializeVariantStep,
  materializeBeatVariantContent,
  beatVariantMovement,
  beatVariantLabel,
  beatVariantOwner,
  isBeatPart,
  validateBeatVariantSelections,
  poseKey,
  poseStep,
  resolveEntity,
  variantStepScene,
  variantLabel,
} from "./schema";
import {
  stepVariantOwner,
  stepVariants,
  validateStepVariantSelections,
} from "./step-variants";
import { DEFAULT_PARTY, jobLabel } from "./jobs";
import { zoneCovers } from "./hits";

/**
 * Every mutation of a plan lives here so the canvas, the HTTP API and the MCP
 * tools all behave identically. Ops are pure: they take a plan and return a new
 * one (the caller persists it).
 */

export const newId = (prefix: string) => `${prefix}_${nanoid(8)}`;

export function touch(plan: Plan): Plan {
  return { ...plan, updatedAt: Date.now(), rev: plan.rev + 1 };
}

/** Validate the one live Variant ownership model used by this document. */
function validateVariantSelections(
  plan: Plan,
  selections: Record<string, string>,
): string[] {
  return plan.variantModel === "step"
    ? validateStepVariantSelections(plan, selections)
    : validateBeatVariantSelections(plan, selections);
}

export function createPlan(opts: {
  id?: string;
  name?: string;
  encounter?: string;
  ownerId?: string;
  arena?: Partial<Arena>;
  withParty?: boolean;
  variantModel?: "beat" | "step";
}): Plan {
  const stepId = newId("step");
  const mechanicId = newId("mechanic");
  const now = Date.now();
  const plan: Plan = PlanSchema.parse({
    id: opts.id ?? newId("plan"),
    name: opts.name ?? "Untitled plan",
    encounter: opts.encounter ?? "",
    ownerId: opts.ownerId ?? "",
    arena: ArenaSchema.parse(opts.arena ?? {}),
    // Every step is in a mechanic, so a plan opens on a section rather than on
    // a rail with nothing to hang the first step off.
    mechanics: [{ id: mechanicId, name: "", variants: [] }],
    steps: [{ id: stepId, name: "Step 1", notes: "", mechanic: mechanicId }],
    entities: [],
    ...(opts.variantModel ? { variantModel: opts.variantModel, variantRoutes: [] } : {}),
    createdAt: now,
    updatedAt: now,
    rev: 0,
  });
  return opts.withParty ? addParty(plan).plan : plan;
}

/* ------------------------------------------------------------------ anchors */

export const ANCHORS = [
  "center",
  "N",
  "NE",
  "E",
  "SE",
  "S",
  "SW",
  "W",
  "NW",
] as const;
export type Anchor = (typeof ANCHORS)[number];

const ANCHOR_DIR: Record<Anchor, [number, number]> = {
  center: [0, 0],
  N: [0, -1],
  NE: [Math.SQRT1_2, -Math.SQRT1_2],
  E: [1, 0],
  SE: [Math.SQRT1_2, Math.SQRT1_2],
  S: [0, 1],
  SW: [-Math.SQRT1_2, Math.SQRT1_2],
  W: [-1, 0],
  NW: [-Math.SQRT1_2, -Math.SQRT1_2],
};

/**
 * Turn a compass anchor into arena coordinates.
 * `distance` is a fraction of the arena half-extent (1 = the wall).
 */
export function anchorToPoint(arena: Arena, anchor: Anchor, distance = 0.75): { x: number; y: number } {
  const [dx, dy] = ANCHOR_DIR[anchor] ?? [0, 0];
  return { x: dx * (arena.width / 2) * distance, y: dy * (arena.height / 2) * distance };
}

/** Compass bearing (0 = N, clockwise) for a point, for describing plans back. */
export function pointToCompass(x: number, y: number): string {
  if (Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6) return "center";
  const deg = (Math.atan2(x, -y) * 180) / Math.PI;
  const idx = Math.round(((deg + 360) % 360) / 45) % 8;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][idx];
}

/* ----------------------------------------------------------------- entities */

const DEFAULTS_BY_TYPE: Record<EntityType, PropBag> = {
  marker: { marker: "A" },
  // Players sit under the telegraphs, not over them; a touch of transparency
  // keeps the edge of a shape visible through a token standing on it.
  player: { job: "any", opacity: 0.85 },
  enemy: {},
  zone: { shape: "circle" },
  tether: { from: "", to: "" },
  text: { text: "text" },
  path: { points: [] },
  icon: { src: "" },
};

/** Build one fully-defaulted authored entity without deciding which scene owns it. */
function makeEntity(spec: PropBag & { type: EntityType }): Entity {
  return EntitySchema.parse({
    ...DEFAULTS_BY_TYPE[spec.type],
    ...spec,
    id: (spec.id as string | undefined) ?? newId(spec.type),
  });
}

/** Replace one already-materialized reading without touching revision metadata. */
function replaceVariantScene(
  plan: Plan,
  stepId: string,
  variantId: string,
  scene: Entity[]
): Plan {
  const steps = plan.steps.map((step) =>
    step.id === stepId
      ? { ...step, variantScenes: { ...step.variantScenes, [variantId]: scene } }
      : step
  );
  return { ...plan, steps };
}

/** Materialize and return the ordered scene that a variant-scoped edit owns. */
function sceneForEdit(plan: Plan, stepId: string, variantId: string): { plan: Plan; scene: Entity[] } {
  const detached = materializeVariantStep(plan, stepId, variantId);
  return { plan: detached, scene: variantStepScene(detached, stepId, variantId)! };
}

/** Resolve and validate a Beat-scoped address. Variant ids are globally unique. */
function beatAddress(plan: Plan, stepId: string, variantId: string): { beat: Mech; variant: Variant } {
  if (plan.variantModel !== "beat") throw new Error("This plan does not use Beat Variants");
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`No step ${stepId}`);
  const owner = beatVariantOwner(plan, variantId);
  if (!owner) throw new Error(`No Beat Variant ${variantId}`);
  if (!mechSpan(plan, owner.beat).includes(stepId))
    throw new Error(`Beat Variant ${variantId} is not active in step ${stepId}`);
  return owner;
}

/** Materialize and return this Beat's content domain, never its movement. */
function beatContentForEdit(
  plan: Plan,
  stepId: string,
  variantId: string,
): { plan: Plan; beat: Mech; content: BeatVariantContent } {
  const { beat } = beatAddress(plan, stepId, variantId);
  const detached = materializeBeatVariantContent(plan, stepId, variantId);
  return {
    plan: detached,
    beat,
    content: detached.steps.find((step) => step.id === stepId)!.beatVariantContent![variantId],
  };
}

/** Replace one already-materialized Beat content snapshot. */
function replaceBeatContent(
  plan: Plan,
  stepId: string,
  variantId: string,
  content: BeatVariantContent,
): Plan {
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step.id === stepId
        ? {
            ...step,
            beatVariantContent: { ...step.beatVariantContent, [variantId]: content },
          }
        : step
    ),
  };
}

const ACTOR_TYPES = new Set<Entity["type"]>(["player", "enemy"]);
const POSE_KEYS = new Set(["x", "y", "rotation"]);

/** Store one sparse absolute actor pose without detaching Beat content. */
function updateBeatMovement(
  plan: Plan,
  id: string,
  patch: PropBag,
  stepId: string,
  variantId: string,
): { plan: Plan; entity: Entity } {
  beatAddress(plan, stepId, variantId);
  const actor = plan.entities.find((candidate) => candidate.id === id);
  if (!actor || !ACTOR_TYPES.has(actor.type)) throw new Error(`No shared actor ${id}`);
  if (Object.keys(patch).some((key) => !POSE_KEYS.has(key)))
    throw new Error("Beat Variant actor edits may only change movement");
  const shared = resolveEntity(actor, stepId);
  const current = beatVariantMovement(plan, stepId, variantId)[id] ?? {
    x: shared.x,
    y: shared.y,
    rotation: shared.rotation,
  };
  const pose: BeatVariantPose = { ...current, ...defined(patch) };
  const steps = plan.steps.map((step) =>
    step.id === stepId
      ? {
          ...step,
          beatVariantMovement: {
            ...step.beatVariantMovement,
            [variantId]: { ...step.beatVariantMovement?.[variantId], [id]: pose },
          },
        }
      : step
  );
  const next = { ...plan, steps };
  for (const route of next.variantRoutes ?? []) {
    const errors = validateVariantSelections(next, route.selections);
    if (errors.length)
      throw new Error(`Movement would make saved Route “${route.name}” unsafe: ${errors.join("; ")}`);
  }
  const { compatibilityState, ...movement } = pose;
  return {
    plan: touch(next),
    entity: EntitySchema.parse({ ...shared, ...compatibilityState, ...movement }),
  };
}

const hasAuthoredVariants = (step: Step): boolean =>
  Object.keys(step.variantScenes ?? {}).length > 0;

/** The current shared source for one entity in one reading, ignoring any detached scene. */
function sharedEntityInVariantStep(
  plan: Plan,
  id: string,
  stepId: string,
  variantId: string
): Entity | undefined {
  const entity = plan.entities.find((candidate) => candidate.id === id);
  if (!entity || entity.type === "marker" || !entityInStep(entity, stepId, plan)) return undefined;
  const mech = entity.mech
    ? plan.mechs.find((candidate) => candidate.id === entity.mech)
    : undefined;
  if (mech?.variant && mech.variant !== variantId) return undefined;
  return EntitySchema.parse({ ...resolveEntity(entity, stepId), overrides: {} });
}

/** Add an entity. `spec.type` is required; everything else is defaulted. */
export function addEntity(
  plan: Plan,
  spec: PropBag & { type: EntityType },
  stepId?: string,
  variantId?: string
): { plan: Plan; entity: Entity } {
  const entity = makeEntity(spec);
  if (stepId && variantId && entity.type !== "marker") {
    if (plan.variantModel === "beat") {
      const detached = beatContentForEdit(plan, stepId, variantId);
      if (!isBeatPart(entity)) throw new Error("Actors are shared; a Beat Variant may only move them");
      if (entity.mech !== detached.beat.id)
        throw new Error(`A Part in this Variant must belong to Beat ${detached.beat.id}`);
      const content = { ...detached.content, parts: [...detached.content.parts, entity] };
      return {
        plan: touch(replaceBeatContent(detached.plan, stepId, variantId, content)),
        entity,
      };
    }
    const detached = sceneForEdit(plan, stepId, variantId);
    return {
      plan: touch(replaceVariantScene(detached.plan, stepId, variantId, [...detached.scene, entity])),
      entity,
    };
  }
  return { plan: touch({ ...plan, entities: [...plan.entities, entity] }), entity };
}

export function getEntity(plan: Plan, id: string): Entity | undefined {
  return plan.entities.find((e) => e.id === id);
}

/**
 * Patch an entity. A step + variant edits the standalone authored scene for
 * that reading. A step without a variant updates the shared per-step layer;
 * without a step it updates the plan-wide entity source.
 */
export function updateEntity(
  plan: Plan,
  id: string,
  patch: PropBag,
  stepId?: string,
  variantId?: string
): { plan: Plan; entity: Entity } {
  const clean: PropBag = defined(patch);
  delete clean.id;
  delete clean.type;
  delete clean.overrides;

  // Waymarks are a plan-wide layer. A step-scoped gesture must never detach a
  // reading merely because the editor happened to be showing one at the time.
  const globalIdx = plan.entities.findIndex((entity) => entity.id === id);
  const globalCurrent = globalIdx >= 0 ? plan.entities[globalIdx] : undefined;
  if (globalCurrent?.type === "marker") {
    const next = EntitySchema.parse({ ...globalCurrent, ...clean });
    const entities = [...plan.entities];
    entities[globalIdx] = next;
    return { plan: touch({ ...plan, entities }), entity: next };
  }

  if (stepId && variantId) {
    if (plan.variantModel === "beat") {
      const global = plan.entities.find((candidate) => candidate.id === id);
      if (global && ACTOR_TYPES.has(global.type))
        return updateBeatMovement(plan, id, clean, stepId, variantId);
      const detached = beatContentForEdit(plan, stepId, variantId);
      const idx = detached.content.parts.findIndex((entity) => entity.id === id);
      if (idx < 0) throw new Error(`No Part ${id} in this Beat Variant Step`);
      if ("mech" in clean && clean.mech !== detached.beat.id)
        throw new Error("A Variant Part cannot leave its owning Beat");
      const next = EntitySchema.parse({
        ...detached.content.parts[idx],
        ...clean,
        mech: detached.beat.id,
        overrides: {},
      });
      if (!isBeatPart(next)) throw new Error("A Beat Variant snapshot contains Parts only");
      const parts = [...detached.content.parts];
      parts[idx] = next;
      return {
        plan: touch(
          replaceBeatContent(detached.plan, stepId, variantId, { ...detached.content, parts })
        ),
        entity: next,
      };
    }
    const detached = sceneForEdit(plan, stepId, variantId);
    const idx = detached.scene.findIndex((entity) => entity.id === id);
    if (idx < 0) throw new Error(`No entity ${id} in this variant step`);
    const next = EntitySchema.parse({ ...detached.scene[idx], ...clean, overrides: {} });
    const scene = [...detached.scene];
    scene[idx] = next;
    return { plan: touch(replaceVariantScene(detached.plan, stepId, variantId, scene)), entity: next };
  }

  const idx = globalIdx;
  if (idx < 0) throw new Error(`No entity ${id}`);
  const current = globalCurrent!;

  let next: Entity;
  if (stepId) {
    const key = poseKey(stepId);
    const overrides = { ...current.overrides, [key]: { ...current.overrides?.[key], ...clean } };
    next = { ...current, overrides } as Entity;
    // Validate the merged result so a bad override is rejected at write time.
    EntitySchema.parse({ ...current, ...clean, overrides: {} });
  } else {
    next = EntitySchema.parse({ ...current, ...clean });
  }

  const entities = [...plan.entities];
  entities[idx] = next;
  return { plan: touch({ ...plan, entities }), entity: next };
}

/**
 * Revert an entity to its base pose in one layer. A shared clear only changes
 * the live shared layer; authored variants keep their snapshots. A variant
 * clear writes the base pose into that reading so it stays detached.
 */
export function clearOverride(plan: Plan, id: string, stepId: string, variantId?: string): Plan {
  const global = plan.entities.find((entity) => entity.id === id);
  if (global?.type === "marker") {
    const overrides = { ...global.overrides };
    delete overrides[stepId];
    const entities = plan.entities.map((entity) =>
      entity.id === id ? ({ ...entity, overrides } as Entity) : entity
    );
    return touch({ ...plan, entities });
  }
  if (variantId) {
    if (plan.variantModel === "beat") {
      const owner = beatAddress(plan, stepId, variantId);
      const actor = plan.entities.find((entity) => entity.id === id && ACTOR_TYPES.has(entity.type));
      if (actor) {
        const steps = plan.steps.map((step) => {
          if (step.id !== stepId) return step;
          const mine = { ...step.beatVariantMovement?.[variantId] };
          delete mine[id];
          const movement = { ...step.beatVariantMovement };
          if (Object.keys(mine).length) movement[variantId] = mine;
          else delete movement[variantId];
          return {
            ...step,
            beatVariantMovement: Object.keys(movement).length ? movement : undefined,
          };
        });
        return touch({ ...plan, steps });
      }
      const detached = beatContentForEdit(plan, stepId, variantId);
      const index = detached.content.parts.findIndex((entity) => entity.id === id);
      if (index < 0) throw new Error(`No Part ${id} in this Beat Variant Step`);
      const shared = plan.entities.find(
        (entity) => entity.id === id && entity.mech === owner.beat.id && isBeatPart(entity)
      );
      const parts = [...detached.content.parts];
      if (shared)
        parts[index] = EntitySchema.parse({ ...resolveEntity(shared, stepId), overrides: {} });
      else parts.splice(index, 1);
      return touch(
        replaceBeatContent(detached.plan, stepId, variantId, { ...detached.content, parts })
      );
    }
    const detached = sceneForEdit(plan, stepId, variantId);
    const idx = detached.scene.findIndex((entity) => entity.id === id);
    if (idx < 0) throw new Error(`No entity ${id} in this variant step`);
    const reset = sharedEntityInVariantStep(plan, id, stepId, variantId);
    if (!reset)
      return touch(
        replaceVariantScene(detached.plan, stepId, variantId, withoutEntities(detached.scene, [id]))
      );
    const scene = [...detached.scene];
    scene[idx] = reset;
    return touch(replaceVariantScene(detached.plan, stepId, variantId, scene));
  }
  const idx = plan.entities.findIndex((e) => e.id === id);
  if (idx < 0) throw new Error(`No entity ${id}`);
  const overrides = { ...plan.entities[idx].overrides };
  delete overrides[stepId];
  const entities = [...plan.entities];
  entities[idx] = { ...entities[idx], overrides } as Entity;
  return touch({ ...plan, entities });
}

function withoutEntities(entities: Entity[], ids: string[]): Entity[] {
  const gone = new Set(ids);
  return entities
    .filter((e) => !gone.has(e.id))
    // Tethers pointing at a deleted entity go with it.
    .filter((e) => !(e.type === "tether" && (gone.has(e.from) || gone.has(e.to))))
    // So does a bait bound to it: without its target it has no pose at all.
    .filter(
      (e) =>
        !(e.anchor && ((e.anchor.to && gone.has(e.anchor.to)) || (e.anchor.from && gone.has(e.anchor.from))))
    );
}

export function deleteEntities(plan: Plan, ids: string[], stepId?: string, variantId?: string): Plan {
  const markerIds = ids.filter(
    (id) => plan.entities.find((entity) => entity.id === id)?.type === "marker"
  );
  const markerSet = new Set(markerIds);
  const sceneIds = ids.filter((id) => !markerSet.has(id));
  let next = plan;
  if (markerIds.length) {
    next = {
      ...next,
      entities: withoutEntities(next.entities, markerIds),
      steps: next.steps.map((step) =>
        step.variantScenes
          ? {
              ...step,
              variantScenes: Object.fromEntries(
                Object.entries(step.variantScenes).map(([variant, scene]) => [
                  variant,
                  withoutEntities(scene, markerIds),
                ])
              ),
            }
          : step
      ),
    };
  }
  if (stepId && variantId && sceneIds.length) {
    if (next.variantModel === "beat") {
      const detached = beatContentForEdit(next, stepId, variantId);
      const partIds = new Set(detached.content.parts.map((entity) => entity.id));
      for (const id of sceneIds)
        if (!partIds.has(id))
          throw new Error(`Only Parts in Beat ${detached.beat.id} can be deleted from this Variant`);
      next = replaceBeatContent(detached.plan, stepId, variantId, {
        ...detached.content,
        parts: withoutEntities(detached.content.parts, sceneIds),
      });
    } else {
    const detached = sceneForEdit(next, stepId, variantId);
    next = replaceVariantScene(
      detached.plan,
      stepId,
      variantId,
      withoutEntities(detached.scene, sceneIds)
    );
    }
  } else if (sceneIds.length) {
    next = { ...next, entities: withoutEntities(next.entities, sceneIds) };
  }
  return touch(next);
}

export function duplicateEntity(
  plan: Plan,
  id: string,
  offset = 60,
  stepId?: string,
  variantId?: string
): { plan: Plan; entity: Entity } {
  const global = getEntity(plan, id);
  if (global?.type === "marker") {
    const copy = EntitySchema.parse({
      ...global,
      id: newId(global.type),
      x: global.x + offset,
      y: global.y + offset,
    });
    return { plan: touch({ ...plan, entities: [...plan.entities, copy] }), entity: copy };
  }
  if (stepId && variantId) {
    if (plan.variantModel === "beat") {
      const detached = beatContentForEdit(plan, stepId, variantId);
      const src = detached.content.parts.find((entity) => entity.id === id);
      if (!src) throw new Error(`No Part ${id} in this Beat Variant Step`);
      const copy = EntitySchema.parse({
        ...src,
        id: newId(src.type),
        x: src.x + offset,
        y: src.y + offset,
        mech: detached.beat.id,
        overrides: {},
      });
      return {
        plan: touch(
          replaceBeatContent(detached.plan, stepId, variantId, {
            ...detached.content,
            parts: [...detached.content.parts, copy],
          })
        ),
        entity: copy,
      };
    }
    const detached = sceneForEdit(plan, stepId, variantId);
    const src = detached.scene.find((entity) => entity.id === id);
    if (!src) throw new Error(`No entity ${id} in this variant step`);
    const copy = EntitySchema.parse({
      ...src,
      id: newId(src.type),
      x: src.x + offset,
      y: src.y + offset,
      overrides: {},
    });
    return {
      plan: touch(replaceVariantScene(detached.plan, stepId, variantId, [...detached.scene, copy])),
      entity: copy,
    };
  }
  const src = global;
  if (!src) throw new Error(`No entity ${id}`);
  const copy = { ...src, id: newId(src.type), x: src.x + offset, y: src.y + offset } as Entity;
  return { plan: touch({ ...plan, entities: [...plan.entities, copy] }), entity: copy };
}

export type ZOrder = "front" | "back" | "forward" | "backward";

function reordered(entities: Entity[], id: string, where: ZOrder): Entity[] {
  const idx = entities.findIndex((e) => e.id === id);
  if (idx < 0) throw new Error(`No entity ${id}`);
  const next = [...entities];
  const [item] = next.splice(idx, 1);
  const target =
    where === "front"
      ? next.length
      : where === "back"
        ? 0
        : where === "forward"
          ? Math.min(next.length, idx + 1)
          : Math.max(0, idx - 1);
  next.splice(target, 0, item);
  return next;
}

export function reorderEntity(
  plan: Plan,
  id: string,
  where: ZOrder,
  stepId?: string,
  variantId?: string
): Plan {
  const global = getEntity(plan, id);
  if (global?.type === "marker")
    return touch({ ...plan, entities: reordered(plan.entities, id, where) });
  if (stepId && variantId) {
    if (plan.variantModel === "beat") {
      const detached = beatContentForEdit(plan, stepId, variantId);
      return touch(
        replaceBeatContent(detached.plan, stepId, variantId, {
          ...detached.content,
          parts: reordered(detached.content.parts, id, where),
        })
      );
    }
    const detached = sceneForEdit(plan, stepId, variantId);
    return touch(
      replaceVariantScene(detached.plan, stepId, variantId, reordered(detached.scene, id, where))
    );
  }
  return touch({ ...plan, entities: reordered(plan.entities, id, where) });
}

/** Fuzzy lookup used by the MCP tools: id, exact name, job, or substring. */
export function findEntities(
  plan: Plan,
  query: { id?: string; name?: string; type?: EntityType; job?: string; text?: string }
): Entity[] {
  return plan.entities.filter((e) => {
    if (query.id && e.id !== query.id) return false;
    if (query.type && e.type !== query.type) return false;
    if (query.job && !(e.type === "player" && e.job.toUpperCase() === query.job.toUpperCase()))
      return false;
    if (query.name && (e.name ?? "").toLowerCase() !== query.name.toLowerCase()) return false;
    if (query.text) {
      const hay = [e.id, e.name, (e as { text?: string }).text, (e as { job?: string }).job]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(query.text.toLowerCase())) return false;
    }
    return true;
  });
}

/**
 * Drop keys whose value is `undefined`.
 *
 * A tool call carries every optional argument as an explicit `undefined`, and
 * spreading that over the current value erases what the caller never mentioned:
 * `update_step {notes}` once wiped the step's name, and `set_arena {grid}` reset
 * the floor to schema defaults. Patches mean "change these", never "clear the rest".
 */
function defined<T extends object>(o: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Resolve a loose reference ("MT", "WAR", "player_ab12") to exactly one entity. */
export function resolveRef(plan: Plan, ref: string): Entity {
  const byId = getEntity(plan, ref);
  if (byId) return byId;
  const exact = findEntities(plan, { name: ref });
  if (exact.length === 1) return exact[0];
  // A party is named D1-D4 or M1/M2/R1/R2 depending on who typed it, and both
  // spellings mean the same seat. Without this, "M1" falls through to the
  // substring pass and cheerfully resolves to a zone named "Desolation M1".
  // "A" or "3" means the waymark. Left to the substring pass it matches nothing
  // useful — every generated id contains the letters of its own type prefix.
  const asMarker = MARKER_IDS.find((m) => m.toLowerCase() === ref.trim().toLowerCase());
  if (asMarker) {
    const hit = plan.entities.find((e) => e.type === "marker" && e.marker === asMarker);
    if (hit) return hit;
  }
  const slot = PF_SLOTS.find((s) => s.names.some((n) => n.toLowerCase() === ref.toLowerCase()));
  for (const alias of slot?.names ?? []) {
    const hit = findEntities(plan, { name: alias, type: "player" });
    if (hit.length === 1) return hit[0];
  }
  const byJob = findEntities(plan, { job: ref });
  if (byJob.length === 1) return byJob[0];
  const fuzzy = findEntities(plan, { text: ref });
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1)
    throw new Error(
      `"${ref}" is ambiguous: ${fuzzy.map((e) => `${e.id}${e.name ? ` (${e.name})` : ""}`).join(", ")}`
    );
  throw new Error(`Nothing in this plan matches "${ref}"`);
}

/* -------------------------------------------------------------------- steps */

/**
 * Add a step, in the section it lands in.
 *
 * A step belongs to whatever run of steps it is placed into — the outline has
 * no room for a loose step in the middle of a mechanic — so unless the caller
 * names a mechanic, the new step inherits the one it is placed after.
 */
export function addStep(
  plan: Plan,
  opts: { name?: string; notes?: string; index?: number; mechanic?: string } = {}
): {
  plan: Plan;
  step: Step;
} {
  const index = Math.max(0, Math.min(plan.steps.length, opts.index ?? plan.steps.length));
  const after = plan.steps[index - 1];
  const mechanic = opts.mechanic ?? after?.mechanic;
  const step: Step = {
    id: newId("step"),
    // Steps are numbered within their own section, which is how the rail reads.
    name: opts.name ?? `Step ${mechanicSteps(plan, mechanic).length + 1}`,
    notes: opts.notes ?? "",
    ...(mechanic ? { mechanic } : {}),
  };
  const steps = [...plan.steps];
  steps.splice(index, 0, step);
  return { plan: touch(reflowSteps({ ...plan, steps })), step };
}

/**
 * Copy a step, including every entity's pose in it — the "next mechanic starts
 * where the last one ended" workflow.
 *
 * Poses carry forward, membership does not: an AoE scoped to the source step is
 * that step's mechanic and should not follow the party into the next one.
 */
export function duplicateStep(plan: Plan, stepId: string, name?: string): { plan: Plan; step: Step } {
  const idx = plan.steps.findIndex((s) => s.id === stepId);
  if (idx < 0) throw new Error(`No step ${stepId}`);
  const src = plan.steps[idx];
  // The copy is the same moment again, so it is in the same section: mechanic
  // and variant come along with the poses.
  const step: Step = {
    ...src,
    id: newId("step"),
    name: name ?? `${src.name} (copy)`,
    ...(src.variantScenes
      ? {
          variantScenes: Object.fromEntries(
            Object.entries(src.variantScenes).map(([variant, scene]) => [
              variant,
              scene.map((entity) => EntitySchema.parse({ ...entity, overrides: {} })),
            ])
          ),
        }
      : {}),
    ...(src.beatVariantContent
      ? {
          beatVariantContent: Object.fromEntries(
            Object.entries(src.beatVariantContent).map(([variant, content]) => [
              variant,
              {
                ...content,
                parts: content.parts.map((entity) =>
                  EntitySchema.parse({ ...entity, overrides: {} })
                ),
              },
            ])
          ),
        }
      : {}),
    ...(src.beatVariantMovement
      ? {
          beatVariantMovement: Object.fromEntries(
            Object.entries(src.beatVariantMovement).map(([variant, movement]) => [
              variant,
              Object.fromEntries(
                Object.entries(movement).map(([actorId, pose]) => [actorId, { ...pose }])
              ),
            ])
          ),
        }
      : {}),
  };
  let steps = [...plan.steps];
  steps.splice(idx + 1, 0, step);
  if (plan.variantModel === "beat") {
    const provisional = { ...plan, steps };
    const content = Object.fromEntries(
      Object.entries(step.beatVariantContent ?? {}).filter(([variantId]) => {
        const owner = beatVariantOwner(provisional, variantId);
        return !!owner && mechSpan(provisional, owner.beat).includes(step.id);
      })
    );
    const movement = Object.fromEntries(
      Object.entries(step.beatVariantMovement ?? {}).filter(([variantId]) => {
        const owner = beatVariantOwner(provisional, variantId);
        return !!owner && mechSpan(provisional, owner.beat).includes(step.id);
      })
    );
    steps = steps.map((candidate) =>
      candidate.id === step.id
        ? {
            ...candidate,
            beatVariantContent: Object.keys(content).length ? content : undefined,
            beatVariantMovement: Object.keys(movement).length ? movement : undefined,
          }
        : candidate
    );
  }

  const entities = plan.entities.map((e) => {
    const next = { ...e } as Entity;
    const mine = Object.keys(e.overrides ?? {}).filter((k) => poseStep(k) === stepId);
    if (mine.length) {
      const overrides = { ...e.overrides };
      // Every reading of the step comes along, each still filed under its own
      // variant: a copy of a step people stand two ways in is the same step.
      for (const k of mine) overrides[step.id + k.slice(stepId.length)] = { ...e.overrides![k] };
      next.overrides = overrides;
    }
    return next;
  });

  return { plan: touch({ ...plan, steps, entities }), step };
}

export function updateStep(
  plan: Plan,
  stepId: string,
  patch: Partial<Omit<Step, "id" | "variantScenes" | "beatVariantContent" | "beatVariantMovement">>
): Plan {
  // Copy-on-write fields are internal state, never public Step patches.
  const clean = defined(patch) as PropBag;
  delete clean.variantScenes;
  delete clean.beatVariantContent;
  delete clean.beatVariantMovement;
  const current = plan.steps.find((step) => step.id === stepId);
  if (!current) throw new Error(`No step ${stepId}`);
  if ("mechanic" in clean && clean.mechanic !== current.mechanic && hasAuthoredVariants(current))
    throw new Error("This step has authored variant scenes; reconcile them before moving it to another mechanic");
  const steps = plan.steps.map((s) =>
    s.id === stepId
      ? { ...s, ...clean }
      : s
  );
  return touch({ ...plan, steps });
}

/**
 * Take steps out of a plan, with everything that hung off them.
 *
 * Shared by `delete_step` and by the mechanic ops, which drop a whole block at
 * once: doing it one step at a time would collapse a mech onto a step that is
 * about to go too, and bump the revision once per row.
 */
function removeSteps(plan: Plan, ids: string[]): Plan {
  const gone = new Set(ids);
  const removedBoxes = plan.steps
    .filter((step) => gone.has(step.id))
    .flatMap((step) => stepVariants(step));
  const removedVariantIds = new Set(removedBoxes.map((variant) => variant.id));
  // A split is declared by its Step. Removing that Step removes its boxes and
  // the complete Beats they own; silently promoting those Beats to Shared
  // would change every surviving preview.
  const removedBoxedBeats = new Set(removedBoxes.flatMap((variant) => variant.beats));
  let steps = plan.steps.filter((s) => !gone.has(s.id));
  // A mech that loses one end collapses onto the other; one that loses both was
  // entirely inside the steps that just went away, and goes with them.
  const mechs = plan.mechs
    .map((m) => ({
      ...m,
      snap: gone.has(m.snap) ? "" : m.snap,
      boom: gone.has(m.boom) ? "" : m.boom,
    }))
    .filter((m) => (m.snap || m.boom) && !removedBoxedBeats.has(m.id))
    .map((m) => ({ ...m, snap: m.snap || m.boom, boom: m.boom || m.snap }));
  const dead = new Set(plan.mechs.filter((m) => !mechs.some((k) => k.id === m.id)).map((m) => m.id));
  const entities = plan.entities
    .map((e) => {
      const overrides = { ...e.overrides };
      for (const k of Object.keys(overrides)) if (gone.has(poseStep(k))) delete overrides[k];
      const steps2 = Array.isArray(e.steps) ? e.steps.filter((s) => !gone.has(s)) : e.steps;
      return {
        ...e,
        overrides,
        steps: steps2,
        ...(e.declaredIn && gone.has(e.declaredIn) ? { declaredIn: undefined } : {}),
      } as Entity;
    })
    // An entity that only existed in a deleted step goes away with it — and so
    // does one whose mech did.
    .filter((e) => !(e.mech && dead.has(e.mech)))
    .filter((e) => e.mech || e.steps === "all" || (e.steps as string[]).length > 0);
  steps = steps.map((step) => {
    const variantScenes = step.variantScenes
      ? Object.fromEntries(
          Object.entries(step.variantScenes).map(([variant, scene]) => {
            const deadIds = scene
              .filter((entity) => entity.mech && dead.has(entity.mech))
              .map((entity) => entity.id);
            return [
              variant,
              withoutEntities(scene, deadIds).map((entity) =>
                entity.declaredIn && gone.has(entity.declaredIn)
                  ? ({ ...entity, declaredIn: undefined } as Entity)
                  : entity
              ),
            ];
          })
        )
      : undefined;
    const stepVariantMovement = Object.fromEntries(
      Object.entries(step.stepVariantMovement ?? {}).filter(
        ([variantId]) => !removedVariantIds.has(variantId),
      ),
    );
    return {
      ...step,
      ...(variantScenes ? { variantScenes } : {}),
      variantEnd: step.variantEnd && gone.has(step.variantEnd) ? step.id : step.variantEnd,
      stepVariantMovement: Object.keys(stepVariantMovement).length
        ? stepVariantMovement
        : undefined,
    };
  });
  const variantRoutes = plan.variantRoutes?.map((route) => ({
    ...route,
    selections: Object.fromEntries(
      Object.entries(route.selections).filter(([ownerStepId]) => !gone.has(ownerStepId)),
    ),
  }));
  return { ...plan, steps, mechs, entities, variantRoutes };
}

/**
 * Delete a step.
 *
 * A section is its steps: the last step out of a variant takes that variant
 * with it, and the last step out of a mechanic takes the mechanic — a heading
 * with nothing under it is not something the outline can draw.
 */
export function deleteStep(plan: Plan, stepId: string): Plan {
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`No step ${stepId}`);
  if (plan.steps.length <= 1) throw new Error("A plan needs at least one step");
  const next = removeSteps(plan, [stepId]);
  return touch(reflowSteps(step.mechanic ? pruneMechanic(next, step.mechanic) : next));
}

/**
 * Move a step within its own section. A step belongs to the mechanic it is
 * part of, so ↑ and ↓ shuffle it among its siblings rather than sliding it out
 * of the run of steps it names.
 */
export function moveStep(plan: Plan, stepId: string, index: number): Plan {
  const from = plan.steps.findIndex((s) => s.id === stepId);
  if (from < 0) throw new Error(`No step ${stepId}`);
  const me = plan.steps[from];
  const siblings = plan.steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.mechanic === me.mechanic)
    .map(({ i }) => i);
  const to = Math.max(siblings[0], Math.min(siblings[siblings.length - 1], index));
  const steps = [...plan.steps];
  const [s] = steps.splice(from, 1);
  steps.splice(to, 0, s);
  return touch({ ...plan, steps });
}

/* ---------------------------------------------------------------- mechanics */

/**
 * The outline of the fight: Encounter → Mechanic → (Variant) → Steps.
 *
 * `plan.steps` stays the one flat, globally ordered list everything else is
 * written against; a mechanic is a label on a contiguous run of it. Every op
 * here keeps that true, which is what `reflowSteps` is for: sections in the
 * order of `plan.mechanics`, and inside one, the order they were written in.
 * Every step is in a section — `hydratePlan` sees to that on the way in — so
 * the rail is one list of headings and never two competing ones.
 */
function reflowSteps(plan: Plan): Plan {
  const rank = new Map<string, number>();
  plan.mechanics.forEach((m, i) => rank.set(m.id, i + 1));
  // A step whose mechanic has just gone is on its way out with it; sorting it
  // to the front keeps the comparison total instead of leaving it undefined.
  // Variants do not sort: a step gated to one sits where it happens in the
  // fight, in among the shared steps around it.
  const key = (s: Step) => (!s.mechanic ? 0 : (rank.get(s.mechanic) ?? 0));
  const steps = plan.steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => key(a.s) - key(b.s) || a.i - b.i)
    .map(({ s }) => s);
  return { ...plan, steps };
}

/** A, B, C… — what a variant is called until somebody names it "Near first". */
const variantName = (n: number) => String.fromCharCode(65 + n);

/**
 * Tidy a mechanic after steps were taken out of it: one lone variant is
 * dissolved back into a plain mechanic (a single reading is not a choice), and
 * a mechanic with no steps left goes entirely. A variant with no steps of its
 * own is left alone — that is a reading that differs only in where people
 * stand, which is the ordinary case.
 */
function pruneMechanic(plan: Plan, mechanicId: string): Plan {
  const mechanic = plan.mechanics.find((m) => m.id === mechanicId);
  if (!mechanic) return plan;
  const mine = plan.steps.filter((s) => s.mechanic === mechanicId);
  if (!mine.length) return { ...plan, mechanics: plan.mechanics.filter((m) => m.id !== mechanicId) };
  let variants = mechanic.variants;
  let mechs = plan.mechs;
  let entities = plan.entities;
  let steps = plan.steps;
  const authoredSurvivor =
    variants.length === 1 &&
    steps.some(
      (step) =>
        step.mechanic === mechanicId &&
        Object.prototype.hasOwnProperty.call(step.variantScenes ?? {}, variants[0].id)
    );
  // A detached survivor cannot be losslessly folded into the sparse shared
  // source: it may own additions, deletions and order as well as properties.
  // Keep its lone reading until the author explicitly reconciles that scene.
  if (variants.length <= 1 && !authoredSurvivor) {
    const gone = new Set(variants.map((v) => v.id));
    variants = [];
    mechs = mechs.map((m) => (m.variant && gone.has(m.variant) ? { ...m, variant: undefined } : m));
    // Poses filed under a reading that no longer exists would never be read
    // again, and would come back to life if the mechanic gained a variant with
    // the same id. They go with it.
    entities = entities.map((e) => {
      const overrides = { ...e.overrides };
      for (const k of Object.keys(overrides)) {
        const at = k.indexOf("@");
        if (at >= 0 && gone.has(k.slice(at + 1))) delete overrides[k];
      }
      return { ...e, overrides } as Entity;
    });
    steps = steps.map((step) =>
      step.mechanic === mechanicId
        ? {
            ...step,
            variantScenes: step.variantScenes
              ? Object.fromEntries(
                  Object.entries(step.variantScenes).filter(([variant]) => !gone.has(variant))
                )
              : undefined,
          }
        : step
    );
  }
  const mechanics = plan.mechanics.map((m) => (m.id === mechanicId ? { ...m, variants } : m));
  return { ...plan, mechanics, mechs, entities, steps };
}

/**
 * A plan always has a step, and every step is in a mechanic: deleting the last
 * section leaves a fresh empty one rather than a rail with nothing in it.
 */
function keepAStep(plan: Plan, doomed: Set<string>): Plan {
  if (plan.steps.some((s) => !doomed.has(s.id))) return plan;
  const mechanic: Mechanic = { id: newId("mechanic"), name: "", variants: [] };
  return {
    ...plan,
    mechanics: [...plan.mechanics, mechanic],
    steps: [...plan.steps, { id: newId("step"), name: "Step 1", notes: "", mechanic: mechanic.id }],
  };
}

/**
 * A new section of the fight. It comes with a step in it — an empty mechanic
 * is a heading and nothing else — unless you hand it steps to adopt.
 */
export function addMechanic(
  plan: Plan,
  opts: { name?: string; after?: string; stepIds?: string[] } = {}
): { plan: Plan; mechanic: Mechanic } {
  const at = opts.after ? plan.mechanics.findIndex((m) => m.id === opts.after) : -1;
  if (opts.after && at < 0) throw new Error(`No mechanic ${opts.after}`);
  const mechanic: Mechanic = {
    id: newId("mechanic"),
    // Unnamed, it goes by where it is in the fight — see `mechanicLabel`.
    name: opts.name ?? "",
    variants: [],
  };
  const mechanics = [...plan.mechanics];
  mechanics.splice(at < 0 ? mechanics.length : at + 1, 0, mechanic);
  const adopt = new Set(opts.stepIds ?? []);
  for (const id of adopt) {
    const step = plan.steps.find((candidate) => candidate.id === id);
    if (!step) throw new Error(`No step ${id}`);
    if (hasAuthoredVariants(step))
      throw new Error("This step has authored variant scenes; reconcile them before moving it to another mechanic");
  }
  const steps = adopt.size
    ? plan.steps.map((s) =>
        adopt.has(s.id) ? { ...s, mechanic: mechanic.id, variant: undefined } : s
      )
    : [...plan.steps, { id: newId("step"), name: "Step 1", notes: "", mechanic: mechanic.id }];
  return { plan: touch(reflowSteps({ ...plan, mechanics, steps })), mechanic };
}

export function updateMechanic(plan: Plan, mechanicId: string, patch: { name?: string }): Plan {
  if (!plan.mechanics.some((m) => m.id === mechanicId)) throw new Error(`No mechanic ${mechanicId}`);
  const mechanics = plan.mechanics.map((m) =>
    m.id === mechanicId ? { ...m, ...defined(patch) } : m
  );
  return touch({ ...plan, mechanics });
}

/**
 * Delete a mechanic. Its steps are the mechanic and go with it — unless you
 * keep them, which merges them into the neighbouring section (the one before
 * it, or the one after if it was first): every step is in a mechanic, so there
 * is nowhere else for them to go — both readings of a mechanic with variants
 * become plain steps of the section they join. The only mechanic in a plan has
 * no neighbour, and cannot hand its steps on.
 */
export function deleteMechanic(plan: Plan, mechanicId: string, keepSteps = false): Plan {
  const at = plan.mechanics.findIndex((m) => m.id === mechanicId);
  if (at < 0) throw new Error(`No mechanic ${mechanicId}`);
  const mechanics = plan.mechanics.filter((m) => m.id !== mechanicId);
  if (keepSteps) {
    const into = plan.mechanics[at - 1] ?? plan.mechanics[at + 1];
    if (!into)
      throw new Error("This is the only mechanic — its steps have no other section to go to");
    if (plan.steps.some((step) => step.mechanic === mechanicId && hasAuthoredVariants(step)))
      throw new Error("This mechanic has authored variant scenes; reconcile them before merging its steps");
    const steps = plan.steps.map((s) =>
      s.mechanic === mechanicId
        ? { ...s, mechanic: into.id, variant: into.variants[0]?.id }
        : s
    );
    return touch(reflowSteps({ ...plan, mechanics, steps }));
  }
  const doomed = plan.steps.filter((s) => s.mechanic === mechanicId).map((s) => s.id);
  const kept = keepAStep({ ...plan, mechanics }, new Set(doomed));
  return touch(reflowSteps(removeSteps(kept, doomed)));
}

/** Move a section of the fight, carrying its whole block of steps with it. */
export function moveMechanic(plan: Plan, mechanicId: string, index: number): Plan {
  const from = plan.mechanics.findIndex((m) => m.id === mechanicId);
  if (from < 0) throw new Error(`No mechanic ${mechanicId}`);
  const mechanics = [...plan.mechanics];
  const [m] = mechanics.splice(from, 1);
  mechanics.splice(Math.max(0, Math.min(mechanics.length, index)), 0, m);
  return touch(reflowSteps({ ...plan, mechanics }));
}

/* ----------------------------------------------------------- Step Variants */

/** A Step Variant is always one binary split: first use creates its A/B boxes. */
export function addStepVariant(
  plan: Plan,
  stepId: string,
  opts: { name?: string; createdBy?: string; createdByName?: string } = {},
): { plan: Plan; variant: StepVariant } {
  if (plan.variantModel !== "step") throw new Error("This plan does not use Step Variants");
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`No Step ${stepId}`);
  if (stepVariants(step).length) throw new Error("This Step already has its two Variant boxes");
  const attribution = opts.createdBy
    ? { createdBy: opts.createdBy, createdByName: opts.createdByName }
    : {};
  const first: StepVariant = {
    id: newId("step_variant"),
    name: variantName(0),
    beats: [],
    ...attribution,
  };
  const second: StepVariant = {
    id: newId("step_variant"),
    name: opts.name ?? variantName(1),
    beats: [],
    ...attribution,
  };
  const variants = [first, second];
  const steps = plan.steps.map((candidate) =>
    candidate.id === stepId ? { ...candidate, variants, variantEnd: candidate.variantEnd || stepId } : candidate,
  );
  return { plan: touch({ ...plan, steps }), variant: first };
}

export function updateStepVariant(
  plan: Plan,
  stepId: string,
  variantId: string,
  patch: { name?: string },
): Plan {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step || !stepVariants(step).some((variant) => variant.id === variantId))
    throw new Error(`No Step Variant ${variantId}`);
  return touch({
    ...plan,
    steps: plan.steps.map((candidate) =>
      candidate.id === stepId
        ? {
            ...candidate,
            variants: stepVariants(candidate).map((variant) =>
              variant.id === variantId ? { ...variant, ...defined(patch) } : variant,
            ),
          }
        : candidate,
    ),
  });
}

/** Move/resize a Step-owned Variant container without changing its children. */
export function moveStepVariantSet(plan: Plan, stepId: string, snap: string, boom: string): Plan {
  if (plan.variantModel !== "step") throw new Error("This plan does not use Step Variants");
  const owner = plan.steps.find((step) => step.id === stepId);
  const start = plan.steps.find((step) => step.id === snap);
  const end = plan.steps.find((step) => step.id === boom);
  if (!owner || stepVariants(owner).length < 2) throw new Error(`No Step Variant set ${stepId}`);
  if (!start || !end) throw new Error("Variant container range references an unknown Step");
  if (start.mechanic !== owner.mechanic || end.mechanic !== owner.mechanic)
    throw new Error("A Variant container cannot leave its Mechanic");
  const order = plan.steps;
  if (order.indexOf(start) > order.indexOf(end)) throw new Error("Variant container cannot end before it starts");
  if (start.id !== owner.id && stepVariants(start).length)
    throw new Error("That Step already declares a Variant container");
  const variants = stepVariants(owner);
  const steps = plan.steps.map((step) => {
    if (step.id === owner.id && step.id !== start.id)
      return { ...step, variants: [], variantEnd: undefined };
    if (step.id === start.id) return { ...step, variants, variantEnd: end.id };
    return step;
  });
  const variantRoutes = plan.variantRoutes?.map((route) => {
    if (start.id === owner.id || !route.selections[owner.id]) return route;
    const selections = { ...route.selections, [start.id]: route.selections[owner.id] };
    delete selections[owner.id];
    return { ...route, selections };
  });
  return touch({ ...plan, steps, variantRoutes });
}

/** Move whole Beats into one Step Variant box, or back to Shared. */
export function assignBeatsToStepVariant(
  plan: Plan,
  ownerStepId: string,
  beatIds: string[],
  variantId?: string,
): Plan {
  if (plan.variantModel !== "step") throw new Error("This plan does not use Step Variants");
  const owner = plan.steps.find((step) => step.id === ownerStepId);
  if (!owner) throw new Error(`No Step ${ownerStepId}`);
  if (variantId && !stepVariants(owner).some((variant) => variant.id === variantId))
    throw new Error(`No Step Variant ${variantId}`);
  const ids = new Set(beatIds);
  for (const id of ids) if (!plan.mechs.some((beat) => beat.id === id)) throw new Error(`No Beat ${id}`);
  const steps = plan.steps.map((step) => ({
    ...step,
    variants: stepVariants(step).map((variant) => ({
      ...variant,
      beats: variant.beats.filter((id) => !ids.has(id)),
    })),
  }));
  const at = steps.findIndex((step) => step.id === ownerStepId);
  if (variantId) {
    steps[at] = {
      ...steps[at],
      variants: stepVariants(steps[at]).map((variant) =>
        variant.id === variantId ? { ...variant, beats: [...variant.beats, ...ids] } : variant,
      ),
    };
  }
  if (variantId && ids.size) {
    const covered = plan.mechs
      .filter((beat) => ids.has(beat.id))
      .flatMap((beat) => mechSpan(plan, beat))
      .map((id) => plan.steps.findIndex((step) => step.id === id))
      .filter((index) => index >= 0);
    const ownerAt = plan.steps.findIndex((step) => step.id === ownerStepId);
    const currentEnd = plan.steps.findIndex(
      (step) => step.id === (steps[at].variantEnd || ownerStepId),
    );
    const endAt = Math.max(ownerAt, currentEnd, ...covered);
    steps[at] = { ...steps[at], variantEnd: plan.steps[endAt]?.id || ownerStepId };
  }
  return touch({ ...plan, steps });
}

function deleteOwnedBeats(plan: Plan, beatIds: Set<string>): Pick<Plan, "mechs" | "entities"> {
  return {
    mechs: plan.mechs.filter((beat) => !beatIds.has(beat.id)),
    entities: plan.entities.filter((entity) => !entity.mech || !beatIds.has(entity.mech)),
  };
}

/** Delete a third-or-later box and every Beat it owns. */
export function deleteStepVariant(plan: Plan, stepId: string, variantId: string): Plan {
  const owner = stepVariantOwner(plan, variantId);
  if (!owner || owner.step.id !== stepId) throw new Error(`No Step Variant ${variantId}`);
  const variants = stepVariants(owner.step);
  if (variants.length <= 2)
    throw new Error("Use Collapse Variants to deliberately choose which box becomes Shared");
  if (plan.variantRoutes?.some((route) => route.selections[stepId] === variantId))
    throw new Error("This Variant is used by a saved Route; update or delete that Route first");
  const doomed = new Set(owner.variant.beats);
  const { mechs, entities } = deleteOwnedBeats(plan, doomed);
  const steps = plan.steps.map((step) => {
    const movement = { ...step.stepVariantMovement };
    delete movement[variantId];
    return {
      ...step,
      variants:
        step.id === stepId
          ? stepVariants(step).filter((variant) => variant.id !== variantId)
          : stepVariants(step),
      stepVariantMovement: Object.keys(movement).length ? movement : undefined,
    };
  });
  return touch({ ...plan, mechs, entities, steps });
}

/** Promote one box's Beats and movement to Shared; delete its siblings. */
export function collapseStepVariants(plan: Plan, stepId: string, variantId: string): Plan {
  if (plan.variantModel !== "step") throw new Error("This plan does not use Step Variants");
  const owner = stepVariantOwner(plan, variantId);
  if (!owner || owner.step.id !== stepId) throw new Error(`No Step Variant ${variantId}`);
  const variants = stepVariants(owner.step);
  if (variants.length < 2) throw new Error("This Step is not varying");
  const siblingIds = new Set(variants.map((variant) => variant.id));
  const doomed = new Set(
    variants.filter((variant) => variant.id !== variantId).flatMap((variant) => variant.beats),
  );
  const kept = deleteOwnedBeats(plan, doomed);
  const movementByActor = new Map<string, Record<string, unknown>>();
  for (const step of plan.steps) {
    for (const [actorId, movement] of Object.entries(step.stepVariantMovement?.[variantId] ?? {})) {
      const { compatibilityState, ...pose } = movement;
      movementByActor.set(actorId, {
        ...(movementByActor.get(actorId) ?? {}),
        [step.id]: { ...compatibilityState, ...pose },
      });
    }
  }
  const entities = kept.entities.map((entity) => {
    const movement = movementByActor.get(entity.id);
    return movement
      ? EntitySchema.parse({ ...entity, overrides: { ...entity.overrides, ...movement } })
      : entity;
  });
  const steps = plan.steps.map((step) => {
    const movement = Object.fromEntries(
      Object.entries(step.stepVariantMovement ?? {}).filter(([id]) => !siblingIds.has(id)),
    );
    return {
      ...step,
      variants: step.id === stepId ? [] : stepVariants(step),
      stepVariantMovement: Object.keys(movement).length ? movement : undefined,
    };
  });
  const variantRoutes = plan.variantRoutes?.map((route) => {
    const selections = { ...route.selections };
    delete selections[stepId];
    return { ...route, selections };
  });
  return touch({ ...plan, mechs: kept.mechs, entities, steps, variantRoutes });
}

export function setStepVariantMovement(
  plan: Plan,
  stepId: string,
  variantId: string,
  actorId: string,
  pose: BeatVariantPose,
): Plan {
  if (!stepVariantOwner(plan, variantId)) throw new Error(`No Step Variant ${variantId}`);
  if (!plan.entities.some((entity) =>
    entity.id === actorId && (entity.type === "player" || entity.type === "enemy")
  ))
    throw new Error(`No actor ${actorId}`);
  const steps = plan.steps.map((step) =>
    step.id === stepId
      ? {
          ...step,
          stepVariantMovement: {
            ...step.stepVariantMovement,
            [variantId]: { ...step.stepVariantMovement?.[variantId], [actorId]: pose },
          },
        }
      : step,
  );
  const next = { ...plan, steps };
  for (const route of next.variantRoutes ?? []) {
    const errors = validateStepVariantSelections(next, route.selections);
    if (errors.length)
      throw new Error(`Movement would make saved Route “${route.name}” unsafe: ${errors.join("; ")}`);
  }
  return touch(next);
}

/** Remove one actor override, or resynchronize the whole box to Shared. */
export function clearStepVariantMovement(
  plan: Plan,
  stepId: string,
  variantId: string,
  actorId?: string,
): Plan {
  if (!stepVariantOwner(plan, variantId)) throw new Error(`No Step Variant ${variantId}`);
  if (!plan.steps.some((step) => step.id === stepId)) throw new Error(`No Step ${stepId}`);
  const steps = plan.steps.map((step) => {
    if (step.id !== stepId) return step;
    const all = { ...step.stepVariantMovement };
    if (!actorId) delete all[variantId];
    else {
      const actors = { ...all[variantId] };
      delete actors[actorId];
      if (Object.keys(actors).length) all[variantId] = actors;
      else delete all[variantId];
    }
    return { ...step, stepVariantMovement: Object.keys(all).length ? all : undefined };
  });
  return touch({ ...plan, steps });
}

/* ----------------------------------------------------------- Beat Variants */

/** First use makes two mutually exclusive child boxes; later uses add one. */
export function addBeatVariant(
  plan: Plan,
  beatId: string,
  opts: { name?: string; createdBy?: string; createdByName?: string } = {},
): { plan: Plan; variant: Variant } {
  if (plan.variantModel !== "beat") throw new Error("Enable Beat Variants for this plan first");
  const beat = plan.mechs.find((candidate) => candidate.id === beatId);
  if (!beat) throw new Error(`No Beat ${beatId}`);
  const made: Variant[] = [];
  let variants = beat.variants;
  if (!variants.length) {
    const first: Variant = { id: newId("beat_variant"), name: variantName(0) };
    variants = [first];
    made.push(first);
  }
  const variant: Variant = {
    id: newId("beat_variant"),
    name: opts.name ?? variantName(variants.length),
    ...(opts.createdBy
      ? { createdBy: opts.createdBy, createdByName: opts.createdByName }
      : {}),
  };
  variants = [...variants, variant];
  made.push(variant);
  const mechs = plan.mechs.map((candidate) =>
    candidate.id === beatId ? { ...candidate, variants } : candidate
  );
  return { plan: touch({ ...plan, mechs }), variant: made[0] };
}

export function updateBeatVariant(
  plan: Plan,
  beatId: string,
  variantId: string,
  patch: { name?: string },
): Plan {
  const beat = plan.mechs.find((candidate) => candidate.id === beatId);
  if (!beat) throw new Error(`No Beat ${beatId}`);
  if (!beat.variants.some((variant) => variant.id === variantId))
    throw new Error(`No Beat Variant ${variantId}`);
  const mechs = plan.mechs.map((candidate) =>
    candidate.id === beatId
      ? {
          ...candidate,
          variants: candidate.variants.map((variant) =>
            variant.id === variantId ? { ...variant, ...defined(patch) } : variant
          ),
        }
      : candidate
  );
  return touch({ ...plan, mechs });
}

/** Deep-copy every detached Step in both independent domains. */
export function duplicateBeatVariant(
  plan: Plan,
  beatId: string,
  variantId: string,
  opts: { name?: string; createdBy?: string; createdByName?: string } = {},
): { plan: Plan; variant: Variant } {
  const owner = beatVariantOwner(plan, variantId);
  if (!owner || owner.beat.id !== beatId) throw new Error(`No Beat Variant ${variantId}`);
  const variant: Variant = {
    id: newId("beat_variant"),
    name: opts.name ?? `${owner.variant.name || beatVariantLabel(owner.beat, variantId)} copy`,
    ...(opts.createdBy
      ? { createdBy: opts.createdBy, createdByName: opts.createdByName }
      : {}),
  };
  const sourceParts = plan.steps.flatMap(
    (step) => step.beatVariantContent?.[variantId]?.parts ?? []
  );
  const partIds = new Map<string, string>();
  const bondIds = new Map<string, string>();
  const symmetryIds = new Map<string, string>();
  for (const part of sourceParts) {
    if (!partIds.has(part.id)) partIds.set(part.id, newId(part.type));
    if (part.bond && !bondIds.has(part.bond.id)) bondIds.set(part.bond.id, newId("bond"));
    if (part.symmetry && !symmetryIds.has(part.symmetry.id))
      symmetryIds.set(part.symmetry.id, newId("symmetry"));
  }
  const clonePart = (part: Entity): Entity => {
    const anchor = part.anchor
      ? {
          ...part.anchor,
          to: partIds.get(part.anchor.to) ?? part.anchor.to,
          ...(part.anchor.from
            ? { from: partIds.get(part.anchor.from) ?? part.anchor.from }
            : {}),
          ...(part.anchor.near
            ? { near: partIds.get(part.anchor.near) ?? part.anchor.near }
            : {}),
        }
      : part.anchor;
    const endpointPatch =
      part.type === "tether"
        ? {
            from: partIds.get(part.from) ?? part.from,
            to: partIds.get(part.to) ?? part.to,
          }
        : {};
    return EntitySchema.parse({
      ...part,
      id: partIds.get(part.id)!,
      anchor,
      ...endpointPatch,
      ...(part.bond ? { bond: { ...part.bond, id: bondIds.get(part.bond.id)! } } : {}),
      ...(part.symmetry
        ? { symmetry: { ...part.symmetry, id: symmetryIds.get(part.symmetry.id)! } }
        : {}),
      overrides: {},
    });
  };
  const steps = plan.steps.map((step) => {
    const sourceContent = step.beatVariantContent?.[variantId];
    const sourceMovement = step.beatVariantMovement?.[variantId];
    return {
      ...step,
      ...(sourceContent
        ? {
            beatVariantContent: {
              ...step.beatVariantContent,
              [variant.id]: {
                ...sourceContent,
                parts: sourceContent.parts.map(clonePart),
              },
            },
          }
        : {}),
      ...(sourceMovement
        ? {
            beatVariantMovement: {
              ...step.beatVariantMovement,
              [variant.id]: Object.fromEntries(
                Object.entries(sourceMovement).map(([actorId, pose]) => [actorId, { ...pose }])
              ),
            },
          }
        : {}),
    };
  });
  const mechs = plan.mechs.map((beat) =>
    beat.id === beatId ? { ...beat, variants: [...beat.variants, variant] } : beat
  );
  return { plan: touch({ ...plan, mechs, steps }), variant };
}

/** Delete one sibling while preserving the invariant that a choice has 2+. */
export function deleteBeatVariant(plan: Plan, beatId: string, variantId: string): Plan {
  const beat = plan.mechs.find((candidate) => candidate.id === beatId);
  if (!beat?.variants.some((variant) => variant.id === variantId))
    throw new Error(`No Beat Variant ${variantId}`);
  if (beat.variants.length <= 2)
    throw new Error("Use Collapse Variants to deliberately choose which branch becomes Shared");
  if (plan.variantRoutes?.some((route) => route.selections[beatId] === variantId))
    throw new Error("This Variant is used by a saved Route; update or delete that Route first");
  const mechs = plan.mechs.map((candidate) =>
    candidate.id === beatId
      ? { ...candidate, variants: candidate.variants.filter((variant) => variant.id !== variantId) }
      : candidate
  );
  const steps = plan.steps.map((step) => {
    const content = { ...step.beatVariantContent };
    const movement = { ...step.beatVariantMovement };
    delete content[variantId];
    delete movement[variantId];
    return {
      ...step,
      beatVariantContent: Object.keys(content).length ? content : undefined,
      beatVariantMovement: Object.keys(movement).length ? movement : undefined,
    };
  });
  return touch({ ...plan, mechs, steps });
}

/**
 * End one Beat's branching by promoting the chosen Variant to Shared.
 *
 * Content is resolved independently at every Step in the Beat's span, then
 * folded back into ordinary shared Parts with explicit per-Step overrides.
 * Sparse actor movement is promoted into the actors' ordinary Step overrides.
 * The operation is deliberately atomic: no intermediate state can expose a
 * half-collapsed Beat to collaborators.
 */
export function collapseBeatVariants(plan: Plan, beatId: string, variantId: string): Plan {
  if (plan.variantModel !== "beat") throw new Error("This plan does not use Beat Variants");
  const beat = plan.mechs.find((candidate) => candidate.id === beatId);
  if (!beat?.variants.some((variant) => variant.id === variantId))
    throw new Error(`No Beat Variant ${variantId}`);
  if (beat.variants.length < 2) throw new Error("This Beat is not varying");

  const span = mechSpan(plan, beat);
  const siblingIds = new Set(beat.variants.map((variant) => variant.id));
  const sharedParts = plan.entities.filter(
    (entity) => entity.mech === beatId && isBeatPart(entity)
  );

  type ResolvedPart = { stepId: string; part: Entity };
  const appearances = new Map<string, ResolvedPart[]>();
  const order: string[] = [];
  for (const stepId of span) {
    const step = plan.steps.find((candidate) => candidate.id === stepId)!;
    const detached = step.beatVariantContent?.[variantId];
    const parts = detached
      ? detached.active
        ? detached.parts.map((part) =>
            detached.color && !part.color ? ({ ...part, color: detached.color } as Entity) : part
          )
        : []
      : sharedParts
          .filter((part) => entityInStep(part, stepId, plan))
          .map((part) => EntitySchema.parse({ ...resolveEntity(part, stepId), overrides: {} }));
    for (const part of parts) {
      if (!appearances.has(part.id)) order.push(part.id);
      const list = appearances.get(part.id) ?? [];
      list.push({ stepId, part });
      appearances.set(part.id, list);
    }
  }

  const promoted = order.map((partId) => {
    const states = appearances.get(partId)!;
    const first = states[0].part;
    const byStep = new Map(states.map((state) => [state.stepId, state.part]));
    const overrides = Object.fromEntries(
      span.map((stepId) => {
        const state = byStep.get(stepId);
        if (!state) return [stepId, { hidden: true }];
        const {
          id: _id,
          type: _type,
          mech: _mech,
          steps: _steps,
          overrides: _overrides,
          ...properties
        } = state;
        return [stepId, properties];
      })
    );
    return EntitySchema.parse({
      ...first,
      mech: beatId,
      steps: "all",
      overrides,
    });
  });

  const movementByActor = new Map<string, Record<string, unknown>>();
  for (const stepId of span) {
    const step = plan.steps.find((candidate) => candidate.id === stepId)!;
    for (const [actorId, movement] of Object.entries(
      step.beatVariantMovement?.[variantId] ?? {}
    )) {
      const { compatibilityState, ...pose } = movement;
      movementByActor.set(actorId, {
        ...(movementByActor.get(actorId) ?? {}),
        [stepId]: { ...compatibilityState, ...pose },
      });
    }
  }

  const entities = [
    ...plan.entities
      .filter((entity) => !(entity.mech === beatId && isBeatPart(entity)))
      .map((entity) => {
        const promotedMovement = movementByActor.get(entity.id);
        return promotedMovement
          ? EntitySchema.parse({
              ...entity,
              overrides: { ...entity.overrides, ...promotedMovement },
            })
          : entity;
      }),
    ...promoted,
  ];
  const steps = plan.steps.map((step) => {
    const content = Object.fromEntries(
      Object.entries(step.beatVariantContent ?? {}).filter(([id]) => !siblingIds.has(id))
    );
    const movement = Object.fromEntries(
      Object.entries(step.beatVariantMovement ?? {}).filter(([id]) => !siblingIds.has(id))
    );
    return {
      ...step,
      beatVariantContent: Object.keys(content).length ? content : undefined,
      beatVariantMovement: Object.keys(movement).length ? movement : undefined,
    };
  });
  const mechs = plan.mechs.map((candidate) =>
    candidate.id === beatId ? { ...candidate, variants: [] } : candidate
  );
  const variantRoutes = plan.variantRoutes?.map((route) => {
    const selections = { ...route.selections };
    delete selections[beatId];
    return { ...route, selections };
  });
  return touch({ ...plan, entities, steps, mechs, variantRoutes });
}

/** Resume live shared Parts without touching sparse movement. */
export function resumeBeatVariantContent(plan: Plan, stepId: string, variantId: string): Plan {
  beatAddress(plan, stepId, variantId);
  const steps = plan.steps.map((step) => {
    if (step.id !== stepId) return step;
    const content = { ...step.beatVariantContent };
    delete content[variantId];
    return {
      ...step,
      beatVariantContent: Object.keys(content).length ? content : undefined,
    };
  });
  return touch({ ...plan, steps });
}

/** Detach/update Beat-level content state without touching movement. */
export function updateBeatVariantContent(
  plan: Plan,
  stepId: string,
  variantId: string,
  patch: { active?: boolean; color?: string | null },
): Plan {
  const detached = beatContentForEdit(plan, stepId, variantId);
  const content: BeatVariantContent = {
    ...detached.content,
    ...("active" in patch && patch.active !== undefined ? { active: patch.active } : {}),
    ...("color" in patch
      ? patch.color
        ? { color: patch.color }
        : { color: undefined }
      : {}),
  };
  return touch(replaceBeatContent(detached.plan, stepId, variantId, content));
}

/** Clear only movement, preserving detached content at the same address. */
export function clearBeatVariantMovement(plan: Plan, stepId: string, variantId: string): Plan {
  beatAddress(plan, stepId, variantId);
  const steps = plan.steps.map((step) => {
    if (step.id !== stepId) return step;
    const movement = { ...step.beatVariantMovement };
    delete movement[variantId];
    return {
      ...step,
      beatVariantMovement: Object.keys(movement).length ? movement : undefined,
    };
  });
  return touch({ ...plan, steps });
}

/** Clear both domains at one Beat × Variant × Step boundary. */
export function resetBeatVariantStep(plan: Plan, stepId: string, variantId: string): Plan {
  beatAddress(plan, stepId, variantId);
  const steps = plan.steps.map((step) => {
    if (step.id !== stepId) return step;
    const content = { ...step.beatVariantContent };
    const movement = { ...step.beatVariantMovement };
    delete content[variantId];
    delete movement[variantId];
    return {
      ...step,
      beatVariantContent: Object.keys(content).length ? content : undefined,
      beatVariantMovement: Object.keys(movement).length ? movement : undefined,
    };
  });
  return touch({ ...plan, steps });
}

function assertRouteSelections(plan: Plan, selections: Record<string, string>): void {
  const errors = validateVariantSelections(plan, selections);
  if (errors.length) throw new Error(errors.join("; "));
}

/** Save a non-owning, conflict-free Beat selection preset. */
export function addBeatVariantRoute(
  plan: Plan,
  opts: { name?: string; selections: Record<string, string>; compatibility?: boolean },
): { plan: Plan; route: BeatVariantRoute } {
  assertRouteSelections(plan, opts.selections);
  const route: BeatVariantRoute = {
    id: newId("route"),
    name: opts.name ?? "Route",
    selections: { ...opts.selections },
    compatibility: opts.compatibility ?? false,
  };
  return {
    plan: touch({ ...plan, variantRoutes: [...(plan.variantRoutes ?? []), route] }),
    route,
  };
}

export function updateBeatVariantRoute(
  plan: Plan,
  routeId: string,
  patch: { name?: string; selections?: Record<string, string> },
): Plan {
  const route = plan.variantRoutes?.find((candidate) => candidate.id === routeId);
  if (!route) throw new Error(`No Route ${routeId}`);
  if (patch.selections) assertRouteSelections(plan, patch.selections);
  const variantRoutes = plan.variantRoutes!.map((candidate) =>
    candidate.id === routeId
      ? {
          ...candidate,
          ...defined(patch),
          ...(patch.selections ? { selections: { ...patch.selections } } : {}),
        }
      : candidate
  );
  return touch({ ...plan, variantRoutes });
}

export function deleteBeatVariantRoute(plan: Plan, routeId: string): Plan {
  if (!plan.variantRoutes?.some((candidate) => candidate.id === routeId))
    throw new Error(`No Route ${routeId}`);
  return touch({
    ...plan,
    variantRoutes: plan.variantRoutes.filter((candidate) => candidate.id !== routeId),
    defaultVariantRoute: plan.defaultVariantRoute === routeId ? undefined : plan.defaultVariantRoute,
  });
}

/** A conflicting or incomplete selection can never become document default. */
export function setDefaultBeatVariantRoute(plan: Plan, routeId?: string): Plan {
  if (!routeId) return touch({ ...plan, defaultVariantRoute: undefined });
  const route = plan.variantRoutes?.find((candidate) => candidate.id === routeId);
  if (!route) throw new Error(`No Route ${routeId}`);
  assertRouteSelections(plan, route.selections);
  return touch({ ...plan, defaultVariantRoute: routeId });
}

/**
 * Give a mechanic another reading.
 *
 * The steps are not copied: the mechanic keeps its one run of steps, and a
 * variant is a lane beside them. The first call makes two readings at once —
 * one reading is not a choice — with every existing step shared between them,
 * so you start from "the same fight both ways" and gate the steps that differ.
 */
export function addVariant(
  plan: Plan,
  mechanicId: string,
  opts: { name?: string; ownerId?: string; ownerName?: string } = {}
): { plan: Plan; variant: Variant } {
  if (plan.variantModel === "beat")
    throw new Error("Whole-Mechanic Variant authoring is disabled; add a Variant to a Beat");
  const mechanic = plan.mechanics.find((m) => m.id === mechanicId);
  if (!mechanic) throw new Error(`No mechanic ${mechanicId}`);
  const made: Variant[] = [];
  let variants = mechanic.variants;
  if (!variants.length) {
    const first: Variant = { id: newId("variant"), name: variantName(0) };
    variants = [first];
    made.push(first);
  }
  // The reading you asked for is yours. The one conjured alongside it, when a
  // mechanic that went one way suddenly goes two, is nobody's: it is what the
  // plan already said, and it belongs to the plan.
  const variant: Variant = {
    id: newId("variant"),
    name: opts.name ?? variantName(variants.length),
    ...(opts.ownerId ? { ownerId: opts.ownerId, ownerName: opts.ownerName } : {}),
  };
  variants = [...variants, variant];
  made.push(variant);
  const next = {
    ...plan,
    mechanics: plan.mechanics.map((m) => (m.id === mechanicId ? { ...m, variants } : m)),
  };
  return { plan: touch(next), variant: made[0] };
}

export function gateMech(plan: Plan, mechId: string, variantId?: string): Plan {
  if (plan.variantModel === "beat")
    throw new Error("Whole-Beat gating is legacy authoring; use this Beat's Variant boxes");
  const mech = plan.mechs.find((m) => m.id === mechId);
  if (!mech) throw new Error(`No mech ${mechId}`);
  if (variantId) {
    const step = plan.steps.find((s) => s.id === (mech.snap || mech.boom));
    const mechanic = plan.mechanics.find((m) => m.id === step?.mechanic);
    if (!mechanic?.variants.some((v) => v.id === variantId))
      throw new Error(`No variant ${variantId} in this mechanic`);
  }
  const mechs = plan.mechs.map((m) =>
    m.id === mechId ? ({ ...m, variant: variantId || undefined } as Mech) : m
  );
  return touch({ ...plan, mechs });
}

export function updateVariant(
  plan: Plan,
  mechanicId: string,
  variantId: string,
  patch: { name?: string }
): Plan {
  const mechanic = plan.mechanics.find((m) => m.id === mechanicId);
  if (!mechanic) throw new Error(`No mechanic ${mechanicId}`);
  if (!mechanic.variants.some((v) => v.id === variantId)) throw new Error(`No variant ${variantId}`);
  const mechanics = plan.mechanics.map((m) =>
    m.id === mechanicId
      ? { ...m, variants: m.variants.map((v) => (v.id === variantId ? { ...v, ...defined(patch) } : v)) }
      : m
  );
  return touch({ ...plan, mechanics });
}

/**
 * Delete one reading of a mechanic, and what only it had: the casts that went
 * off only that way, with their shapes, and the poses filed under it. The steps
 * are the mechanic's either way and stay exactly as they are. Take the
 * last-but-one and the mechanic is left plain.
 */
export function deleteVariant(plan: Plan, mechanicId: string, variantId: string): Plan {
  const mechanic = plan.mechanics.find((m) => m.id === mechanicId);
  if (!mechanic) throw new Error(`No mechanic ${mechanicId}`);
  if (!mechanic.variants.some((v) => v.id === variantId)) throw new Error(`No variant ${variantId}`);
  const doomedMechs = new Set(plan.mechs.filter((m) => m.variant === variantId).map((m) => m.id));
  const doomedEntityIds = plan.entities
    .filter((entity) => entity.mech && doomedMechs.has(entity.mech))
    .map((entity) => entity.id);
  let next: Plan = {
    ...plan,
    mechs: plan.mechs.filter((m) => !doomedMechs.has(m.id)),
    entities: withoutEntities(plan.entities, doomedEntityIds),
  };
  // The poses that were this reading's go with it; the shared ones stay.
  next = {
    ...next,
    entities: next.entities.map((e) => {
      const overrides = { ...e.overrides };
      for (const k of Object.keys(overrides)) if (k.endsWith(`@${variantId}`)) delete overrides[k];
      return { ...e, overrides } as Entity;
    }),
  };
  next = {
    ...next,
    steps: next.steps.map((step) =>
      step.mechanic === mechanicId
        ? {
            ...step,
            variantScenes: step.variantScenes
              ? Object.fromEntries(
                  Object.entries(step.variantScenes)
                    .filter(([variant]) => variant !== variantId)
                    .map(([variant, scene]) => {
                      const sceneDoomed = scene
                        .filter((entity) => entity.mech && doomedMechs.has(entity.mech))
                        .map((entity) => entity.id);
                      return [variant, withoutEntities(scene, sceneDoomed)];
                    })
                )
              : undefined,
          }
        : step
    ),
    mechanics: next.mechanics.map((m) =>
      m.id === mechanicId ? { ...m, variants: m.variants.filter((v) => v.id !== variantId) } : m
    ),
  };
  return touch(reflowSteps(pruneMechanic(next, mechanicId)));
}

/* -------------------------------------------------------------------- mechs */

/**
 * A new mech slot. It snapshots and explodes in the same step until told
 * otherwise — an instant cast, and the shortest thing that is still coherent.
 */
export function addMech(
  plan: Plan,
  opts: { name?: string; snap?: string; boom?: string; color?: string } = {},
): { plan: Plan; mech: Mech } {
  const here = opts.snap ?? plan.steps[0]?.id ?? "";
  // The least-used colour, so the second cast never matches the first and a
  // plan with a handful of them spreads across the palette.
  const used = (c: string) => plan.mechs.filter((m) => mechColor(plan, m) === c).length;
  const color =
    opts.color ?? MECH_COLORS.reduce((best, c) => (used(c) < used(best) ? c : best), MECH_COLORS[0]);
  const mech: Mech = {
    id: newId("mech"),
    name: opts.name ?? "",
    snap: here,
    boom: opts.boom ?? here,
    color,
    variants: [],
  };
  return { plan: touch({ ...plan, mechs: [...plan.mechs, mech] }), mech };
}

export function updateMech(plan: Plan, mechId: string, patch: Partial<Omit<Mech, "id">>): Plan {
  const current = plan.mechs.find((m) => m.id === mechId);
  if (!current) throw new Error(`No mech ${mechId}`);
  if (plan.variantModel === "beat" && patch.variant)
    throw new Error("Beat-model plans cannot gate a whole Beat to a Mechanic Variant");
  const mechs = plan.mechs.map((m) => (m.id === mechId ? { ...m, ...defined(patch) } : m));
  if (plan.variantModel === "beat" && (patch.snap !== undefined || patch.boom !== undefined)) {
    const next = { ...plan, mechs };
    const moved = mechs.find((beat) => beat.id === mechId)!;
    const inside = new Set(mechSpan(next, moved));
    const variants = new Set(moved.variants.map((variant) => variant.id));
    const orphan = next.steps.find(
      (step) =>
        !inside.has(step.id) &&
        (Object.keys(step.beatVariantContent ?? {}).some((id) => variants.has(id)) ||
          Object.keys(step.beatVariantMovement ?? {}).some((id) => variants.has(id)))
    );
    if (orphan)
      throw new Error(
        `Shortening this Beat would orphan Variant edits at ${orphan.name || orphan.id}; reset or move them first`
      );
  }
  return touch({ ...plan, mechs });
}

/**
 * Delete a mech. Its shapes are the mech — they go with it, unless you are
 * pulling them out to keep, in which case they fall back to being plan-wide.
 */
export function deleteMech(plan: Plan, mechId: string, keepEntities = false): Plan {
  const deleted = plan.mechs.find((beat) => beat.id === mechId);
  const mechs = plan.mechs.filter((m) => m.id !== mechId);
  const deadBaseIds = plan.entities
    .filter((entity) => entity.mech === mechId)
    .map((entity) => entity.id);
  const entities = keepEntities
    ? plan.entities.map((e) => (e.mech === mechId ? ({ ...e, mech: undefined } as Entity) : e))
    : withoutEntities(plan.entities, deadBaseIds);
  const beatVariants = new Set(deleted?.variants.map((variant) => variant.id) ?? []);
  const steps = plan.steps.map((step) => {
    const legacy = step.variantScenes
      ? {
          ...step,
          variantScenes: Object.fromEntries(
            Object.entries(step.variantScenes).map(([variant, scene]) => [
              variant,
              keepEntities
                ? scene.map((entity) =>
                    entity.mech === mechId ? ({ ...entity, mech: undefined } as Entity) : entity
                  )
                : withoutEntities(
                    scene,
                    scene
                      .filter((entity) => entity.mech === mechId)
                      .map((entity) => entity.id)
                  ),
            ])
          ),
        }
      : step;
    if (!beatVariants.size) return legacy;
    const content = Object.fromEntries(
      Object.entries(legacy.beatVariantContent ?? {}).filter(([id]) => !beatVariants.has(id))
    );
    const movement = Object.fromEntries(
      Object.entries(legacy.beatVariantMovement ?? {}).filter(([id]) => !beatVariants.has(id))
    );
    return {
      ...legacy,
      beatVariantContent: Object.keys(content).length ? content : undefined,
      beatVariantMovement: Object.keys(movement).length ? movement : undefined,
    };
  });
  const variantRoutes = plan.variantRoutes?.map((route) => {
    const selections = { ...route.selections };
    delete selections[mechId];
    return { ...route, selections };
  });
  return touch({ ...plan, mechs, entities, steps, variantRoutes });
}

/** Move existing shapes into a mech, or (with `null`) out of whatever holds them. */
export function assignMech(
  plan: Plan,
  ids: string[],
  mechId: string | null,
  stepId?: string,
  variantId?: string
): Plan {
  if (mechId && !plan.mechs.some((m) => m.id === mechId)) throw new Error(`No mech ${mechId}`);
  const want = new Set(ids);
  if (stepId && variantId) {
    if (plan.variantModel === "beat") {
      const detached = beatContentForEdit(plan, stepId, variantId);
      if (mechId !== detached.beat.id)
        throw new Error("A Variant Part cannot leave or change its owning Beat");
      for (const id of ids)
        if (!detached.content.parts.some((part) => part.id === id))
          throw new Error(`No Part ${id} in this Beat Variant Step`);
      // Already owned by this Beat; persisting the content boundary is the
      // only meaningful effect of assigning it again.
      return touch(detached.plan);
    }
    const markerIds = new Set(
      plan.entities
        .filter((entity) => want.has(entity.id) && entity.type === "marker")
        .map((entity) => entity.id)
    );
    const sceneIds = ids.filter((id) => !markerIds.has(id));
    const withScene = sceneIds.length
      ? (() => {
          const detached = sceneForEdit(plan, stepId, variantId);
          const scene = detached.scene.map((entity) =>
            want.has(entity.id) ? ({ ...entity, mech: mechId ?? undefined } as Entity) : entity
          );
          return replaceVariantScene(detached.plan, stepId, variantId, scene);
        })()
      : plan;
    const entities = withScene.entities.map((entity) =>
      markerIds.has(entity.id) ? ({ ...entity, mech: mechId ?? undefined } as Entity) : entity
    );
    return touch({ ...withScene, entities });
  }
  const entities = plan.entities.map((e) =>
    want.has(e.id) ? ({ ...e, mech: mechId ?? undefined } as Entity) : e,
  );
  return touch({ ...plan, entities });
}

/* -------------------------------------------------------------- convenience */

/** `null` is the explicit wire value for removing an optional backdrop. */
export type ArenaPatch = Omit<Partial<Arena>, "image" | "widthYalms"> & {
  image?: string | null;
  /** Null clears a manual override and returns to known/default calibration. */
  widthYalms?: number | null;
};

export function setArena(plan: Plan, patch: ArenaPatch): Plan {
  const clearImage = patch.image === null;
  const clearWidthYalms = patch.widthYalms === null;
  const { image: _oldImage, ...arenaWithoutImage } = plan.arena;
  const { widthYalms: _oldWidthYalms, ...arenaWithoutWidthYalms } = plan.arena;
  const clean = defined(patch);
  if (clearImage) delete clean.image;
  if (clearWidthYalms) delete clean.widthYalms;
  const base = clearImage && clearWidthYalms
    ? (({ image: _image, widthYalms: _width, ...rest }) => rest)(plan.arena)
    : clearImage
      ? arenaWithoutImage
      : clearWidthYalms
        ? arenaWithoutWidthYalms
        : plan.arena;
  const arena = ArenaSchema.parse({
    ...base,
    ...clean,
    grid: { ...plan.arena.grid, ...defined(patch.grid) },
  });
  return touch({ ...plan, arena });
}

/**
 * The standard waymark set, clockwise from north: A, 2, B, 3, C, 4, D, 1 —
 * letters on the cardinals, numbers in the quadrants reading 1 = NW clockwise.
 */
export const STANDARD_WAYMARKS = ["A", "2", "B", "3", "C", "4", "D", "1"] as const;

/**
 * How far out the standard waymarks go, as a fraction of the arena's half-width.
 * The PF clock uses it too: a party in PF positions stands on the marks, which
 * is the whole point of calling them positions.
 */
export const WAYMARK_SPREAD = 0.8;

/**
 * Where the PF clock puts people: the same ring, a little inside it. Standing
 * exactly on a mark hides the mark under the token, and the mark is the thing
 * the plan is talking about.
 */
export const PF_SPREAD = WAYMARK_SPREAD - 0.1;

/**
 * Place the 8 standard waymarks. Markers the plan already has are *moved* into
 * position rather than skipped, so this doubles as a "reset to standard" button.
 */
export function addWaymarks(plan: Plan, distance = WAYMARK_SPREAD): Plan {
  return placeMarkers(
    plan,
    STANDARD_WAYMARKS.map((marker, i) => {
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
      return {
        marker,
        x: Math.round(Math.cos(a) * (plan.arena.width / 2) * distance),
        y: Math.round(Math.sin(a) * (plan.arena.height / 2) * distance),
      };
    })
  );
}

/** Move the named waymarks into place, adding any the plan does not have yet. */
function placeMarkers(plan: Plan, markers: EncounterSetup["markers"]): Plan {
  let next = plan;
  for (const m of markers) {
    const existing = findEntities(next, { type: "marker" }).find(
      (e) => (e as { marker: string }).marker === m.marker
    );
    const pose = { x: m.x, y: m.y, ...(m.size ? { size: m.size } : {}) };
    next = existing
      ? updateEntity(next, existing.id, pose).plan
      : addEntity(next, { type: "marker", ...m }).plan;
  }
  return next;
}

/** The floor of this plan: its arena, and where its waymarks sit. */
export function encounterSetup(plan: Plan): EncounterSetup {
  return EncounterSetupSchema.parse({
    arena: plan.arena,
    markers: findEntities(plan, { type: "marker" }).map((e) => ({
      marker: (e as { marker: string }).marker,
      x: e.x,
      y: e.y,
      size: (e as { size?: number }).size,
    })),
  });
}

/**
 * Stamp a saved encounter onto a plan: same floor, same waymarks, in the same
 * places. Markers the setup does not mention are removed — a fight where you
 * only use A and B should not inherit a stray C from whoever built the plan.
 */
export function applyEncounterSetup(plan: Plan, setup: EncounterSetup): Plan {
  const wanted = new Set<MarkerId>(setup.markers.map((m) => m.marker));
  const strays = findEntities(plan, { type: "marker" })
    .filter((e) => !wanted.has((e as { marker: MarkerId }).marker))
    .map((e) => e.id);
  return placeMarkers(deleteEntities(setArena(plan, setup.arena), strays), setup.markers);
}

/** Add a standard 8-player party, laid out in a ring near the middle. */
export function addParty(
  plan: Plan,
  party: { job: string; name: string }[] = DEFAULT_PARTY,
  radiusFraction = 0.25
): { plan: Plan; ids: string[] } {
  let next = plan;
  const ids: string[] = [];
  const r = (plan.arena.width / 2) * radiusFraction;
  party.forEach((p, i) => {
    const a = (i / party.length) * Math.PI * 2 - Math.PI / 2;
    const res = addEntity(next, {
      type: "player",
      job: p.job,
      name: p.name,
      x: Math.cos(a) * r,
      y: Math.sin(a) * r,
    });
    next = res.plan;
    ids.push(res.entity.id);
  });
  return { plan: next, ids };
}

/**
 * The party-finder clock, clockwise from north. Each slot lists the names that
 * belong in it, so a party built as MT/OT/H1/H2/D1-D4 lands in the right spots.
 */
export const PF_SLOTS: { slot: string; names: string[] }[] = [
  { slot: "MT", names: ["MT", "T1"] },
  { slot: "R2", names: ["R2", "D4"] },
  { slot: "H2", names: ["H2"] },
  { slot: "M2", names: ["M2", "D2"] },
  { slot: "OT", names: ["OT", "T2"] },
  // The melees take the two southern diagonals, behind the boss where they have
  // to stand anyway; the ranged take the northern pair.
  { slot: "M1", names: ["M1", "D1"] },
  { slot: "H1", names: ["H1"] },
  { slot: "R1", names: ["R1", "D3"] },
];

/**
 * Move the players already in the plan onto the PF clock. Anyone whose name
 * doesn't name a slot fills whatever slots are left, in order.
 */
export function arrangeParty(
  plan: Plan,
  radiusFraction = PF_SPREAD,
  stepId?: string,
  variantId?: string
): { plan: Plan; ids: string[] } {
  if (stepId && variantId && plan.variantModel === "beat") beatAddress(plan, stepId, variantId);
  const wasEdited = stepId && variantId ? variantStepScene(plan, stepId, variantId) !== undefined : false;
  if (stepId && variantId && plan.variantModel !== "beat")
    plan = materializeVariantStep(plan, stepId, variantId);
  const source =
    stepId && variantId && plan.variantModel !== "beat"
      ? variantStepScene(plan, stepId, variantId)!
      : plan.entities;
  const players = source.filter((entity) => entity.type === "player");
  const taken = new Map<number, Entity>();
  const spare: Entity[] = [];
  for (const p of players) {
    const name = (p.name ?? "").toUpperCase();
    const i = PF_SLOTS.findIndex((s, idx) => s.names.includes(name) && !taken.has(idx));
    if (i >= 0) taken.set(i, p);
    else spare.push(p);
  }
  for (let i = 0; i < PF_SLOTS.length && spare.length; i++) {
    if (!taken.has(i)) taken.set(i, spare.shift()!);
  }

  const r = (plan.arena.width / 2) * radiusFraction;
  let next = plan;
  const ids: string[] = [];
  for (const [i, entity] of taken) {
    const a = (i / PF_SLOTS.length) * Math.PI * 2 - Math.PI / 2;
    next = updateEntity(
      next,
      entity.id,
      { x: Math.round(Math.cos(a) * r), y: Math.round(Math.sin(a) * r) },
      stepId,
      variantId
    ).plan;
    ids.push(entity.id);
  }
  // Anyone past the eighth player keeps their position — better than stacking.
  // An empty contextual arrangement is still the variant's first authored scene
  // edit. Persist the copy-on-write boundary even when there was nothing to move.
  if (!ids.length && stepId && variantId && !wasEdited && plan.variantModel !== "beat")
    next = touch(next);
  return { plan: next, ids };
}

/* -------------------------------------------------------------------- baits */

/**
 * Baited mechanics: the shapes that belong to whoever got targeted, rather than
 * to a spot on the floor. Each one is an ordinary entity carrying an `anchor`,
 * so it re-solves itself against the party in every step — move the bait and
 * the beam swings with it, no per-step overrides to keep in sync.
 */
export const BAIT_KINDS = [
  "beam",
  "cone",
  "donut",
  "spread",
  "puddle",
  "stack",
  "linestack",
  "flare",
  "tower",
  "proximity",
  "tether",
] as const;
export type BaitKind = (typeof BAIT_KINDS)[number];

/** Kinds that fire *from* something — they need a source to aim from. */
const AIMED: BaitKind[] = ["beam", "cone", "linestack", "tether"];

/** Does this kind need a source? The editor asks before offering the picker. */
export const baitNeedsSource = (kind: BaitKind) => AIMED.includes(kind);

const BAIT_DEFAULTS: Record<BaitKind, PropBag & { type: EntityType }> = {
  beam: { type: "zone", shape: "rect", width: 160, extend: true },
  cone: { type: "zone", shape: "cone", angle: 60, radius: 500, extend: true },
  donut: { type: "zone", shape: "donut", innerRadius: 150, radius: 450 },
  spread: { type: "zone", shape: "spread", radius: 120 },
  puddle: { type: "zone", shape: "circle", radius: 200 },
  stack: { type: "zone", shape: "stack", radius: 200, soak: 4 },
  linestack: { type: "zone", shape: "linestack", width: 120, soak: 4, extend: true },
  flare: { type: "zone", shape: "flare", radius: 320 },
  tower: { type: "zone", shape: "tower", radius: 140, soak: 1 },
  proximity: { type: "zone", shape: "proximity", radius: 250 },
  tether: { type: "tether", style: "line" },
};

/**
 * The entity spec for one baited primitive.
 *
 * `target` is either an entity id — this player, always — or a rule, in which
 * case the bait picks its own victim every time the plan is drawn. A tether is
 * the one kind that cannot float: it is two endpoints by definition, so a rule
 * is resolved once, at authoring time, by the caller.
 */
export function baitSpec(
  kind: BaitKind,
  target: string | { pick: BaitRule; rank?: number; of?: "player" | "enemy" | "any" },
  sourceId: string | undefined,
  props: PropBag = {}
): PropBag & { type: EntityType } {
  if (AIMED.includes(kind) && !sourceId)
    throw new Error(`A ${kind} bait needs "from": the enemy or object it comes out of`);
  const { extend, ...base } = BAIT_DEFAULTS[kind];
  const spec = { ...base, ...definedProps(props) } as PropBag & { type: EntityType };
  if (kind === "tether") {
    if (typeof target !== "string")
      throw new Error("A tether needs a named target — tether both ends, or use another kind");
    return { ...spec, from: sourceId, to: target };
  }
  spec.anchor = {
    ...(typeof target === "string"
      ? { to: target }
      : { pick: target.pick, rank: target.rank ?? 1, of: target.of ?? "player" }),
    // Aimed kinds fire *from* the source; the rest merely rank their targets by
    // distance to it, which is what "baited off that orb" means for a puddle.
    ...(AIMED.includes(kind) ? { from: sourceId } : sourceId ? { near: sourceId } : {}),
    extend: (props.extend as boolean | undefined) ?? extend ?? false,
  };
  return spec;
}

/* ----------------------------------------------------------------- palette */

/**
 * The things you drag onto the arena. Deliberately short: these are the
 * mechanics a plan is actually made of, and each one means something different
 * depending on what you drop it on — a player group, an enemy source, bare floor.
 */
export const PALETTE = [
  "boss",
  "add",
  "circle",
  "donut",
  "protean",
  "beam",
  "stack8",
  "stack4",
  "stack2",
  "linestack",
  "flare",
  "together",
  "apart",
  "anchor",
] as const;
export type PaletteKind = (typeof PALETTE)[number];
export type PaletteSourceKind = Extract<PaletteKind, "boss" | "add" | "anchor">;
export type PaletteMechanicKind = Exclude<PaletteKind, PaletteSourceKind>;

export const isPaletteSource = (kind: PaletteKind): kind is PaletteSourceKind =>
  kind === "boss" || kind === "add" || kind === "anchor";

export const isPaletteTether = (kind: PaletteKind): kind is Extract<PaletteKind, "together" | "apart"> =>
  kind === "together" || kind === "apart";

export const PALETTE_LABEL: Record<PaletteKind, string> = {
  boss: "Boss",
  add: "Add",
  circle: "Circle",
  donut: "Donut",
  protean: "Protean",
  beam: "Beam",
  stack8: "Stack ×8",
  stack4: "Stack ×4",
  stack2: "Stack ×2",
  linestack: "Line stack",
  flare: "Flare",
  together: "Together tether",
  apart: "Go-far tether",
  anchor: "Bait anchor",
};

/** Physical thresholds used whenever a player tether is created from the palette. */
export const PALETTE_TETHER_RANGE_YALMS = { together: 8, apart: 25 } as const;

export const PALETTE_HINT: Record<PaletteKind, string> = {
  boss: "A large enemy. Drop mechanics on it to use it as their source.",
  add: "A medium enemy. Drop mechanics on it to use it as their source.",
  circle: "A desolation: a circle AoE. Drop it on a group to give each of them one.",
  donut: "A donut AoE: everything but the hole. Drop it on somebody to have it centred on them.",
  protean: "A narrow cone per player, thrown from the boss.",
  beam: "A line AoE from the boss through whoever it is aimed at.",
  stack8: "A full-party stack on somebody: everyone piles in.",
  stack4: "A light-party stack: four people share it.",
  stack2: "A pair stack: two people share it.",
  linestack: "A line stack: a beam from the boss that several people line up in.",
  flare: "A flare: a big circle on somebody, who carries it away from the others.",
  together: `A player tether whose inward chevrons turn green within ${PALETTE_TETHER_RANGE_YALMS.together} yalms. Drop it on one player, then click the other.`,
  apart: `A player tether whose outward chevrons turn green at ${PALETTE_TETHER_RANGE_YALMS.apart} yalms. Drop it on one player, then click the other.`,
  anchor: "A point mechanics come out of that is not the boss — an add, an orb, a portal.",
};

/** Which bait preset each palette kind becomes once it is bound to somebody. */
const PALETTE_BAIT: Record<PaletteMechanicKind, { kind: BaitKind; props: PropBag }> = {
  circle: { kind: "puddle", props: { radius: 200 } },
  donut: { kind: "donut", props: { radius: 450, innerRadius: 150 } },
  protean: { kind: "cone", props: { angle: 30 } },
  beam: { kind: "beam", props: { width: 160 } },
  stack8: { kind: "stack", props: { radius: 160, soak: 8 } },
  stack4: { kind: "stack", props: { radius: 160, soak: 4 } },
  stack2: { kind: "stack", props: { radius: 140, soak: 2 } },
  linestack: { kind: "linestack", props: { width: 120, soak: 4 } },
  flare: { kind: "flare", props: { radius: 320 } },
  together: { kind: "tether", props: { style: "close", range: 200 } },
  apart: { kind: "tether", props: { style: "far", range: 625 } },
};

/** A palette item dropped on bare floor: an enemy or a shape you place and move yourself. */
const PALETTE_FREE: Record<PaletteKind, PropBag & { type: EntityType }> = {
  boss: { type: "enemy", role: "enemy", icon: "actor/boss", size: 140 },
  add: { type: "enemy", role: "enemy", icon: "actor/enemy", size: 90 },
  circle: { type: "zone", shape: "circle", radius: 200 },
  donut: { type: "zone", shape: "donut", radius: 300, innerRadius: 120 },
  protean: { type: "zone", shape: "cone", angle: 30, radius: 500 },
  beam: { type: "zone", shape: "rect", width: 160, length: 600 },
  stack8: { type: "zone", shape: "stack", radius: 160, soak: 8 },
  stack4: { type: "zone", shape: "stack", radius: 160, soak: 4 },
  stack2: { type: "zone", shape: "stack", radius: 140, soak: 2 },
  linestack: { type: "zone", shape: "linestack", width: 120, length: 600, soak: 4 },
  flare: { type: "zone", shape: "flare", radius: 320 },
  // Player tethers are authored by dropping on Supports or Damagers. These
  // placeholders only make the palette's free-spec table exhaustive; the
  // editor rejects a floor/source drop before it reaches this table.
  together: { type: "tether", from: "", to: "", style: "close", range: 200 },
  apart: { type: "tether", from: "", to: "", style: "far", range: 625 },
  anchor: { type: "enemy", role: "anchor", size: 60, ring: false, showFacing: false },
};

export const paletteNeedsSource = (kind: PaletteKind) =>
  !isPaletteSource(kind) && baitNeedsSource(PALETTE_BAIT[kind].kind);

/** A free-standing shape at a point on the floor. */
export function paletteSpec(kind: PaletteKind, props: PropBag = {}): PropBag & { type: EntityType } {
  return { ...PALETTE_FREE[kind], ...defined(props) };
}

/** The same palette item, bound: on a named target, or on whoever is nearest. */
export function paletteBait(
  kind: PaletteMechanicKind,
  target: string | { pick: BaitRule; rank?: number; of?: "player" | "enemy" | "any" },
  sourceId: string | undefined,
  props: PropBag = {}
): PropBag & { type: EntityType } {
  const preset = PALETTE_BAIT[kind];
  return baitSpec(preset.kind, target, sourceId, { ...preset.props, ...props });
}

/* ------------------------------------------------------------------ resize */

/** Rect-ish shapes are sized by their footprint, everything else by radius. */
const BOXY = ["rect", "line", "arrow", "knockback", "linestack"];

/**
 * What "make this bigger" multiplies, per entity. It is the real dimensions
 * rather than `scale`, so the numbers in the plan keep saying what they mean —
 * a 20-yalm donut stays a donut with a radius you can read.
 */
function sizeFields(entity: Entity): string[] {
  switch (entity.type) {
    case "zone":
      return BOXY.includes(entity.shape) ? ["width", "length"] : ["radius", "innerRadius"];
    case "tether":
      // A tether's meaningful size is the distance its mechanic requires. Its
      // stroke is presentation, so the wheel must not make the rope fatter.
      return ["range"];
    case "path":
      return ["width"];
    default:
      return ["size"];
  }
}

/** Nothing may be scrolled out of existence, or off the edge of the world. */
const clampSize = (v: number, min: number) => Math.max(min, Math.min(4000, Math.round(v)));

/** The patch that resizes an entity by a factor — 1.1 is ten percent bigger. */
export function resizeSpec(entity: Entity, factor: number): PropBag {
  const props = entity as unknown as Record<string, number | undefined>;
  const patch: PropBag = {};
  for (const key of sizeFields(entity)) {
    const value = props[key];
    if (typeof value !== "number") continue;
    // A donut hole of zero is a circle, which is a legitimate thing to shrink to.
    patch[key] = clampSize(value * factor, key === "innerRadius" ? 0 : 4);
  }
  return patch;
}

function definedProps(props: PropBag): PropBag {
  const { extend: _drop, ...rest } = props;
  return defined(rest);
}

/* ------------------------------------------------------------- descriptions */

const ordinal = (n: number) => ["", "", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"][n] ?? `${n}th`;

function describeEntity(plan: Plan, e: Entity, scene: Entity[] = plan.entities): string {
  const label = e.name ? `"${e.name}"` : "";
  const who = (id: string) => scene.find((candidate) => candidate.id === id)?.name ?? id;
  // An anchored entity has no pose of its own — reporting coordinates for it
  // would be reporting whatever it was authored with, not where it will land.
  const whom = (a: NonNullable<Entity["anchor"]>) =>
    a.pick
      ? `the ${a.rank > 1 ? `${ordinal(a.rank)} ` : ""}${a.pick} ${a.of === "any" ? "entity" : a.of}` +
        (a.from ? ` to ${who(a.from)}` : "")
      : who(a.to);
  const at = e.anchor
    ? e.anchor.from
      ? `aimed from ${who(e.anchor.from)} at ${whom(e.anchor)}${e.anchor.extend ? ", to the wall" : ""}`
      : `on ${whom(e.anchor)}`
    : `at (${Math.round(e.x)}, ${Math.round(e.y)}) ${pointToCompass(e.x, e.y)}`;
  switch (e.type) {
    case "marker":
      return `waymark ${e.marker} ${at}`;
    case "player":
      return `player ${jobLabel(e.job)} ${label} ${at}${e.showFacing ? `, facing ${Math.round(e.rotation)}°` : ""}`;
    case "enemy":
      return `enemy ${label} r=${Math.round(e.size)} ${at}, facing ${Math.round(e.rotation)}°`;
    case "zone": {
      const geo =
        e.shape === "cone"
          ? `${Math.round(e.angle)}° cone r=${Math.round(e.radius)}`
          : e.shape === "donut"
            ? `donut ${Math.round(e.innerRadius)}–${Math.round(e.radius)}`
            : e.shape === "rect" || e.shape === "line" || e.shape === "knockback" || e.shape === "arrow"
              ? `${e.shape} ${Math.round(e.width)}x${Math.round(e.length)}`
              : `${e.shape} r=${Math.round(e.radius)}`;
      const facing = e.anchor ? "" : `, facing ${Math.round(e.rotation)}°`;
      return `zone ${geo} ${label} ${at}${facing}`;
    }
    case "tether":
      return `tether ${e.style} ${who(e.from)} → ${who(e.to)}`;
    case "text":
      return `text "${e.text}" ${at}`;
    case "path":
      return `path ${e.points.length / 2} points from ${at}`;
    case "icon":
      return `icon ${label} ${at}`;
  }
}

/**
 * Who a zone catches, appended to its line. A player's hitbox is a point, so
 * this is the answer to "is that clipping D2?" — which the coordinates alone
 * make you compute in your head, and the picture makes you guess at.
 */
function describeHits(e: Entity, items: Entity[]): string {
  if (e.type !== "zone" || e.shape === "arrow") return "";
  const hit = items.filter((o) => o.type === "player" && zoneCovers(e, o.x, o.y));
  return hit.length ? ` — hits ${hit.map((h) => h.name ?? h.id).join(", ")}` : " — hits nobody";
}

/** Compact, model-readable rendering of a plan — what `read_plan` returns. */
export function describePlan(
  plan: Plan,
  stepId?: string,
  shown?: Record<string, string>
): string {
  const lines: string[] = [];
  lines.push(`# ${plan.name}${plan.encounter ? ` — ${plan.encounter}` : ""} (${plan.id}, rev ${plan.rev})`);
  if (plan.description) lines.push(plan.description);
  lines.push(
    `Arena: ${plan.arena.shape} ${plan.arena.width}x${plan.arena.height}, grid ${plan.arena.grid.type}. ` +
      `Origin is the centre; +x east, +y south; rotation 0 = north, clockwise.`
  );
  const steps = stepId ? plan.steps.filter((s) => s.id === stepId) : plan.steps;
  // The outline the steps hang off: which section of the fight this run of
  // steps is, and which reading of it. Printed as it changes, so the document
  // reads down the page the way the rail does.
  let section = "";
  for (const step of steps) {
    const here = step.mechanic ?? "";
    if (here !== section) {
      section = here;
      const mechanic = plan.mechanics.find((m) => m.id === step.mechanic);
      if (mechanic) {
        lines.push("", `## Mechanic: ${mechanicLabel(plan, mechanic)} [${mechanic.id}]`);
        if (mechanic.variants.length) {
          const requested = shown?.[mechanic.id];
          const reading =
            mechanic.variants.find((variant) => variant.id === requested) ?? mechanic.variants[0];
          lines.push(
            `Goes ${mechanic.variants
              .map((v) => `${variantLabel(mechanic, v.id)} [${v.id}]`)
              .join(" / ")} — same steps either way; the casts and the party's positions differ. Read as ${variantLabel(mechanic, reading.id)}.`
          );
        }
      }
    }
    lines.push("");
    lines.push(`## Step ${plan.steps.indexOf(step) + 1}: ${step.name} [${step.id}]`);
    if (step.notes) lines.push(`Notes: ${step.notes}`);
    // Which casts are in the air here, and whether this is the step one lands in.
    const stepMechanic = plan.mechanics.find((mechanic) => mechanic.id === step.mechanic);
    const requested = stepMechanic ? shown?.[stepMechanic.id] : undefined;
    const reading = stepMechanic?.variants.length
      ? (stepMechanic.variants.find((variant) => variant.id === requested) ?? stepMechanic.variants[0]).id
      : undefined;
    const live = plan.mechs.filter(
      (m) => mechSpan(plan, m).includes(step.id) && (!m.variant || m.variant === reading)
    );
    if (live.length)
      lines.push(
        "Mechs: " +
          live
            .map(
              (m) =>
                `${mechLabel(plan, m)} [${m.id}]${m.variant ? " (one reading only)" : ""} ${
                  m.boom === step.id ? (m.snap === step.id ? "snapshots and goes off here" : "goes off here") : m.snap === step.id ? "snapshots here" : "in the air"
                }`
            )
            .join("; ")
      );
    const items = entitiesForStep(plan, step.id, undefined, shown);
    if (!items.length) lines.push("(empty)");
    for (const e of items) {
      const base = plan.entities.find((b) => b.id === e.id);
      const moved = base?.overrides?.[step.id] ? " *" : "";
      lines.push(`- [${e.id}]${moved} ${describeEntity(plan, e, items)}${describeHits(e, items)}`);
    }
  }
  if (!stepId && plan.steps.length > 1) lines.push("", "(* = entity has a pose override in that step)");
  return lines.join("\n");
}

export { entitiesForStep, resolveEntity };
