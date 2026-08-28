/**
 * Who edits what, inside one plan.
 *
 * A master plan holds everybody's reading of the same fight: one mechanic, a
 * variant per person. What a variant owns is where people stand in it and which
 * casts happen in it — so those are the edits that belong to whoever owns the
 * variant, and nobody else. Everything else about the plan (its steps, its
 * sections, the shapes that happen whichever way it goes) stays as it was:
 * anyone who can edit the plan can edit those.
 *
 * The plan's owner is not bound by any of this. It is their plan.
 *
 * Enforced on the server because the browser is not the only way in: the same
 * check runs for the REST ops endpoint and for the MCP tools.
 */
import { type Op, validateOpContext } from "../shared/apply";
import {
  authoredEntitiesForStep,
  poseStep,
  type Entity,
  type Mech,
  type Plan,
  type PlanRole,
} from "../shared/schema";

export interface Caller {
  id: string;
  name?: string;
}

/** A variant's owner, or undefined for one that belongs to the plan itself. */
function ownerOf(plan: Plan, variantId: string | undefined): string | undefined {
  if (!variantId) return undefined;
  for (const mechanic of plan.mechanics)
    for (const variant of mechanic.variants)
      if (variant.id === variantId) return variant.ownerId;
  return undefined;
}

/** What a variant is called, for saying no in words that mean something. */
function labelOf(plan: Plan, variantId: string): string {
  for (const mechanic of plan.mechanics) {
    const i = mechanic.variants.findIndex((v) => v.id === variantId);
    if (i >= 0)
      return `${mechanic.variants[i].name || String.fromCharCode(65 + i)}${
        mechanic.name ? ` of ${mechanic.name}` : ""
      }`;
  }
  return variantId;
}

const mechOf = (plan: Plan, id: string | null | undefined): Mech | undefined =>
  id ? plan.mechs.find((m) => m.id === id) : undefined;

/** Resolve a target from the exact authored scene the operation addresses. */
function entityOf(
  plan: Plan,
  id: string,
  stepId?: string,
  variantId?: string
): Entity | undefined {
  return stepId && variantId
    ? authoredEntitiesForStep(plan, stepId, variantId).find((entity) => entity.id === id)
    : plan.entities.find((entity) => entity.id === id);
}

const entityVariant = (plan: Plan, entity: Entity | undefined): string | undefined =>
  entity?.type === "marker" ? undefined : mechOf(plan, entity?.mech)?.variant;

/**
 * Every variant one op reaches into. A cast gated to a reading is that
 * reading's, so touching the cast is touching the reading — including taking it
 * out again, which is why a gate change counts on both sides.
 */
