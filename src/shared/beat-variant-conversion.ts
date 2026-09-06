import { nanoid } from "nanoid";
import {
  EntitySchema,
  PlanSchema,
  authoredEntitiesForStep,
  beatVariantLabel,
  entitiesForStep,
  entityInStep,
  isActor,
  isBeatPart,
  mechanicLabel,
  mechLabel,
  mechSpan,
  resolveEntity,
  validateBeatVariantSelections,
  type BeatVariantContent,
  type BeatVariantPose,
  type BeatVariantRoute,
  type Entity,
  type Mech,
  type Mechanic,
  type Plan,
  type Variant,
} from "./schema";

export interface ConversionMismatch {
  route: string;
  stepId: string;
  stepName: string;
  reason: string;
}

export interface LegacyConversionReport {
  convertible: boolean;
  sourcePlanId: string;
  sourceRev: number;
  legacyMechanics: number;
  legacyVariants: number;
  varyingBeats: number;
  sharedBeats: number;
  movementBeats: number;
  compatibilityActorStates: number;
  routes: number;
  comparisons: number;
  errors: string[];
  warnings: string[];
  mismatches: ConversionMismatch[];
}

export interface ConversionArchiveInput {
  payload: string;
  sha256: string;
  convertedAt: number;
}

export interface LegacyConversionResult {
  plan?: Plan;
  report: LegacyConversionReport;
}

