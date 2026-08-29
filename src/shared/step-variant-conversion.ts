import { nanoid } from "nanoid";
import { convertLegacyPlan, type ConversionArchiveInput, type ConversionMismatch } from "./beat-variant-conversion";
import {
  EntitySchema,
  PlanSchema,
  composeBeatVariantEntities,
  entitiesForStep,
  isBeatPart,
  mechColor,
  zoneFamilyColor,
  mechSpan,
  type Entity,
  type Mech,
  type Plan,
  type StepVariant,
} from "./schema";
import { validateStepVariantSelections } from "./step-variants";

const fresh = (prefix: string) => `${prefix}_${nanoid(8)}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface GroupSpec {
  name: string;
  owner: string;
  end: string;
  from: number;
  to: number;
  labels: string[];
}

export interface StepConversionReport {
  convertible: boolean;
  sourcePlanId: string;
  sourceRev: number;
  groups: number;
  boxes: number;
  boxedBeats: number;
  routes: number;
  comparisons: number;
  errors: string[];
  mismatches: ConversionMismatch[];
  staging: ReturnType<typeof convertLegacyPlan>["report"];
}

export interface StepConversionResult {
  plan?: Plan;
  report: StepConversionReport;
}

function specs(source: Plan): GroupSpec[] {
  if (source.id === "plan_c2b9xZyc" && source.rev === 583)
    return [{
      name: "Jury",
      owner: "step_WOUFDfJs",
      end: "step_o_eUrj-t",
      from: 0,
      to: 4,
      labels: ["Light", "Dark"],
    }];
  if (source.id === "plan_mMW41ylx" && source.rev === 3018)
    return [
      { name: "Arcane", owner: "step_LmI-jzYE", end: "step_vSmaAxbZ", from: 0, to: 6, labels: ["A", "B"] },
      { name: "Jury", owner: "step_UOLF10xt", end: "step__pTIM2D_", from: 7, to: 11, labels: ["A", "B"] },
      { name: "Divisive", owner: "step_Ll2qOUph", end: "step_u4y_mdhO", from: 12, to: 17, labels: ["A", "B"] },
    ];
  return [];
}

function variantName(beat: Mech, id: string): string {
  const at = beat.variants.findIndex((variant) => variant.id === id);
  return beat.variants[at]?.name || String.fromCharCode(65 + Math.max(0, at));
}

function groupForBeat(staging: Plan, groups: GroupSpec[], beat: Mech): GroupSpec | undefined {
  const snap = staging.steps.findIndex((step) => step.id === beat.snap);
  return groups.find((group) => snap >= group.from && snap <= group.to);
}

/** Materialize one staged Beat Variant as an ordinary complete Beat. */
function materializeBeat(staging: Plan, beat: Mech, variantId: string): { beats: Mech[]; parts: Entity[] } {
  const madeId = fresh("mech");
  const parts: Entity[] = [];
  for (const stepId of mechSpan(staging, beat)) {
    const stepColor = staging.steps.find((step) => step.id === stepId)?.beatVariantContent?.[variantId]?.color;
    const scene = composeBeatVariantEntities(staging, stepId, { [beat.id]: variantId }).entities;
    const visible = scene.filter((candidate) => candidate.mech === beat.id && isBeatPart(candidate));
    const partIds = new Map(visible.map((entity) => [entity.id, fresh(entity.type)]));
    const bondIds = new Map<string, string>();
    const symmetryIds = new Map<string, string>();
    for (const entity of visible) {
      if (entity.bond && !bondIds.has(entity.bond.id)) bondIds.set(entity.bond.id, fresh("bond"));
      if (entity.symmetry && !symmetryIds.has(entity.symmetry.id))
        symmetryIds.set(entity.symmetry.id, fresh("symmetry"));
    }
    for (const entity of visible) {
      const effectiveColor =
        stepColor ?? beat.color ?? zoneFamilyColor(staging, entity) ?? mechColor(staging, beat);
      const anchor = entity.anchor
        ? {
            ...entity.anchor,
            to: partIds.get(entity.anchor.to) ?? entity.anchor.to,
            ...(entity.anchor.from
              ? { from: partIds.get(entity.anchor.from) ?? entity.anchor.from }
              : {}),
            ...(entity.anchor.near
              ? { near: partIds.get(entity.anchor.near) ?? entity.anchor.near }
              : {}),
          }
        : entity.anchor;
      const endpoints = entity.type === "tether"
        ? {
            from: partIds.get(entity.from) ?? entity.from,
            to: partIds.get(entity.to) ?? entity.to,
          }
        : {};
      parts.push(EntitySchema.parse({
        ...entity,
        ...(!entity.color && effectiveColor ? { color: effectiveColor } : {}),
        id: partIds.get(entity.id)!,
        mech: madeId,
        anchor,
        ...endpoints,
        ...(entity.bond ? { bond: { ...entity.bond, id: bondIds.get(entity.bond.id)! } } : {}),
        ...(entity.symmetry
          ? { symmetry: { ...entity.symmetry, id: symmetryIds.get(entity.symmetry.id)! } }
          : {}),
        declaredIn: stepId,
        steps: [stepId],
        overrides: {},
      }));
    }
  }
  return {
    beats: parts.length
      ? [{ ...beat, id: madeId, variant: undefined, variants: [] }]
      : [],
    parts,
  };
}

function visual(entity: Entity, byId: Map<string, Entity>): Record<string, unknown> {
  const { id: _id, mech: _mech, overrides: _overrides, declaredIn: _declaredIn, steps: _steps, ...rest } = entity;
  const anchorless = { ...rest, anchor: undefined } as Record<string, unknown>;
  if (entity.bond) anchorless.bond = { ...entity.bond, id: undefined };
  if (entity.symmetry) anchorless.symmetry = { ...entity.symmetry, id: undefined };
  if (entity.type === "tether") {
    const endpoint = (id: string) => {
      const target = byId.get(id);
      return target ? { x: target.x, y: target.y } : null;
    };
    anchorless.from = endpoint(entity.from);
    anchorless.to = endpoint(entity.to);
  }
  return anchorless;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  return value;
}

function visualScene(plan: Plan, stepId: string, shown: Record<string, string>): string[] {
  const entities = entitiesForStep(plan, stepId, undefined, shown);
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  return entities
    .map((entity) => JSON.stringify(stable(visual(entity, byId))))
    .sort();
}

/**
 * Convert through the previously-proven lossless Beat staging model, then
 * collapse those private snapshots into complete Beats owned by Step boxes.
 */
export function convertLegacyPlanToStepVariants(
  source: Plan,
  target?: { id: string; ownerId: string; archive: ConversionArchiveInput },
): StepConversionResult {
  const staged = convertLegacyPlan(source);
  const errors = [...staged.report.errors];
  const mismatches: ConversionMismatch[] = [];
  const groups = specs(source);
  if (!groups.length) errors.push("This source has no audited Step Variant grouping");
  if (!staged.plan) {
    const report: StepConversionReport = {
      convertible: false, sourcePlanId: source.id, sourceRev: source.rev,
      groups: groups.length, boxes: groups.reduce((n, group) => n + group.labels.length, 0),
      boxedBeats: 0, routes: 0, comparisons: 0, errors, mismatches, staging: staged.report,
    };
    return { report };
  }

  const staging = staged.plan;
  const varying = staging.mechs.filter((beat) => beat.variants.length);
  const movementBeats = new Set(
    varying
      .filter((beat) => !staging.entities.some((entity) => entity.mech === beat.id && isBeatPart(entity)))
      .map((beat) => beat.id),
  );
  const removed = new Set(varying.map((beat) => beat.id));
  const mechs = staging.mechs.filter((beat) => !removed.has(beat.id));
  const entities = staging.entities
    .filter((entity) => !isBeatPart(entity) || !entity.mech || !removed.has(entity.mech))
    .map((entity) =>
      !isBeatPart(entity) && entity.mech && removed.has(entity.mech)
        ? (() => {
            const beat = staging.mechs.find((candidate) => candidate.id === entity.mech)!;
            const span = mechSpan(staging, beat);
            const overrides = { ...entity.overrides };
            for (const stepId of span)
              overrides[stepId] = {
                ...overrides[stepId],
                opacity: stepId === (beat.boom || beat.snap) ? entity.opacity : entity.opacity * 0.55,
              };
            return EntitySchema.parse({ ...entity, mech: undefined, steps: span, overrides });
          })()
        : isBeatPart(entity) && entity.mech && !entity.color
          ? (() => {
              const beat = staging.mechs.find((candidate) => candidate.id === entity.mech);
              const color = beat
                ? beat.color ?? zoneFamilyColor(staging, entity) ?? mechColor(staging, beat)
                : undefined;
              return color ? EntitySchema.parse({ ...entity, color }) : entity;
            })()
          : entity,
    );
  const variantsByGroup = new Map<string, StepVariant[]>();
  let boxedBeats = 0;

  for (const group of groups) {
    const boxes: StepVariant[] = group.labels.map((name) => ({ id: fresh("step_variant"), name, beats: [] }));
    variantsByGroup.set(group.owner, boxes);
    for (const beat of varying.filter((candidate) => !movementBeats.has(candidate.id) && groupForBeat(staging, groups, candidate) === group)) {
      for (const oldVariant of beat.variants) {
        const label = variantName(beat, oldVariant.id);
        const box = boxes.find((candidate) => candidate.name.toLowerCase() === label.toLowerCase());
        if (!box) continue;
        const made = materializeBeat(staging, beat, oldVariant.id);
        if (!made.beats.length) continue;
        mechs.push(...made.beats);
        entities.push(...made.parts);
        box.beats.push(...made.beats.map((candidate) => candidate.id));
        boxedBeats += made.beats.length;
      }
    }
  }

  const steps = staging.steps.map((step, stepIndex) => {
    const group = groups.find((candidate) => candidate.owner === step.id);
    const stepVariantMovement: Record<string, Record<string, never>> = {};
    const movementGroup = groups.find((candidate) => stepIndex >= candidate.from && stepIndex <= candidate.to);
    if (movementGroup) {
      const boxes = variantsByGroup.get(movementGroup.owner)!;
      for (const movementBeat of varying.filter((beat) => movementBeats.has(beat.id))) {
        for (const oldVariant of movementBeat.variants) {
          const box = boxes.find((candidate) => candidate.name.toLowerCase() === variantName(movementBeat, oldVariant.id).toLowerCase());
          const movement = step.beatVariantMovement?.[oldVariant.id];
          if (box && movement) stepVariantMovement[box.id] = movement as Record<string, never>;
        }
      }
    }
    return {
      ...step,
      variants: group ? variantsByGroup.get(group.owner) : [],
      variantEnd: group?.end,
      stepVariantMovement: Object.keys(stepVariantMovement).length ? stepVariantMovement : undefined,
      variantScenes: undefined,
      beatVariantContent: undefined,
      beatVariantMovement: undefined,
    };
  });

  const routePairs: { old: Record<string, string>; next: Record<string, string>; name: string }[] = [];
  for (const route of staging.variantRoutes ?? []) {
    const next: Record<string, string> = {};
    for (const group of groups) {
      const candidates = varying.filter((beat) => groupForBeat(staging, groups, beat) === group || movementBeats.has(beat.id));
      const selectedOld = candidates.map((beat) => route.selections[beat.id]).find(Boolean);
      const label = selectedOld
        ? candidates.flatMap((beat) => beat.variants).find((variant) => variant.id === selectedOld)?.name
        : undefined;
      const box = variantsByGroup.get(group.owner)?.find((candidate) => candidate.name.toLowerCase() === label?.toLowerCase());
      if (box) next[group.owner] = box.id;
    }
    if (!routePairs.some((candidate) => same(candidate.next, next)))
      routePairs.push({ old: route.selections, next, name: route.name });
  }
  const routes = routePairs.map((pair) => ({ id: fresh("route"), name: pair.name, selections: pair.next, compatibility: true }));
  const converted = PlanSchema.parse({
    ...staging,
    ...(target ? {
      id: target.id,
      ownerId: target.ownerId,
      conversionArchive: {
        sourcePlanId: source.id,
        sourceRev: source.rev,
        sha256: target.archive.sha256,
        convertedAt: target.archive.convertedAt,
      },
      rev: 0,
    } : {}),
    variantModel: "step",
    mechanics: staging.mechanics.map((mechanic) => ({ ...mechanic, variants: [] })),
    mechs,
    entities,
    steps,
    variantRoutes: routes,
    defaultVariantRoute: routes[0]?.id,
  });

  for (const route of routes) errors.push(...validateStepVariantSelections(converted, route.selections).map((error) => `${route.name}: ${error}`));
  let comparisons = 0;
  for (let index = 0; index < routePairs.length; index++) {
    for (const step of source.steps) {
      comparisons++;
      const before = visualScene(staging, step.id, routePairs[index].old);
      const after = visualScene(converted, step.id, routes[index].selections);
      if (!same(before, after)) mismatches.push({
        route: routes[index].name,
        stepId: step.id,
        stepName: step.name,
        reason: `Visual entity multiset changed (${before.length} → ${after.length})`,
      });
    }
  }
  if (mismatches.length) errors.push(`${mismatches.length} Step Variant Route × Step comparisons failed`);
  const report: StepConversionReport = {
    convertible: errors.length === 0,
    sourcePlanId: source.id,
    sourceRev: source.rev,
    groups: groups.length,
    boxes: groups.reduce((n, group) => n + group.labels.length, 0),
    boxedBeats,
    routes: routes.length,
    comparisons,
    errors,
    mismatches,
    staging: staged.report,
  };
  return { plan: report.convertible ? converted : undefined, report };
}