function variantsTouched(plan: Plan, op: Op): (string | undefined)[] {
  switch (op.op) {
    case "update_entity":
    case "clear_override":
    case "duplicate_entity":
    case "reorder_entity": {
      const entity = entityOf(plan, op.id, op.stepId, op.variant);
      return entity?.type === "marker"
        ? []
        : [
            op.variant,
            entityVariant(plan, entity),
            op.op === "update_entity"
              ? mechOf(plan, (op.patch as { mech?: string }).mech)?.variant
              : undefined,
          ];
    }
    case "arrange_party": {
      const entities = op.stepId && op.variant
        ? authoredEntitiesForStep(plan, op.stepId, op.variant)
        : plan.entities;
      return [
        op.variant,
        ...entities
          .filter((entity) => entity.type === "player")
          .map((entity) => entityVariant(plan, entity)),
      ];
    }
    case "duplicate_step": {
      const step = plan.steps.find((candidate) => candidate.id === op.stepId);
      return Object.keys(step?.variantScenes ?? {});
    }
    case "delete_step": {
      const step = plan.steps.find((candidate) => candidate.id === op.stepId);
      if (!step) return [];
      const lastInMechanic =
        !!step.mechanic &&
        plan.steps.filter((candidate) => candidate.mechanic === step.mechanic).length === 1;
      const affectedMechs = plan.mechs.filter(
        (mech) => mech.snap === step.id || mech.boom === step.id
      );
      const deadMechs = new Set(
        affectedMechs
          .filter((mech) => mech.snap === step.id && mech.boom === step.id)
          .map((mech) => mech.id)
      );
      const affectedScenes = plan.steps.flatMap((candidate) =>
        Object.entries(candidate.variantScenes ?? {})
          .filter(([, scene]) =>
            candidate.id === step.id ||
            scene.some(
              (entity) =>
                entity.declaredIn === step.id ||
                (!!entity.mech && deadMechs.has(entity.mech))
            )
          )
          .map(([variant]) => variant)
      );
      const affectedBaseEntities = plan.entities.filter(
        (entity) =>
          entity.type !== "marker" &&
          (
            entity.declaredIn === step.id ||
            (Array.isArray(entity.steps) && entity.steps.includes(step.id)) ||
            Object.keys(entity.overrides ?? {}).some((key) => poseStep(key) === step.id)
          )
      );
      return [
        ...Object.keys(step.variantScenes ?? {}),
        ...affectedScenes,
        ...(lastInMechanic
          ? plan.mechanics.find((mechanic) => mechanic.id === step.mechanic)?.variants.map((variant) => variant.id) ?? []
          : []),
        ...affectedMechs.map((mech) => mech.variant),
        ...affectedBaseEntities.map((entity) => entityVariant(plan, entity)),
      ];
    }
    case "update_variant":
    case "delete_variant":
      return [op.variantId];
    case "gate_mech":
      return [op.variant, mechOf(plan, op.mechId)?.variant];
    case "update_mech":
      return [
        mechOf(plan, op.mechId)?.variant,
        (op.patch as { variant?: string }).variant,
      ];
    case "delete_mech":
      return [mechOf(plan, op.mechId)?.variant];
    case "assign_mech": {
      const entities = op.ids.map((id) => entityOf(plan, id, op.stepId, op.variant));
      const nonMarkers = entities.filter((entity) => entity?.type !== "marker");
      return [
        nonMarkers.length ? op.variant : undefined,
        mechOf(plan, op.mechId)?.variant,
        // Taken out of whichever cast they were in, too.
        ...nonMarkers.map((entity) => entityVariant(plan, entity)),
      ];
    }
    case "add_entity":
      return op.spec.type === "marker"
        ? []
        : [op.variant, mechOf(plan, (op.spec as { mech?: string }).mech)?.variant];
    case "delete_entities": {
      const entities = op.ids.map((id) => entityOf(plan, id, op.stepId, op.variant));
      const nonMarkers = entities.filter((entity) => entity?.type !== "marker");
      return nonMarkers.length
        ? [op.variant, ...nonMarkers.map((entity) => entityVariant(plan, entity))]
        : [];
    }
    case "delete_mechanic":
      return plan.mechanics.find((m) => m.id === op.mechanicId)?.variants.map((v) => v.id) ?? [];
    default:
      return [];
  }
}

/**
 * Refuse the ops that reach into somebody else's reading. Returns the ops to
 * apply, with the server's own word for who is claiming a new variant — the
 * client does not get to say whose it is.
 */
export function guardVariants(
  plan: Plan,
  ops: Op | Op[],
  caller: Caller | null,
  role: PlanRole,
  deny: (message: string) => Error
): Op[] {
  const list = Array.isArray(ops) ? ops : [ops];
  const stamped = list.map((op) => {
    if (op.op === "add_variant")
      return { ...op, ownerId: caller?.id, ownerName: caller?.name };
    if (op.op === "add_beat_variant" || op.op === "duplicate_beat_variant")
      return { ...op, createdBy: caller?.id, createdByName: caller?.name };
    return op;
  });
  for (const op of stamped) validateOpContext(plan, op);
  if (role !== "owner" && stamped.some((op) => op.op === "collapse_beat_variants"))
    throw deny("Only the plan owner can collapse Variants into Shared content");
  if (role === "owner") return stamped;
  for (const op of stamped)
    for (const id of variantsTouched(plan, op)) {
      const owner = ownerOf(plan, id);
      if (owner && owner !== caller?.id)
        throw deny(`“${labelOf(plan, id!)}” is someone else's reading — ask them, or add your own`);
    }
  return stamped;
}
