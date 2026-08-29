import {
  EntitySchema,
  authoredEntitiesForStep,
  isBeatPart,
  mechSpan,
  type BeatVariantPose,
  type Entity,
  type Plan,
  type Step,
  type StepVariant,
} from "./schema";

export interface StepVariantOwner {
  step: Step;
  variant: StepVariant;
}

export interface ActiveStepVariant extends StepVariantOwner {
  /** The Step that declares this mutually exclusive box set. */
  ownerStepId: string;
}

export interface StepVariantMovementConflict {
  actorId: string;
  ownerStepIds: string[];
  variantIds: string[];
}

export interface StepVariantComposition {
  entities: Entity[];
  conflicts: StepVariantMovementConflict[];
}

export function stepVariants(step: Step | undefined): StepVariant[] {
  return step?.variants ?? [];
}

export function stepVariantOwner(plan: Plan, variantId: string): StepVariantOwner | undefined {
  for (const step of plan.steps) {
    const variant = stepVariants(step).find((candidate) => candidate.id === variantId);
    if (variant) return { step, variant };
  }
  return undefined;
}

export function stepVariantLabel(step: Step, variantId: string): string {
  const variants = stepVariants(step);
  const index = variants.findIndex((candidate) => candidate.id === variantId);
  return index < 0 ? "?" : variants[index].name || String.fromCharCode(65 + index);
}

export function defaultStepVariantSelections(plan: Plan): Record<string, string> {
  const route = plan.variantRoutes?.find((candidate) => candidate.id === plan.defaultVariantRoute);
  return route ? route.selections : {};
}

/** Every Beat owned by any Step Variant box. Everything else is Shared. */
export function boxedBeatIds(plan: Plan): Set<string> {
  return new Set(plan.steps.flatMap((step) => stepVariants(step).flatMap((variant) => variant.beats)));
}

/**
 * A split is present anywhere one of its contained Beats is on the timeline,
 * or where the selected box owns actor movement. An empty new split exists at
 * its declaring Step so it can be authored before it contains a Beat.
 */
export function stepVariantSetIncludes(plan: Plan, owner: Step, stepId: string): boolean {
  const variants = stepVariants(owner);
  if (variants.length < 2) return false;
  const start = plan.steps.findIndex((step) => step.id === owner.id);
  const end = plan.steps.findIndex((step) => step.id === (owner.variantEnd || owner.id));
  const here = plan.steps.findIndex((step) => step.id === stepId);
  if (here >= Math.min(start, end) && here <= Math.max(start, end)) return true;
  const beatIds = new Set(variants.flatMap((variant) => variant.beats));
  if (plan.mechs.some((beat) => beatIds.has(beat.id) && mechSpan(plan, beat).includes(stepId)))
    return true;
  const movement = plan.steps.find((step) => step.id === stepId)?.stepVariantMovement ?? {};
  return variants.some((variant) => Object.keys(movement[variant.id] ?? {}).length > 0);
}

export function activeStepVariants(
  plan: Plan,
  stepId: string,
  shown: Record<string, string> = {},
): ActiveStepVariant[] {
  if (plan.variantModel !== "step") return [];
  const selected = { ...defaultStepVariantSelections(plan), ...shown };
  return plan.steps.flatMap((owner) => {
    const variants = stepVariants(owner);
    if (variants.length < 2 || !stepVariantSetIncludes(plan, owner, stepId)) return [];
    const requested = selected[owner.id];
    const variant = variants.find((candidate) => candidate.id === requested) ?? variants[0];
    return variant ? [{ step: owner, ownerStepId: owner.id, variant }] : [];
  });
}

export function stepVariantMovement(
  plan: Plan,
  stepId: string,
  variantId: string,
): Record<string, BeatVariantPose> {
  return plan.steps.find((step) => step.id === stepId)?.stepVariantMovement?.[variantId] ?? {};
}

/** Resolve Shared Beats plus exactly one child box from every active split. */
export function composeStepVariantEntities(
  plan: Plan,
  stepId: string | undefined,
  shown: Record<string, string> = {},
): StepVariantComposition {
  const base = authoredEntitiesForStep(plan, stepId);
  if (plan.variantModel !== "step" || !stepId) return { entities: base, conflicts: [] };

  const active = activeStepVariants(plan, stepId, shown);
  const boxed = boxedBeatIds(plan);
  const selectedBeats = new Set(active.flatMap(({ variant }) => variant.beats));
  const entities = base.filter(
    (entity) =>
      !isBeatPart(entity) ||
      !entity.mech ||
      !boxed.has(entity.mech) ||
      selectedBeats.has(entity.mech),
  );

  const movesByActor = new Map<
    string,
    { ownerStepId: string; variantId: string; pose: BeatVariantPose }[]
  >();
  for (const { ownerStepId, variant } of active) {
    for (const [actorId, pose] of Object.entries(stepVariantMovement(plan, stepId, variant.id))) {
      const moves = movesByActor.get(actorId) ?? [];
      moves.push({ ownerStepId, variantId: variant.id, pose });
      movesByActor.set(actorId, moves);
    }
  }

  const conflicts: StepVariantMovementConflict[] = [];
  const composed = entities.map((entity) => {
    const moves = movesByActor.get(entity.id);
    if (!moves?.length) return entity;
    if (moves.length === 1) {
      const { compatibilityState, ...pose } = moves[0].pose;
      return EntitySchema.parse({ ...entity, ...compatibilityState, ...pose });
    }
    conflicts.push({
      actorId: entity.id,
      ownerStepIds: moves.map((move) => move.ownerStepId),
      variantIds: moves.map((move) => move.variantId),
    });
    return entity;
  });
  return { entities: composed, conflicts };
}

export function validateStepVariantSelections(
  plan: Plan,
  selections: Record<string, string>,
): string[] {
  if (plan.variantModel !== "step") return ["This plan does not use Step Variants"];
  const errors: string[] = [];
  for (const step of plan.steps) {
    const variants = stepVariants(step);
    if (variants.length < 2) continue;
    const selected = selections[step.id];
    if (!selected) errors.push(`Missing Variant choice for ${step.name || step.id}`);
    else if (!variants.some((variant) => variant.id === selected))
      errors.push(`No Variant ${selected} on ${step.name || step.id}`);
  }
  for (const ownerId of Object.keys(selections)) {
    if (!plan.steps.some((step) => step.id === ownerId && stepVariants(step).length >= 2))
      errors.push(`No varying Step ${ownerId}`);
  }
  for (const step of plan.steps) {
    const conflicts = composeStepVariantEntities(plan, step.id, selections).conflicts;
    for (const conflict of conflicts)
      errors.push(
        `${step.name || step.id}: actor ${conflict.actorId} is moved by ${conflict.ownerStepIds.length} active Variant boxes`,
      );
  }
  return errors;
}