const fresh = (prefix: string) => `${prefix}_${nanoid(8)}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const actor = isActor;

/** Authored comparisons ignore storage overlays after they have been resolved. */
function contentShape(entity: Entity): Entity {
  return EntitySchema.parse({ ...entity, overrides: {} });
}

function signature(entities: Entity[]): string {
  return JSON.stringify(entities.map(contentShape));
}

function directParts(plan: Plan, beat: Mech, stepId: string): Entity[] {
  return plan.entities
    .filter(
      (entity) =>
        entity.mech === beat.id && isBeatPart(entity) && entityInStep(entity, stepId, plan)
    )
    .map((entity) => contentShape(resolveEntity(entity, stepId)));
}

function variantParts(plan: Plan, beat: Mech, stepId: string, variantId: string): Entity[] {
  return authoredEntitiesForStep(plan, stepId, variantId)
    .filter((entity) => entity.mech === beat.id && isBeatPart(entity))
    .map(contentShape);
}

function unownedParts(plan: Plan, stepId: string, variantId?: string): Entity[] {
  return authoredEntitiesForStep(plan, stepId, variantId)
    .filter((entity) => isBeatPart(entity) && !entity.mech)
    .map(contentShape);
}

function variantsForStep(plan: Plan, stepId: string): Variant[] {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  const mechanic = plan.mechanics.find((candidate) => candidate.id === step?.mechanic);
  return mechanic?.variants ?? [];
}

function sectionOfBeat(plan: Plan, beat: Mech): Mechanic | undefined {
  const sections = new Set(
    mechSpan(plan, beat)
      .map((stepId) => plan.steps.find((step) => step.id === stepId)?.mechanic)
      .filter((id): id is string => !!id)
  );
  if (sections.size !== 1) return undefined;
  return plan.mechanics.find((mechanic) => mechanic.id === [...sections][0]);
}

function routeName(plan: Plan, selection: Record<string, string>): string {
  const labels = plan.mechanics
    .filter((mechanic) => mechanic.variants.length)
    .map((mechanic) => {
      const chosen = selection[mechanic.id];
      const index = mechanic.variants.findIndex((variant) => variant.id === chosen);
      return mechanic.variants[index]?.name || String.fromCharCode(65 + Math.max(0, index));
    });
  return `Legacy ${labels.join(" / ")}`;
}

function cartesianLegacySelections(plan: Plan, errors: string[]): Record<string, string>[] {
  const varying = plan.mechanics.filter((mechanic) => mechanic.variants.length >= 2);
  let selections: Record<string, string>[] = [{}];
  for (const mechanic of varying) {
    selections = selections.flatMap((current) =>
      mechanic.variants.map((variant) => ({ ...current, [mechanic.id]: variant.id }))
    );
    if (selections.length > 256) {
      errors.push("Legacy Variant combinations exceed the safe 256-Route conversion limit");
      return [];
    }
  }
  return selections;
}

/** Properties that have already affected drawing; storage addresses are ignored. */
function renderedShape(entity: Entity): Record<string, unknown> {
  const {
    overrides: _overrides,
    declaredIn: _declaredIn,
    steps: _steps,
    mech: _mech,
    ...visible
  } = entity;
  return visible;
}

function renderedEntities(plan: Plan, stepId: string, shown: Record<string, string>): Record<string, unknown>[] {
  return entitiesForStep(plan, stepId, undefined, shown).map(renderedShape);
}

function firstRenderDifference(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
): string {
  if (before.length !== after.length) return `Entity count changed from ${before.length} to ${after.length}`;
  for (let index = 0; index < before.length; index++) {
    if (same(before[index], after[index])) continue;
    const left = before[index];
    const right = after[index];
    if (left.id !== right.id)
      return `Draw order differs at ${index + 1}: ${String(left.id)} became ${String(right.id)}`;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    const key = [...keys].find((candidate) => !same(left[candidate], right[candidate]));
    return `${String(left.id)} differs at ${key ?? "an unknown property"}: ${JSON.stringify(left[key!])} became ${JSON.stringify(right[key!])}`;
  }
  return "Rendered scene differs";
}

function cleanLegacyOverrides(entity: Entity): Entity {
  return {
    ...entity,
    overrides: Object.fromEntries(
      Object.entries(entity.overrides ?? {}).filter(([key]) => !key.includes("@"))
    ),
  } as Entity;
}

function actorState(entity: Entity): Record<string, unknown> {
  const {
    id: _id,
    type: _type,
    overrides: _overrides,
    steps: _steps,
    declaredIn: _declaredIn,
    mech: _mech,
    x: _x,
    y: _y,
    rotation: _rotation,
    ...state
  } = entity;
  return state;
}

function pose(entity: Entity): { x: number; y: number; rotation: number } {
  return { x: entity.x, y: entity.y, rotation: entity.rotation };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Rev 583 contains four Dark & Light tethers without a Beat. Detached Jury
 * scenes therefore carry those records backwards even though they were
 * declared only on the final Dark & Light Step. Pinning them to a one-Step Beat
 * is the audited source repair used by the original lossless port.
 */
function repairJuryRev583(input: Plan): Plan {
  if (input.id !== "plan_c2b9xZyc" || input.rev !== 583) return input;
  const tetherIds = new Set(
    input.entities
      .filter((entity) =>
        entity.type === "tether" && entity.declaredIn === "step_Syxm14On" && !entity.mech
      )
      .map((entity) => entity.id)
  );
  if (!tetherIds.size) return input;
  const beatId = "mech_jury_tethers_cutover";
  const assign = (entity: Entity): Entity =>
    tetherIds.has(entity.id) ? EntitySchema.parse({ ...entity, mech: beatId }) : entity;
  return PlanSchema.parse({
    ...input,
    mechs: [
      ...input.mechs,
      { id: beatId, name: "Tethers", snap: "step_Syxm14On", boom: "step_Syxm14On", variants: [] },
    ],
    entities: input.entities.map(assign),
    steps: input.steps.map((step) => ({
      ...step,
      variantScenes: step.variantScenes
        ? Object.fromEntries(
            Object.entries(step.variantScenes).map(([variantId, scene]) => [
              variantId,
              (step.id === "step_Syxm14On"
                ? scene.map(assign)
                : scene.filter((entity) => !tetherIds.has(entity.id))),
            ])
          )
        : undefined,
    })),
  });
}

/**
 * Lossless legacy conversion planner and executor.
 *
 * No source write occurs here. Callers omit `target` for a dry-run; an owner
 * endpoint supplies a fresh id plus an immutable archive only after the report
 * is clean, then atomically installs the returned document into a new plan.
 */
export function convertLegacyPlan(
  input: Plan,
  target?: { id: string; ownerId: string; archive: ConversionArchiveInput },
): LegacyConversionResult {
  const source = repairJuryRev583(PlanSchema.parse(clone(input)));
  const errors: string[] = [];
  const warnings: string[] = [];
  const mismatches: ConversionMismatch[] = [];
  const legacyMechanics = source.mechanics.filter((mechanic) => mechanic.variants.length >= 2);
  const report: LegacyConversionReport = {
    convertible: false,
    sourcePlanId: source.id,
    sourceRev: source.rev,
    legacyMechanics: legacyMechanics.length,
    legacyVariants: legacyMechanics.reduce((count, mechanic) => count + mechanic.variants.length, 0),
    varyingBeats: 0,
    sharedBeats: 0,
    movementBeats: 0,
    compatibilityActorStates: 0,
    routes: 0,
    comparisons: 0,
    errors,
    warnings,
    mismatches,
  };

  if (source.variantModel === "beat") errors.push("This plan already uses Beat Variants");
  if (!legacyMechanics.length) errors.push("This plan has no legacy Mechanic-wide Variants");
  const legacyVariantIds = legacyMechanics.flatMap((mechanic) =>
    mechanic.variants.map((variant) => variant.id)
  );
  if (new Set(legacyVariantIds).size !== legacyVariantIds.length)
    errors.push("Legacy Variant ids are not globally unique");

  const knownBeats = new Set(source.mechs.map((beat) => beat.id));
  for (const step of source.steps) {
    const readings = variantsForStep(source, step.id);
    for (const variant of readings) {
      const unknown = authoredEntitiesForStep(source, step.id, variant.id).find(
        (entity) => isBeatPart(entity) && entity.mech && !knownBeats.has(entity.mech)
      );
      if (unknown)
        errors.push(`Step ${step.name || step.id} contains Part ${unknown.id} owned by an unknown Beat`);
      if (signature(unownedParts(source, step.id, variant.id)) !== signature(unownedParts(source, step.id)))
        errors.push(
          `Step ${step.name || step.id} has divergent Parts outside a Beat; conversion cannot attribute them safely`
        );
    }
  }

  const oldOwnerByBeatVariant = new Map<string, Variant>();
  const oldVariantForLocal = new Map<string, string>();
  const localForBeat = new Map<string, Map<string, string>>();
  const nextMechs: Mech[] = source.mechs.map((beat) => ({
    ...beat,
    variant: undefined,
    variants: [],
  }));
  const contentByStep = new Map<string, Record<string, BeatVariantContent>>();

  for (const originalBeat of source.mechs) {
    const section = sectionOfBeat(source, originalBeat);
    if (!section && mechSpan(source, originalBeat).length) {
      errors.push(`Beat ${mechLabel(source, originalBeat)} crosses legacy Mechanic boundaries`);
      continue;
    }
    if (!section?.variants.length) {
      report.sharedBeats++;
      continue;
    }
    const span = mechSpan(source, originalBeat);
    const differs = section.variants.some((legacyVariant) =>
      span.some(
        (stepId) =>
          signature(variantParts(source, originalBeat, stepId, legacyVariant.id)) !==
          signature(directParts(source, originalBeat, stepId))
      )
    );
    if (!differs) {
      report.sharedBeats++;
      continue;
    }

    report.varyingBeats++;
    const local = new Map<string, string>();
    const variants = section.variants.map((legacyVariant) => {
      const converted: Variant = {
        id: fresh("beat_variant"),
        name: legacyVariant.name,
        ...(legacyVariant.ownerId
          ? {
              createdBy: legacyVariant.ownerId,
              createdByName: legacyVariant.ownerName,
            }
          : {}),
      };
      local.set(legacyVariant.id, converted.id);
      oldVariantForLocal.set(converted.id, legacyVariant.id);
      oldOwnerByBeatVariant.set(converted.id, legacyVariant);
      return converted;
    });
    localForBeat.set(originalBeat.id, local);
    const targetBeat = nextMechs.find((beat) => beat.id === originalBeat.id)!;
    targetBeat.variants = variants;

    for (const stepId of span) {
      const shared = directParts(source, originalBeat, stepId);
      for (const legacyVariant of section.variants) {
        const parts = variantParts(source, originalBeat, stepId, legacyVariant.id);
        const active = !originalBeat.variant || originalBeat.variant === legacyVariant.id;
        if (active && signature(parts) === signature(shared)) continue;
        const localId = local.get(legacyVariant.id)!;
        const content = contentByStep.get(stepId) ?? {};
        content[localId] = {
          active,
          ...(originalBeat.color ? { color: originalBeat.color } : {}),
          parts: parts.map((part) => EntitySchema.parse({ ...part, mech: originalBeat.id, overrides: {} })),
        };
        contentByStep.set(stepId, content);
      }
    }
  }

  // Variant scene snapshots are not allowed to move a Part between Beats: a
  // Part has exactly one owning Beat in v2, so this ambiguity is refused.
  const ownersByPart = new Map<string, Set<string>>();
  for (const step of source.steps) {
    for (const legacyVariant of variantsForStep(source, step.id)) {
      for (const part of authoredEntitiesForStep(source, step.id, legacyVariant.id).filter(isBeatPart)) {
        if (!part.mech) continue;
        const owners = ownersByPart.get(part.id) ?? new Set<string>();
        owners.add(part.mech);
        ownersByPart.set(part.id, owners);
      }
    }
  }
  for (const [partId, owners] of ownersByPart)
    if (owners.size > 1)
      errors.push(`Part ${partId} changes Beat ownership between legacy Variants`);

  // Actor identity/state is shared. At each Step every old reading must expose
  // the same actors and non-pose state; only x/y/rotation may diverge.
  const defaultActorByStep = new Map<string, Map<string, Entity>>();
  const actorStates = new Map<string, Entity[]>();
  const movementBeatByMechanic = new Map<
    string,
    { beat: Mech; local: Map<string, string> }
  >();
  const movementByStep = new Map<string, Record<string, Record<string, BeatVariantPose>>>();

  for (const section of source.mechanics) {
    const steps = source.steps.filter((step) => step.mechanic === section.id);
    const readings: (Variant | undefined)[] = section.variants.length
      ? section.variants
      : [undefined];
    let sectionMovement = false;
    for (const step of steps) {
      const scenes = readings.map((reading) =>
        authoredEntitiesForStep(source, step.id, reading?.id).filter(actor)
      );
      const baseline = scenes[0] ?? [];
      defaultActorByStep.set(step.id, new Map(baseline.map((entity) => [entity.id, entity])));
      for (const entity of baseline) {
        const states = actorStates.get(entity.id) ?? [];
        states.push(entity);
        actorStates.set(entity.id, states);
      }
      for (let index = 1; index < scenes.length; index++) {
        const current = scenes[index];
        const baseRoster = baseline.map((entity) => `${entity.type}:${entity.id}`).join(",");
        const currentRoster = current.map((entity) => `${entity.type}:${entity.id}`).join(",");
        if (baseRoster !== currentRoster) {
          errors.push(`Actor roster differs between Variants at ${step.name || step.id}`);
          continue;
        }
        if (current.some(
          (entity, actorIndex) =>
            !same(pose(entity), pose(baseline[actorIndex])) ||
            !same(actorState(entity), actorState(baseline[actorIndex]))
        ))
          sectionMovement = true;
      }
    }
    if (!section.variants.length || !sectionMovement || !steps.length) continue;
    const variants = section.variants.map((legacyVariant) => ({
      id: fresh("beat_variant"),
      name: legacyVariant.name,
      ...(legacyVariant.ownerId
        ? { createdBy: legacyVariant.ownerId, createdByName: legacyVariant.ownerName }
        : {}),
    }));
    const local = new Map(
      section.variants.map((legacyVariant, index) => [legacyVariant.id, variants[index].id])
    );
    const beat: Mech = {
      id: fresh("mech"),
      name: legacyMechanics.length === 1 ? "Party movement" : `${mechanicLabel(source, section)} movement`,
      snap: steps[0].id,
      boom: steps[steps.length - 1].id,
      variants,
    };
    movementBeatByMechanic.set(section.id, { beat, local });
    nextMechs.push(beat);
    report.movementBeats++;
    for (const step of steps) {
      const baseline = defaultActorByStep.get(step.id)!;
      for (let index = 0; index < section.variants.length; index++) {
        const legacyVariant = section.variants[index];
        const localId = local.get(legacyVariant.id)!;
        const scene = authoredEntitiesForStep(source, step.id, legacyVariant.id).filter(actor);
        for (const entity of scene) {
          const shared = baseline.get(entity.id);
          if (!shared) continue;
          const stateDiffers = !same(actorState(entity), actorState(shared));
          if (same(pose(entity), pose(shared)) && !stateDiffers) continue;
          const movement = movementByStep.get(step.id) ?? {};
          movement[localId] = {
            ...movement[localId],
            [entity.id]: {
              ...pose(entity),
              ...(stateDiffers ? { compatibilityState: actorState(entity) } : {}),
            },
          };
          if (stateDiffers) report.compatibilityActorStates++;
          movementByStep.set(step.id, movement);
        }
      }
    }
  }

  // A detached legacy scene was authored as waymarks followed by its own
  // scene. Keep that shared-layer order before v2 appends timed Parts in Beat
  // order, so conversion does not move a waymark behind an actor.
  const entities = [
    ...source.entities.filter((entity) => entity.type === "marker"),
    ...source.entities.filter((entity) => entity.type !== "marker"),
  ].map(cleanLegacyOverrides);
  for (let index = 0; index < entities.length; index++) {
    const base = entities[index];
    if (!actor(base)) continue;
    const states = actorStates.get(base.id) ?? [];
    if (!states.length) continue;
    const promoted: Record<string, unknown> = {};
    const keys = new Set(states.flatMap((state) => Object.keys({ ...actorState(state), ...pose(state) })));
    for (const key of keys) {
      const values = states.map((state) =>
        key === "x" || key === "y" || key === "rotation"
          ? pose(state)[key]
          : actorState(state)[key]
      );
      if (values.every((value) => same(value, values[0]))) promoted[key] = values[0];
    }
    const promotedBase = EntitySchema.parse({ ...base, ...promoted, overrides: {} });
    const overrides: Record<string, Record<string, unknown>> = {};
    for (const step of source.steps) {
      const state = defaultActorByStep.get(step.id)?.get(base.id);
      if (!state) continue;
      const resolved = { ...actorState(state), ...pose(state) };
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(resolved))
        if (!same((promotedBase as unknown as Record<string, unknown>)[key], value)) patch[key] = value;
      if (Object.keys(patch).length) overrides[step.id] = patch;
    }
    entities[index] = EntitySchema.parse({ ...promotedBase, overrides });
  }

  const oldSelections = cartesianLegacySelections(source, errors);
  if (report.compatibilityActorStates)
    warnings.push(
      `${report.compatibilityActorStates} legacy actor presentation override(s) are pinned inside migration-only compatibility state; new Beat Variant authoring remains movement-only`
    );
  const routes: BeatVariantRoute[] = [];
  for (const oldSelection of oldSelections) {
    const selections: Record<string, string> = {};
    for (const [beatId, local] of localForBeat) {
      const beat = source.mechs.find((candidate) => candidate.id === beatId)!;
      const section = sectionOfBeat(source, beat)!;
      const oldVariant = oldSelection[section.id];
      if (oldVariant) selections[beatId] = local.get(oldVariant)!;
    }
    for (const [mechanicId, movement] of movementBeatByMechanic) {
      const oldVariant = oldSelection[mechanicId];
      if (oldVariant) selections[movement.beat.id] = movement.local.get(oldVariant)!;
    }
    routes.push({
      id: fresh("route"),
      name: routeName(source, oldSelection),
      selections,
      compatibility: true,
    });
  }
  report.routes = routes.length;

  const steps = source.steps.map((step) => ({
    ...step,
    variantScenes: undefined,
    beatVariantContent: Object.keys(contentByStep.get(step.id) ?? {}).length
      ? contentByStep.get(step.id)
      : undefined,
    beatVariantMovement: Object.keys(movementByStep.get(step.id) ?? {}).length
      ? movementByStep.get(step.id)
      : undefined,
  }));
  const mechanics = source.mechanics.map((mechanic) => ({ ...mechanic, variants: [] }));
  const converted = PlanSchema.parse({
    ...source,
    ...(target
      ? {
          id: target.id,
          ownerId: target.ownerId,
          name: `${source.name} (Beat Variants)`,
          conversionArchive: {
            sourcePlanId: source.id,
            sourceRev: source.rev,
            sha256: target.archive.sha256,
            convertedAt: target.archive.convertedAt,
          },
        }
      : {}),
    variantModel: "beat",
    variantRoutes: routes,
    defaultVariantRoute: routes[0]?.id,
    mechanics,
    mechs: nextMechs,
    steps,
    entities,
    rev: target ? 0 : source.rev,
  });

  for (const route of routes) {
    const routeErrors = validateBeatVariantSelections(converted, route.selections);
    for (const error of routeErrors) errors.push(`Route ${route.name}: ${error}`);
  }

  let normalizedDrawOrders = 0;
  for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
    const route = routes[routeIndex];
    const oldSelection = oldSelections[routeIndex];
    for (const step of source.steps) {
      report.comparisons++;
      const before = renderedEntities(source, step.id, oldSelection);
      const after = renderedEntities(converted, step.id, route.selections);
      if (same(before, after)) continue;
      const byId = (left: Record<string, unknown>, right: Record<string, unknown>) =>
        String(left.id).localeCompare(String(right.id));
      const canonicalBefore = [...before].sort(byId);
      const canonicalAfter = [...after].sort(byId);
      if (same(canonicalBefore, canonicalAfter)) {
        normalizedDrawOrders++;
        continue;
      }
      mismatches.push({
        route: route.name,
        stepId: step.id,
        stepName: step.name,
        reason: firstRenderDifference(canonicalBefore, canonicalAfter),
      });
    }
  }
  if (normalizedDrawOrders)
    warnings.push(
      `${normalizedDrawOrders} Route × Step comparisons preserve every rendered entity and property while normalizing draw order to shared layers, then ordered Beats and their Part order`
    );
  if (mismatches.length)
    errors.push(`${mismatches.length} Route × Step visual-equivalence comparisons failed`);

  report.convertible = errors.length === 0;
  return { plan: report.convertible ? converted : undefined, report };
}
