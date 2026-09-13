import { z } from "zod";
import type { AppEnv } from "./env";
import { registry } from "./registry";
import { guardVariants } from "./variants";
import { planStub } from "./plan-agent";
import type { Op } from "../shared/apply";
import {
  ANCHORS,
  type Anchor,
  anchorToPoint,
  BAIT_KINDS,
  baitNeedsSource,
  baitSpec,
  createPlan,
  describePlan,
  encounterSetup,
  findEntities,
  newId,
  resolveRef,
} from "../shared/ops";
import {
  ARENA_SHAPES,
  BAIT_RULES,
  ENTITY_TYPES,
  GRID_TYPES,
  MARKER_IDS,
  TETHER_STYLES,
  ZONE_SHAPES,
  activeBeatVariants,
  authoredEntitiesForStep,
  beatVariantLabel,
  composeBeatVariantEntities,
  defaultBeatVariantSelections,
  freezeStep,
  mechLabel,
  mechSpan,
  mechanicLabel,
  mechanicSteps,
  validateBeatVariantSelections,
  variantLabel,
  type Plan,
} from "../shared/schema";
import {
  stepVariantLabel,
  stepVariants,
  validateStepVariantSelections,
} from "../shared/step-variants";
import { JOB_IDS } from "../shared/jobs";
import { ACTOR_KEYS, ARENA_BACKGROUNDS, ASSETS, MARKER_KEYS, MECHANIC_KEYS } from "../shared/assets";

/**
 * The plan-editing tool table — the single definition used by BOTH the MCP
 * server (src/server/mcp.ts) and the in-app chat agent (src/server/chat.ts).
 * Add a capability here and both surfaces get it.
 */

export interface ToolContext {
  env: AppEnv;
  userId: string;
  appUrl: string;
}

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  schema: Shape;
  /** Returns the text the model sees. */
  run(ctx: ToolContext, args: z.infer<z.ZodObject<Shape>>): Promise<string>;
}

const def = <Shape extends z.ZodRawShape>(t: ToolDef<Shape>) => t as unknown as ToolDef;

/**
 * A tool's arguments as a schema that *rejects* unknown keys.
 *
 * A plain object strips them, so `set_arena {grid: "radial"}` — the field is
 * `grid_type` — answered "Arena updated." while changing nothing at all. A
 * caller that guesses a name has no way to see its edit went nowhere, and the
 * plan quietly disagrees with what the model thinks it built.
 */
export function strictSchema(tool: ToolDef) {
  return z.strictObject(tool.schema);
}

/* ------------------------------------------------------------------ helpers */

const posArgs = {
  x: z.number().optional().describe("Arena x (east positive, 0 = centre)"),
  y: z.number().optional().describe("Arena y (south positive, 0 = centre)"),
  at: z.enum(ANCHORS).optional().describe("Compass anchor instead of x/y: N, NE, E, SE, S, SW, W, NW, center"),
  distance: z
    .number()
    .min(0)
    .max(1.2)
    .optional()
    .describe("With `at`: how far out — 0 = centre, 1 = the wall (default 0.75)"),
};

type PosArgs = { x?: number; y?: number; at?: Anchor; distance?: number };

function positionOf(plan: Plan, a: PosArgs) {
  if (a.at) {
    const p = anchorToPoint(plan.arena, a.at, a.distance ?? 0.75);
    return { x: a.x ?? p.x, y: a.y ?? p.y };
  }
  const out: { x?: number; y?: number } = {};
  if (a.x !== undefined) out.x = a.x;
  if (a.y !== undefined) out.y = a.y;
  return out;
}

/** Accept a step id, a 1-based index, or a step name. */
function stepIdOf(plan: Plan, step?: string): string | undefined {
  if (!step || step === "all") return undefined;
  const byId = plan.steps.find((s) => s.id === step);
  if (byId) return byId.id;
  const n = Number(step);
  if (Number.isInteger(n) && n >= 1 && n <= plan.steps.length) return plan.steps[n - 1].id;
  const byName = plan.steps.find((s) => s.name.toLowerCase() === step.toLowerCase());
  if (byName) return byName.id;
  throw new Error(
    `No step "${step}". Steps: ${plan.steps.map((s, i) => `${i + 1}=${s.name} [${s.id}]`).join(", ")}`
  );
}

/** Accept a mech id, a 1-based index, or a mech name. */
function mechIdOf(plan: Plan, mech: string): string {
  const byId = plan.mechs.find((m) => m.id === mech);
  if (byId) return byId.id;
  const n = Number(mech);
  if (Number.isInteger(n) && n >= 1 && n <= plan.mechs.length) return plan.mechs[n - 1].id;
  const byName = plan.mechs.find((m) => mechLabel(plan, m).toLowerCase() === mech.toLowerCase());
  if (byName) return byName.id;
  throw new Error(
    `No mech "${mech}". Mechs: ${plan.mechs.map((m, i) => `${i + 1}=${mechLabel(plan, m)} [${m.id}]`).join(", ") || "none yet"}`
  );
}

/** Accept a mechanic id, a 1-based index, or a mechanic name. */
function mechanicIdOf(plan: Plan, mechanic: string): string {
  const byId = plan.mechanics.find((m) => m.id === mechanic);
  if (byId) return byId.id;
  const n = Number(mechanic);
  if (Number.isInteger(n) && n >= 1 && n <= plan.mechanics.length) return plan.mechanics[n - 1].id;
  const byName = plan.mechanics.find(
    (m) => mechanicLabel(plan, m).toLowerCase() === mechanic.toLowerCase()
  );
  if (byName) return byName.id;
  throw new Error(
    `No mechanic "${mechanic}". Mechanics: ${plan.mechanics.map((m, i) => `${i + 1}=${mechanicLabel(plan, m)} [${m.id}]`).join(", ") || "none yet"}`
  );
}

/** Accept a variant id, a 1-based index within its mechanic, or its name (or letter). */
function variantIdOf(plan: Plan, mechanicId: string, variant: string): string {
  const mechanic = plan.mechanics.find((m) => m.id === mechanicId)!;
  const byId = mechanic.variants.find((v) => v.id === variant);
  if (byId) return byId.id;
  const n = Number(variant);
  if (Number.isInteger(n) && n >= 1 && n <= mechanic.variants.length)
    return mechanic.variants[n - 1].id;
  const byName = mechanic.variants.find(
    (v) => variantLabel(mechanic, v.id).toLowerCase() === variant.toLowerCase()
  );
  if (byName) return byName.id;
  throw new Error(
    `No variant "${variant}" of ${mechanicLabel(plan, mechanic)}. Variants: ${mechanic.variants.map((v, i) => `${i + 1}=${variantLabel(mechanic, v.id)} [${v.id}]`).join(", ") || "none — it happens one way"}`
  );
}

/** Accept a Beat-local Variant id, a 1-based index, its name or A/B letter. */
function beatVariantIdOf(plan: Plan, beatId: string, variant: string): string {
  const beat = plan.mechs.find((candidate) => candidate.id === beatId)!;
  const byId = beat.variants.find((candidate) => candidate.id === variant);
  if (byId) return byId.id;
  const n = Number(variant);
  if (Number.isInteger(n) && n >= 1 && n <= beat.variants.length) return beat.variants[n - 1].id;
  const byName = beat.variants.find(
    (candidate) => beatVariantLabel(beat, candidate.id).toLowerCase() === variant.toLowerCase()
  );
  if (byName) return byName.id;
  throw new Error(
    `No Variant "${variant}" of Beat ${mechLabel(plan, beat)}. Variants: ${beat.variants
      .map((candidate, index) => `${index + 1}=${beatVariantLabel(beat, candidate.id)} [${candidate.id}]`)
      .join(", ") || "none"}`
  );
}

async function load(ctx: ToolContext, planId: string, need: "view" | "edit" | "own") {
  const role = await registry(ctx.env).roleFor(ctx.userId, planId);
  if (!role) throw new Error(`Plan ${planId} not found, or you do not have access to it`);
  if (need !== "view" && role === "viewer") throw new Error(`You only have viewer access to ${planId}`);
  if (need === "own" && role !== "owner") throw new Error(`Only the owner can do that`);
  const stub = await planStub(ctx.env, planId);
  const plan = await stub.getPlan();
  if (!plan.id) throw new Error(`Plan ${planId} has no contents`);
  return { stub, plan, role };
}

/** Read the plan, build ops from it, apply them, keep the index fresh. */
async function edit(ctx: ToolContext, planId: string, make: (plan: Plan) => Op | Op[]) {
  // A model editing on someone's behalf is still that someone: another
  // player's reading of the fight is no more yours through a tool than by hand.
  const me = await registry(ctx.env).getUser(ctx.userId);
  for (let attempt = 0; attempt < 4; attempt++) {
    const { stub, plan, role } = await load(ctx, planId, "edit");
    const ops = guardVariants(
      plan,
      make(plan),
      { id: ctx.userId, name: me?.name },
      role,
      (m) => new Error(m)
    );
    const res = await stub.apply(
      ops,
      {
        actorId: ctx.userId,
        actorName: me?.name,
        source: "mcp",
      },
      plan.rev
    );
    if (res.conflict) continue;
    await registry(ctx.env).touchPlan(planId, { name: res.plan.name, encounter: res.plan.encounter });
    return res;
  }
  throw new Error("The plan kept changing; try that edit again");
}

const planUrl = (ctx: ToolContext, id: string) => `${ctx.appUrl}/p/${id}`;

/**
 * Every Part lives in a Beat: the one named, or a new one made for it in the
 * step it is being added to. The Beat is the first op of the batch, so what
 * a tool reports comes after it in `values`.
 */
function beatFor(
  plan: Plan,
  mech: string | undefined,
  stepId: string | undefined,
  name: string,
): { mech: string; prelude: Op[] } {
  if (mech) return { mech: mechIdOf(plan, mech), prelude: [] };
  const id = newId("mech");
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  return {
    mech: id,
    prelude: [{ op: "add_mech", id, name: label, snap: stepId ?? plan.steps[0]?.id, plain: true }],
  };
}
const idOf = (v: unknown) => (v as { id: string }).id;

function requireBeatModel(plan: Plan): void {
  if (plan.variantModel !== "beat")
    throw new Error("This plan has not been hydrated into the Beat model");
}

function resolvedBeatSelections(plan: Plan, selections: Record<string, string>): Record<string, string> {
  requireBeatModel(plan);
  return Object.fromEntries(
    Object.entries(selections).map(([beatRef, variantRef]) => {
      const beatId = mechIdOf(plan, beatRef);
      return [beatId, beatVariantIdOf(plan, beatId, variantRef)];
    })
  );
}

/** Accept a Variant-box id, 1-based index, name or A/B letter on one Step split. */
function stepVariantIdOf(plan: Plan, ownerStepId: string, variant: string): string {
  const owner = plan.steps.find((step) => step.id === ownerStepId);
  const variants = stepVariants(owner);
  const byId = variants.find((candidate) => candidate.id === variant);
  if (byId) return byId.id;
  const n = Number(variant);
  if (Number.isInteger(n) && n >= 1 && n <= variants.length) return variants[n - 1].id;
  const byName = variants.find(
    (candidate) => stepVariantLabel(owner!, candidate.id).toLowerCase() === variant.toLowerCase(),
  );
  if (byName) return byName.id;
  throw new Error(
    `No Variant box "${variant}" on ${owner?.name || ownerStepId}. Boxes: ${variants
      .map((candidate, index) => `${index + 1}=${stepVariantLabel(owner!, candidate.id)} [${candidate.id}]`)
      .join(", ") || "none"}`,
  );
}

function stepVariantOwnerIdOf(plan: Plan, step: string): string {
  const stepId = stepIdOf(plan, step)!;
  const owner = plan.steps.find((candidate) => candidate.id === stepId)!;
  if (stepVariants(owner).length < 2)
    throw new Error(`${owner.name || owner.id} does not declare Variant boxes`);
  return owner.id;
}

function resolvedRouteSelections(
  plan: Plan,
  selections: Record<string, string>,
): Record<string, string> {
  if (plan.variantModel === "beat") return resolvedBeatSelections(plan, selections);
  if (plan.variantModel !== "step") throw new Error("This plan has no live Variant model");
  return Object.fromEntries(
    Object.entries(selections).map(([stepRef, variantRef]) => {
      const ownerStepId = stepVariantOwnerIdOf(plan, stepRef);
      return [ownerStepId, stepVariantIdOf(plan, ownerStepId, variantRef)];
    }),
  );
}

function routeSelectionErrors(plan: Plan, selections: Record<string, string>): string[] {
  return plan.variantModel === "step"
    ? validateStepVariantSelections(plan, selections)
    : validateBeatVariantSelections(plan, selections);
}

function routeIdOf(plan: Plan, route: string): string {
  const routes = plan.variantRoutes ?? [];
  const byId = routes.find((candidate) => candidate.id === route);
  if (byId) return byId.id;
  const n = Number(route);
  if (Number.isInteger(n) && n >= 1 && n <= routes.length) return routes[n - 1].id;
  const byName = routes.find((candidate) => candidate.name.toLowerCase() === route.toLowerCase());
  if (byName) return byName.id;
  throw new Error(`No Route "${route}". Routes: ${routes.map((candidate, index) => `${index + 1}=${candidate.name} [${candidate.id}]`).join(", ") || "none"}`);
}

const stepArg = {
  step: z
    .string()
    .optional()
    .describe("Step id, 1-based index or name. Omit to affect the entity in every step."),
  variant: z
    .string()
    .optional()
    .describe(
      "With `step`, file this edit under one Variant (id, index, name or letter). In a Beat Variant plan, also give `beat` when more than one varying Beat is active."
    ),
  beat: z
    .string()
    .optional()
    .describe("Beat id, index or name owning `variant`; optional when exactly one varying Beat is active in the Step"),
};

/** The Variant an edit is filed under, resolved in either persisted model. */
function poseVariant(
  plan: Plan,
  stepId: string | undefined,
  variant?: string,
  beatRef?: string,
): string | undefined {
  if (variant && !stepId) throw new Error("Give step when selecting a variant");
  if (!variant) return undefined;
  if (plan.variantModel === "beat") {
    const active = activeBeatVariants(plan, stepId!, {});
    const beatId = beatRef
      ? mechIdOf(plan, beatRef)
      : active.length === 1
        ? active[0].beat.id
        : undefined;
    if (!beatId)
      throw new Error(
        active.length
          ? "More than one varying Beat is active; give beat to choose the edit destination"
          : "No varying Beat is active in that Step"
      );
    if (!active.some(({ beat }) => beat.id === beatId))
      throw new Error(`Beat ${mechLabel(plan, plan.mechs.find((candidate) => candidate.id === beatId)!)} is not active in that Step`);
    return beatVariantIdOf(plan, beatId, variant);
  }
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step?.mechanic) throw new Error("That step is not in a mechanic, so it has no readings");
  return variantIdOf(plan, step.mechanic, variant);
}

/** Let entity lookup see variant-only additions when an op targets a detached scene. */
function scenePlan(plan: Plan, stepId?: string, variantId?: string): Plan {
  if (!stepId || !variantId) return plan;
  if (plan.variantModel === "beat") {
    const beat = plan.mechs.find((candidate) =>
      candidate.variants.some((variant) => variant.id === variantId)
    );
    if (!beat) throw new Error(`No Beat Variant ${variantId}`);
    return {
      ...plan,
      entities: composeBeatVariantEntities(plan, stepId, {
        ...defaultBeatVariantSelections(plan),
        [beat.id]: variantId,
      }).entities,
    };
  }
  return { ...plan, entities: authoredEntitiesForStep(plan, stepId, variantId) };
}

/* -------------------------------------------------------------------- tools */

export const TOOLS: ToolDef[] = [
  def({
    name: "list_plans",
    description: "List the raid plans you can see, newest first.",
    schema: {},
    async run(ctx) {
      const plans = await registry(ctx.env).listPlansForUser(ctx.userId);
      if (!plans.length) return "No plans yet. Use create_plan to make one.";
      return plans
        .map((p) => `- ${p.id} — "${p.name}"${p.encounter ? ` (${p.encounter})` : ""} [${p.role}] ${planUrl(ctx, p.id)}`)
        .join("\n");
    },
  }),

  def({
    name: "create_plan",
    description: "Create a new plan. Returns its id and editor URL.",
    schema: {
      name: z.string().describe("Plan name, e.g. 'M5S — first quadruple'"),
      encounter: z.string().optional().describe("Fight or duty name"),
      arena_shape: z.enum(ARENA_SHAPES).optional(),
      arena_size: z.number().positive().optional().describe("Arena width/height in units (default 1000)"),
      with_party: z.boolean().optional().describe("Seed the standard 8-player party (default true)"),
      with_waymarks: z.boolean().optional().describe("Seed A-D and 1-4 waymarks (default false)"),
    },
    async run(ctx, a) {
      const draft = createPlan({ name: a.name, encounter: a.encounter, ownerId: ctx.userId, variantModel: "step" });
      const stub = await planStub(ctx.env, draft.id);
      await stub.init({
        id: draft.id,
        name: a.name,
        encounter: a.encounter,
        ownerId: ctx.userId,
        withParty: a.with_party ?? true,
        variantModel: "step",
      });
      await registry(ctx.env).registerPlan({
        id: draft.id,
        name: a.name,
        encounter: a.encounter,
        ownerId: ctx.userId,
      });
      const follow: Op[] = [];
      // A plan for a fight you have already set up inherits that floor, so every
      // mech for the encounter agrees on where the waymarks are.
      const saved = a.encounter ? await registry(ctx.env).getEncounter(ctx.userId, a.encounter) : null;
      if (saved) follow.push({ op: "apply_encounter", setup: saved });
      if (a.arena_shape || a.arena_size)
        follow.push({
          op: "set_arena",
          patch: { shape: a.arena_shape, width: a.arena_size, height: a.arena_size },
        });
      if (a.with_waymarks && !saved) follow.push({ op: "add_waymarks" });
      if (follow.length) await stub.apply(follow);
      // Say what was seeded: a model that assumes an empty plan adds a second party.
      const seeded = [
        a.with_party ?? true ? "an 8-player party" : "",
        saved ? `the saved ${a.encounter} floor and waymarks` : a.with_waymarks ? "waymarks" : "",
      ].filter(Boolean);
      return `Created plan ${draft.id}${seeded.length ? ` with ${seeded.join(" and ")}` : " (empty)"} — ${planUrl(ctx, draft.id)}`;
    },
  }),

  def({
    name: "read_plan",
    description:
      "Read a plan as text: arena, steps, and every entity with its id and position. Call this before editing. Name a step and variant to inspect a detached reading.",
    schema: {
      plan_id: z.string(),
      step: z.string().optional().describe("Step id, 1-based index or name; omit for every step"),
      variant: z.string().optional().describe("With step, inspect this reading (id, index, name or letter)"),
      beat: z.string().optional().describe("In a Beat Variant plan, the Beat owning variant"),
    },
    async run(ctx, a) {
      const { plan } = await load(ctx, a.plan_id, "view");
      const stepId = stepIdOf(plan, a.step);
      if (a.variant && !stepId) throw new Error("Give step when selecting a variant");
      const variant = poseVariant(plan, stepId, a.variant, a.beat);
      const step = stepId ? plan.steps.find((candidate) => candidate.id === stepId) : undefined;
      const beatOwner = variant && plan.variantModel === "beat"
        ? plan.mechs.find((candidate) => candidate.variants.some((choice) => choice.id === variant))
        : undefined;
      const shown = beatOwner
        ? { [beatOwner.id]: variant! }
        : step?.mechanic && variant
          ? { [step.mechanic]: variant }
          : undefined;
      return describePlan(plan, stepId, shown);
    },
  }),

  def({
    name: "get_plan_json",
    description: "Fetch the raw plan JSON — the exact document the editor renders.",
    schema: { plan_id: z.string() },
    async run(ctx, a) {
      const { plan } = await load(ctx, a.plan_id, "view");
      return JSON.stringify(plan, null, 2);
    },
  }),

  def({
    name: "set_plan_info",
    description: "Rename a plan or change its description/encounter.",
    schema: {
      plan_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      encounter: z.string().optional(),
    },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, () => ({
        op: "set_meta",
        name: a.name,
        description: a.description,
        encounter: a.encounter,
      }));
      return "Updated.";
    },
  }),

  def({
    name: "set_arena",
    description: "Change the arena shape, size, physical yalm calibration, grid or backdrop image.",
    schema: {
      plan_id: z.string(),
      shape: z.enum(ARENA_SHAPES).optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      width_yalms: z.number().positive().optional().describe("Known in-game wall-to-wall arena width in yalms"),
      clear_width_yalms: z.boolean().optional().describe("Clear the manual width and return to known/default calibration"),
      color: z.string().optional(),
      image: z
        .string()
        .optional()
        .describe("Backdrop: a bundled arena key from list_assets (e.g. arena/p12_octagon) or an image URL"),
      image_opacity: z.number().min(0).max(1).optional(),
      grid_type: z.enum(GRID_TYPES).optional(),
      rows: z.number().int().min(1).max(32).optional(),
      cols: z.number().int().min(1).max(32).optional(),
      rings: z.number().int().min(1).max(12).optional(),
      spokes: z.number().int().min(1).max(32).optional(),
    },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => ({
        op: "set_arena",
        patch: {
          shape: a.shape,
          width: a.width,
          height: a.height,
          widthYalms: a.clear_width_yalms ? null : a.width_yalms,
          color: a.color,
          image: a.image,
          imageOpacity: a.image_opacity,
          grid: {
            ...plan.arena.grid,
            ...(a.grid_type ? { type: a.grid_type } : {}),
            ...(a.rows ? { rows: a.rows } : {}),
            ...(a.cols ? { cols: a.cols } : {}),
            ...(a.rings ? { rings: a.rings } : {}),
            ...(a.spokes ? { spokes: a.spokes } : {}),
          },
        },
      }));
      return "Arena updated.";
    },
  }),

  /* ---------------------------------------------------------------- steps */

  def({
    name: "list_steps",
    description: "List a plan's steps with their ids.",
    schema: { plan_id: z.string() },
    async run(ctx, a) {
      const { plan } = await load(ctx, a.plan_id, "view");
      return plan.steps
        .map((s, i) => `${i + 1}. ${s.name} [${s.id}]${s.notes ? `: ${s.notes}` : ""}`)
        .join("\n");
    },
  }),

  def({
    name: "add_step",
    description:
      "Add a step. With copy_from, the new step inherits every entity's pose from that step — the usual way to build a sequence.",
    schema: {
      plan_id: z.string(),
      name: z.string().optional(),
      notes: z.string().optional().describe("What happens in this step"),
      copy_from: z.string().optional().describe("Step id or index to duplicate"),
      mechanic: z
        .string()
        .optional()
        .describe(
          "Put it in a section of the fight (id, 1-based index or name) — it goes at the end of that mechanic's steps. Without one it joins whatever the step before it belongs to."
        ),
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => {
        const mechanic = a.mechanic ? mechanicIdOf(plan, a.mechanic) : undefined;
        return a.copy_from
          ? { op: "duplicate_step", stepId: stepIdOf(plan, a.copy_from)!, name: a.name }
          : { op: "add_step", name: a.name, notes: a.notes, mechanic };
      });
      const step = res.values[0] as { id: string; name: string };
      if (a.copy_from && a.notes)
        await edit(ctx, a.plan_id, () => ({ op: "update_step", stepId: step.id, patch: { notes: a.notes! } }));
      return `Added step "${step.name}" [${step.id}]`;
    },
  }),

  def({
    name: "update_step",
    description: "Rename a step or set its notes.",
    schema: { plan_id: z.string(), step: z.string(), name: z.string().optional(), notes: z.string().optional() },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => ({
        op: "update_step",
        stepId: stepIdOf(plan, a.step)!,
        patch: { name: a.name, notes: a.notes },
      }));
      return "Step updated.";
    },
  }),

  def({
    name: "move_step",
    description:
      "Move a step to another place in the sequence. `to` is the position it should end up at, counting from 1.",
    schema: {
      plan_id: z.string(),
      step: z.string().describe("Step id, name or index"),
      to: z.number().int().min(1).describe("Where it should sit afterwards, 1 = first"),
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => ({
        op: "move_step",
        stepId: stepIdOf(plan, a.step)!,
        index: a.to - 1,
      }));
      return "Steps are now: " + res.plan.steps.map((s, i) => `${i + 1}. ${s.name}`).join(", ");
    },
  }),

  def({
    name: "delete_step",
    description: "Delete a step.",
    schema: { plan_id: z.string(), step: z.string() },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => ({ op: "delete_step", stepId: stepIdOf(plan, a.step)! }));
      return "Step deleted.";
    },
  }),

  /* ------------------------------------------------------------ mechanics */

  def({
    name: "list_mechanics",
    description:
      "The outline of the fight: its sections in order, the variants of any that go more than one way, and the steps under each.",
    schema: { plan_id: z.string() },
    async run(ctx, a) {
      const { plan } = await load(ctx, a.plan_id, "view");
      const lines: string[] = [];
      const count = (n: number) => `${n} step${n === 1 ? "" : "s"}`;
      plan.mechanics.forEach((m, i) => {
        lines.push(`${i + 1}. ${mechanicLabel(plan, m)} [${m.id}]`);
        if (!m.variants.length) {
          const steps = mechanicSteps(plan, m.id);
          lines.push(`   ${count(steps.length)}: ${steps.map((s) => s.name || s.id).join(", ")}`);
          return;
        }
        const all = mechanicSteps(plan, m.id);
        lines.push(`   ${count(all.length)}: ${all.map((x) => x.name || x.id).join(", ")}`);
        lines.push(
          `   goes ${m.variants
            .map((v) => {
              const casts = plan.mechs.filter((k) => k.variant === v.id);
              const only = casts.length
                ? `: ${casts.map((k) => mechLabel(plan, k)).join(", ")}`
                : "";
              return `${variantLabel(m, v.id)} [${v.id}]${only}`;
            })
            .join(" / ")} — same steps either way, different casts and party positions`
        );
      });
      return lines.join("\n") || "No mechanics yet.";
    },
  }),

  def({
    name: "add_mechanic",
    description:
      "Add a section of the fight — Witch Hunt, Electrope Edge 1 — owning a run of steps. It comes with an empty step unless you hand it steps to adopt.",
    schema: {
      plan_id: z.string(),
      name: z.string().optional(),
      after: z.string().optional().describe("Mechanic id, index or name to sit after; default last"),
      steps: z
        .array(z.string())
        .optional()
        .describe("Existing steps to put in it, by id, index or name — they move together"),
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => ({
        op: "add_mechanic",
        name: a.name,
        after: a.after ? mechanicIdOf(plan, a.after) : undefined,
        stepIds: a.steps?.map((s) => stepIdOf(plan, s)!),
      }));
      const made = res.values[0] as { id: string };
      const m = res.plan.mechanics.find((x) => x.id === made.id)!;
      return `Added mechanic ${mechanicLabel(res.plan, m)} [${m.id}] with ${mechanicSteps(res.plan, m.id).length} step(s).`;
    },
  }),

  def({
    name: "update_mechanic",
    description: "Rename a section of the fight.",
    schema: {
      plan_id: z.string(),
      mechanic: z.string().describe("Mechanic id, 1-based index or name"),
      name: z.string(),
    },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => ({
        op: "update_mechanic",
        mechanicId: mechanicIdOf(plan, a.mechanic),
        patch: { name: a.name },
      }));
      return "Mechanic updated.";
    },
  }),

  def({
    name: "delete_mechanic",
    description:
      "Delete a section of the fight. Its steps are the mechanic and go with it, unless you keep them — kept steps are merged into the neighbouring section, the one before it or the one after if it was first.",
    schema: {
      plan_id: z.string(),
      mechanic: z.string().describe("Mechanic id, 1-based index or name"),
      keep_steps: z.boolean().optional(),
    },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => ({
        op: "delete_mechanic",
        mechanicId: mechanicIdOf(plan, a.mechanic),
        keepSteps: a.keep_steps,
      }));
      return a.keep_steps ? "Mechanic deleted, its steps kept." : "Mechanic deleted with its steps.";
    },
  }),

  def({
    name: "move_mechanic",
    description:
      "Move a section of the fight earlier or later. Its whole block of steps travels with it. `to` counts from 1.",
    schema: {
      plan_id: z.string(),
      mechanic: z.string(),
      to: z.number().int().min(1).describe("Where it should sit afterwards, 1 = first"),
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => ({
        op: "move_mechanic",
        mechanicId: mechanicIdOf(plan, a.mechanic),
        index: a.to - 1,
      }));
      return (
        "The fight now goes: " +
        res.plan.mechanics.map((m, i) => `${i + 1}. ${mechanicLabel(res.plan, m)}`).join(", ")
      );
    },
  }),

  /* ---------------------------------------------------------------- mechs */

  def({
    name: "list_mechs",
    description:
      "List the plan's mechanics: which step each one snapshots in, which step it goes off in, which step its baits stop following in, and how many shapes it holds.",
    schema: { plan_id: z.string() },
    async run(ctx, a) {
      const { plan } = await load(ctx, a.plan_id, "view");
      if (!plan.mechs.length) return "No mechs yet.";
      const stepName = (id: string) => {
        const i = plan.steps.findIndex((s) => s.id === id);
        return i < 0 ? "?" : `${i + 1}. ${plan.steps[i].name}`;
      };
      return plan.mechs
        .map(
          (m, i) =>
            `${i + 1}. ${mechLabel(plan, m)} [${m.id}] — snapshots in ${stepName(m.snap)}, ` +
            `goes off in ${stepName(m.boom)}, freezes in ${stepName(freezeStep(plan, m))}, ` +
            `${mechSpan(plan, m).length} steps on the floor, ` +
            `${new Set([
              ...plan.entities.filter((e) => e.mech === m.id).map((e) => e.id),
              ...plan.steps.flatMap((step) =>
                Object.values(step.variantScenes ?? {}).flatMap((scene) =>
                  scene.filter((e) => e.mech === m.id).map((e) => e.id)
                )
              ),
            ]).size} shapes`
        )
        .join("\n");
    },
  }),

  def({
    name: "list_step_variants",
    description: "List Step-owned mutually exclusive Variant boxes and the complete Beats inside each box.",
    schema: { plan_id: z.string() },
    async run(ctx, a) {
      const { plan } = await load(ctx, a.plan_id, "view");
      if (plan.variantModel !== "step") throw new Error("This plan does not use Step-owned Variant boxes");
      const owners = plan.steps.filter((step) => stepVariants(step).length >= 2);
      if (!owners.length) return "No Step Variant splits yet.";
      return owners.map((owner) => {
        const end = plan.steps.find((step) => step.id === (owner.variantEnd || owner.id));
        const boxes = stepVariants(owner).map((variant) => {
          const beats = variant.beats.map((id) => {
            const beat = plan.mechs.find((candidate) => candidate.id === id);
            return beat ? `${mechLabel(plan, beat)} [${id}]` : `missing Beat [${id}]`;
          });
          return `${stepVariantLabel(owner, variant.id)} [${variant.id}] — ${beats.join(", ") || "empty"}`;
        });
        return `${owner.name || owner.id} [${owner.id}] → ${end?.name || end?.id || owner.id}\n   ${boxes.join("\n   ")}`;
      }).join("\n");
    },
  }),

  def({
    name: "add_step_variants",
    description: "Split one Step into two mutually exclusive Variant boxes, initially empty.",
    schema: { plan_id: z.string(), step: z.string(), second_name: z.string().optional() },
    async run(ctx, a) {
      let ownerStepId = "";
      const result = await edit(ctx, a.plan_id, (plan) => {
        if (plan.variantModel !== "step") throw new Error("This plan does not use Step-owned Variant boxes");
        ownerStepId = stepIdOf(plan, a.step)!;
        return { op: "add_step_variant", stepId: ownerStepId, name: a.second_name };
      });
      const owner = result.plan.steps.find((step) => step.id === ownerStepId)!;
      return `Created Variant boxes ${stepVariants(owner).map((variant) => `${stepVariantLabel(owner, variant.id)} [${variant.id}]`).join(" / ")}.`;
    },
  }),

  def({
    name: "rename_step_variant",
    description: "Rename one Step-owned Variant box.",
    schema: { plan_id: z.string(), step: z.string(), variant: z.string(), name: z.string() },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => {
        const ownerStepId = stepVariantOwnerIdOf(plan, a.step);
        return {
          op: "update_step_variant",
          stepId: ownerStepId,
          variantId: stepVariantIdOf(plan, ownerStepId, a.variant),
          patch: { name: a.name },
        };
      });
      return "Variant box renamed.";
    },
  }),

  def({
    name: "assign_beats_to_step_variant",
    description: "Move complete Beats into one Step Variant box, or back to Shared when variant is omitted.",
    schema: {
      plan_id: z.string(),
      step: z.string(),
      beats: z.array(z.string()).min(1),
      variant: z.string().optional(),
    },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => {
        const ownerStepId = stepVariantOwnerIdOf(plan, a.step);
        return {
          op: "assign_beats_to_step_variant",
          stepId: ownerStepId,
          beatIds: a.beats.map((beat) => mechIdOf(plan, beat)),
          variantId: a.variant ? stepVariantIdOf(plan, ownerStepId, a.variant) : undefined,
        };
      });
      return a.variant ? "Beats moved into the Variant box." : "Beats moved back to Shared.";
    },
  }),

  def({
    name: "resize_step_variant",
    description: "Move or resize a Step Variant container within its Mechanic.",
    schema: { plan_id: z.string(), step: z.string(), start: z.string(), end: z.string() },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => ({
        op: "move_step_variant_set",
        stepId: stepVariantOwnerIdOf(plan, a.step),
        snap: stepIdOf(plan, a.start)!,
        boom: stepIdOf(plan, a.end)!,
      }));
      return "Variant container resized.";
    },
  }),

  def({
    name: "collapse_step_variants",
    description: "Owner-only: promote one Variant box to Shared and delete its sibling box and Beats.",
    schema: { plan_id: z.string(), step: z.string(), variant: z.string() },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => {
        const ownerStepId = stepVariantOwnerIdOf(plan, a.step);
        return {
          op: "collapse_step_variants",
          stepId: ownerStepId,
          variantId: stepVariantIdOf(plan, ownerStepId, a.variant),
        };
      });
      return "Variant split collapsed; the chosen box is now Shared.";
    },
  }),

  def({
    name: "reset_step_variant_movement",
    description:
      "Discard a Step Variant box's actor movement at one Step so those actors follow Shared again. Name an actor to release just that one.",
    schema: {
      plan_id: z.string(),
      step: z.string(),
      owner_step: z.string(),
      variant: z.string(),
      actor: z.string().optional(),
    },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => {
        const ownerStepId = stepVariantOwnerIdOf(plan, a.owner_step);
        const stepId = stepIdOf(plan, a.step)!;
        return {
          op: "clear_step_variant_movement",
          stepId,
          variantId: stepVariantIdOf(plan, ownerStepId, a.variant),
          actorId: a.actor ? resolveRef(scenePlan(plan, stepId), a.actor).id : undefined,
        };
      });
      return "Following Shared movement again.";
    },
  }),

  def({
    name: "list_beats",
    description:
      "List timed Beats, their mutually exclusive child Variant boxes, and optional Step-local content/movement state.",
    schema: {
      plan_id: z.string(),
      step: z.string().optional().describe("Step id, index or name to include per-Variant COW state"),
    },
    async run(ctx, a) {
      const { plan } = await load(ctx, a.plan_id, "view");
      requireBeatModel(plan);
      const stepId = stepIdOf(plan, a.step);
      if (!plan.mechs.length) return "No Beats yet.";
      return plan.mechs.map((beat, index) => {
        const variants = beat.variants.map((variant) => {
          const step = stepId ? plan.steps.find((candidate) => candidate.id === stepId) : undefined;
          const content = step?.beatVariantContent?.[variant.id];
          const movement = step?.beatVariantMovement?.[variant.id] ?? {};
          const state = stepId
            ? `${content ? "Edited independently" : "Following shared"}; ${Object.keys(movement).length ? `${Object.keys(movement).length} actor movement override(s)` : "following shared movement"}`
            : "";
          return `${beatVariantLabel(beat, variant.id)} [${variant.id}]${variant.createdBy ? ` by ${variant.createdByName || variant.createdBy}` : ""}${state ? ` — ${state}` : ""}`;
        });
        return `${index + 1}. ${mechLabel(plan, beat)} [${beat.id}] — ${mechSpan(plan, beat).length} Step(s)${variants.length ? `\n   ${variants.join("\n   ")}` : " — shared only"}`;
      }).join("\n");
    },
  }),

  def({
    name: "add_beat_variant",
    description:
      "Add a mutually exclusive Variant box inside one Beat. The first call creates A and B; both initially follow that Beat's shared Parts and Step movement.",
    schema: { plan_id: z.string(), beat: z.string(), name: z.string().optional() },
    async run(ctx, a) {
      let beatId = "";
      const result = await edit(ctx, a.plan_id, (plan) => {
        requireBeatModel(plan);
        beatId = mechIdOf(plan, a.beat);
        return { op: "add_beat_variant", beatId, name: a.name };
      });
      const beat = result.plan.mechs.find((candidate) => candidate.id === beatId)!;
      return `${mechLabel(result.plan, beat)} Variants: ${beat.variants.map((variant) => `${beatVariantLabel(beat, variant.id)} [${variant.id}]`).join(" / ")}`;
    },
  }),

  def({
    name: "rename_beat_variant",
    description: "Rename one Beat-local Variant. Attribution is informational; ordinary plan editor permissions apply.",
    schema: { plan_id: z.string(), beat: z.string(), variant: z.string(), name: z.string() },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => {
        requireBeatModel(plan);
        const beatId = mechIdOf(plan, a.beat);
        return { op: "update_beat_variant", beatId, variantId: beatVariantIdOf(plan, beatId, a.variant), patch: { name: a.name } };
      });
      return "Beat Variant renamed.";
    },
  }),

  def({
    name: "duplicate_beat_variant",
    description:
      "Duplicate a Beat Variant across every Step. Content and movement are deep-copied with fresh private Part ids and internal references.",
    schema: { plan_id: z.string(), beat: z.string(), variant: z.string(), name: z.string().optional() },
    async run(ctx, a) {
      const result = await edit(ctx, a.plan_id, (plan) => {
        requireBeatModel(plan);
        const beatId = mechIdOf(plan, a.beat);
        return { op: "duplicate_beat_variant", beatId, variantId: beatVariantIdOf(plan, beatId, a.variant), name: a.name };
      });
      const made = result.values[0] as { id: string };
      return `Beat Variant duplicated [${made.id}].`;
    },
  }),

  def({
    name: "delete_beat_variant",
    description: "Delete one Beat-local Variant and its Step-local content/movement. The owner may always perform this destructive edit.",
    schema: { plan_id: z.string(), beat: z.string(), variant: z.string() },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => {
        requireBeatModel(plan);
        const beatId = mechIdOf(plan, a.beat);
        return { op: "delete_beat_variant", beatId, variantId: beatVariantIdOf(plan, beatId, a.variant) };
      });
      return "Beat Variant deleted.";
    },
  }),

  def({
    name: "collapse_beat_variants",
    description:
      "Owner-only destructive exit from one Beat's branching. Promote the chosen Variant's content and movement at every Step to Shared, then remove all sibling Variant boxes.",
    schema: { plan_id: z.string(), beat: z.string(), variant: z.string() },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => {
        requireBeatModel(plan);
        const beatId = mechIdOf(plan, a.beat);
        return {
          op: "collapse_beat_variants",
          beatId,
          variantId: beatVariantIdOf(plan, beatId, a.variant),
        };
      });
      return "Beat Variants collapsed; the chosen branch is now Shared.";
    },
  }),

  def({
    name: "reset_beat_variant_step",
    description:
      "Resume shared Beat content, clear sparse actor movement, or reset both independent domains for one Beat Variant at one Step.",
    schema: {
      plan_id: z.string(),
      beat: z.string(),
      variant: z.string(),
      step: z.string(),
      domain: z.enum(["content", "movement", "both"]),
    },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => {
        requireBeatModel(plan);
        const beatId = mechIdOf(plan, a.beat);
        const variantId = beatVariantIdOf(plan, beatId, a.variant);
        const stepId = stepIdOf(plan, a.step)!;
        if (!mechSpan(plan, plan.mechs.find((candidate) => candidate.id === beatId)!).includes(stepId))
          throw new Error("That Beat is not active in the chosen Step");
        return {
          op: a.domain === "content"
            ? "resume_beat_variant_content"
            : a.domain === "movement"
              ? "clear_beat_variant_movement"
              : "reset_beat_variant_step",
          stepId,
          variantId,
        };
      });
      return a.domain === "content" ? "Following shared Beat Parts again." : a.domain === "movement" ? "Following shared Step movement again." : "Beat Variant Step reset to shared content and movement.";
    },
  }),

  def({
    name: "list_beat_variant_routes",
    description: "List saved non-owning Variant-selection Routes and the document default.",
    schema: { plan_id: z.string() },
    async run(ctx, a) {
      const { plan } = await load(ctx, a.plan_id, "view");
      const routes = plan.variantRoutes ?? [];
      if (!routes.length) return "No saved Variant Routes.";
      return routes.map((route, index) => {
        const choices = Object.entries(route.selections).map(([ownerId, variantId]) => {
          if (plan.variantModel === "step") {
            const owner = plan.steps.find((candidate) => candidate.id === ownerId);
            return owner ? `${owner.name || owner.id}=${stepVariantLabel(owner, variantId)}` : `${ownerId}=${variantId}`;
          }
          const beat = plan.mechs.find((candidate) => candidate.id === ownerId);
          return beat ? `${mechLabel(plan, beat)}=${beatVariantLabel(beat, variantId)}` : `${ownerId}=${variantId}`;
        });
        return `${index + 1}. ${route.name} [${route.id}]${route.id === plan.defaultVariantRoute ? " (default)" : ""}${route.compatibility ? " (compatibility)" : ""} — ${choices.join(", ")}`;
      }).join("\n");
    },
  }),

  def({
    name: "save_beat_variant_route",
    description:
      "Save a complete conflict-free Variant preview as a non-owning Route. Step-box plans use declaring Steps as keys; Beat plans use Beats.",
    schema: { plan_id: z.string(), name: z.string().optional(), selections: z.record(z.string(), z.string()), make_default: z.boolean().optional() },
    async run(ctx, a) {
      const result = await edit(ctx, a.plan_id, (plan) => {
        const selections = resolvedRouteSelections(plan, a.selections);
        const errors = routeSelectionErrors(plan, selections);
        if (errors.length) throw new Error(errors.join("; "));
        return { op: "add_beat_variant_route", name: a.name, selections };
      });
      const route = result.values[0] as { id: string };
      if (a.make_default)
        await edit(ctx, a.plan_id, () => ({ op: "set_default_beat_variant_route", routeId: route.id }));
      return `Saved Variant Route [${route.id}]${a.make_default ? " as the document default" : ""}.`;
    },
  }),

  def({
    name: "update_beat_variant_route",
    description: "Rename a saved Route or replace its complete conflict-free Variant selection map.",
    schema: { plan_id: z.string(), route: z.string(), name: z.string().optional(), selections: z.record(z.string(), z.string()).optional() },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => ({
        op: "update_beat_variant_route",
        routeId: routeIdOf(plan, a.route),
        patch: { name: a.name, selections: a.selections ? resolvedRouteSelections(plan, a.selections) : undefined },
      }));
      return "Beat Variant Route updated.";
    },
  }),

  def({
    name: "delete_beat_variant_route",
    description: "Delete a saved Beat Variant Route. Beat content and movement are not owned by Routes.",
    schema: { plan_id: z.string(), route: z.string() },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => ({ op: "delete_beat_variant_route", routeId: routeIdOf(plan, a.route) }));
      return "Beat Variant Route deleted.";
    },
  }),

  def({
    name: "set_default_beat_variant_route",
    description: "Choose the plan's document-owned default Route, or clear it. Browser preview overrides remain session-only.",
    schema: { plan_id: z.string(), route: z.string().optional() },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => ({
        op: "set_default_beat_variant_route",
        routeId: a.route ? routeIdOf(plan, a.route) : undefined,
      }));
      return a.route ? "Default Beat Variant Route changed." : "Document default Route cleared.";
    },
  }),

  def({
    name: "add_mech",
    description:
      "Add a mechanic: one cast, spanning the step it snapshots in to the step it goes off in. Shapes put in it are visible for exactly that span and are aimed at where people stood at the snapshot — put a zone in one with `mech` on add_zone, or move an existing one with assign_mech.",
    schema: {
      plan_id: z.string(),
      name: z.string().optional().describe("Defaults to whatever goes in it first"),
      snapshot_in: z.string().optional().describe("Step id, index or name. Defaults to the first step"),
      goes_off_in: z.string().optional().describe("Step id, index or name. Defaults to the snapshot step"),
      freezes_in: z.string().optional().describe("Step id, index or name: the last step its baits, anchors and tethers follow their targets in. Only a Beat of three or more steps has a choice — it must sit between the snapshot and the step before it goes off. Defaults to the snapshot step"),
      color: z.string().optional().describe("Hex colour its shapes are drawn in. Defaults to the least-used of the palette"),
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => ({
        op: "add_mech",
        name: a.name,
        snap: stepIdOf(plan, a.snapshot_in) ?? plan.steps[0]?.id,
        boom: stepIdOf(plan, a.goes_off_in),
        freeze: stepIdOf(plan, a.freezes_in),
        color: a.color,
      }));
      const mech = res.values[0] as { id: string };
      return `Mech ${mechLabel(res.plan, res.plan.mechs.find((m) => m.id === mech.id)!)} added [${mech.id}].`;
    },
  }),

  def({
    name: "update_mech",
    description:
      "Rename a mechanic, recolour it, or move where it snapshots, freezes or goes off. Its baits, anchors and tethers follow their targets up to the step it freezes in and hold that pose from there to the explosion; pass an empty string to freeze at the snapshot again. Only a Beat spanning three or more steps has anywhere to put the marker.",
    schema: {
      plan_id: z.string(),
      mech: z.string().describe("Mech id, 1-based index or name"),
      name: z.string().optional(),
      snapshot_in: z.string().optional().describe("Step id, index or name"),
      goes_off_in: z.string().optional().describe("Step id, index or name"),
      freezes_in: z.string().optional().describe('Step id, index or name: the last step its baits, anchors and tethers follow their targets in. Must be between the snapshot and the step before it goes off; "" freezes at the snapshot'),
      color: z.string().optional().describe("Hex colour its shapes are drawn in"),
      locked: z.boolean().optional().describe("Lock every Part in it: a click on the canvas goes through them"),
    },
    async run(ctx, a) {
      // Resolved on the way in: after a rename the name it was found by is gone.
      let mechId = "";
      const res = await edit(ctx, a.plan_id, (plan) => ({
        op: "update_mech",
        mechId: (mechId = mechIdOf(plan, a.mech)),
        patch: {
          name: a.name,
          snap: stepIdOf(plan, a.snapshot_in),
          boom: stepIdOf(plan, a.goes_off_in),
          freeze: a.freezes_in === "" ? "" : stepIdOf(plan, a.freezes_in),
          color: a.color,
          locked: a.locked,
        },
      }));
      const m = res.plan.mechs.find((x) => x.id === mechId)!;
      return (
        `${mechLabel(res.plan, m)} is on the floor for ${mechSpan(res.plan, m).length} step(s), ` +
        `and its baits and tethers follow until step ${res.plan.steps.findIndex((s) => s.id === freezeStep(res.plan, m)) + 1}.`
      );
    },
  }),

  def({
    name: "merge_mechs",
    description:
      "Fold Beats into one. Everything they held becomes the target's, the target stretches to cover every span it swallowed, and the others are deleted.",
    schema: {
      plan_id: z.string(),
      into: z.string().describe("The Beat that survives: id, 1-based index or name"),
      mechs: z.array(z.string()).min(1).describe("Beats to fold into it: ids, indexes or names"),
    },
    async run(ctx, a) {
      let into = "";
      const res = await edit(ctx, a.plan_id, (plan) => ({
        op: "merge_mechs",
        into: (into = mechIdOf(plan, a.into)),
        mechIds: a.mechs.map((m) => mechIdOf(plan, m)),
      }));
      const m = res.plan.mechs.find((x) => x.id === into)!;
      return `${mechLabel(res.plan, m)} now holds ${res.plan.entities.filter((e) => e.mech === into).length} Part(s) over ${mechSpan(res.plan, m).length} step(s).`;
    },
  }),

  def({
    name: "assign_mech",
    description: "Put existing shapes into a mechanic, so they are timed and aimed by it. Pass mech empty to take them out again.",
    schema: {
      plan_id: z.string(),
      ids: z.array(z.string()).describe("Entity ids"),
      mech: z.string().describe("Mech id, index or name; empty string to unassign"),
      ...stepArg,
    },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => {
        const stepId = stepIdOf(plan, a.step);
        return {
          op: "assign_mech",
          ids: a.ids,
          mechId: a.mech ? mechIdOf(plan, a.mech) : null,
          stepId,
          variant: poseVariant(plan, stepId, a.variant, a.beat),
        };
      });
      return a.mech ? `${a.ids.length} shape(s) moved into the mech.` : `${a.ids.length} shape(s) taken out of their mech.`;
    },
  }),

  def({
    name: "delete_mech",
    description: "Delete a mechanic. Its shapes go with it unless you keep them, in which case they become plan-wide.",
    schema: {
      plan_id: z.string(),
      mech: z.string().describe("Mech id, 1-based index or name"),
      keep_shapes: z.boolean().optional(),
    },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => ({
        op: "delete_mech",
        mechId: mechIdOf(plan, a.mech),
        keepEntities: a.keep_shapes,
      }));
      return a.keep_shapes ? "Mech deleted, its shapes kept." : "Mech deleted with everything in it.";
    },
  }),

  /* ------------------------------------------------------------- entities */

  def({
    name: "add_player",
    description: "Add a party member token.",
    schema: {
      plan_id: z.string(),
      job: z.string().describe(`Job (${JOB_IDS.join(", ")}), role (tank/healer/melee/ranged/caster) or slot (MT, H1, M2)`),
      name: z.string().optional().describe("Label, e.g. MT or a player name"),
      icon: z.string().optional().describe("Override the art, e.g. actor/tank1 (see list_assets)"),
      rotation: z.number().optional().describe("Facing in degrees, 0 = north"),
      show_facing: z.boolean().optional(),
      ...stepArg,
      ...posArgs,
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => {
        const stepId = stepIdOf(plan, a.step);
        const variant = poseVariant(plan, stepId, a.variant, a.beat);
        return { op: "add_entity", stepId, variant, spec: {
          type: "player",
          job: a.job,
          name: a.name,
          icon: a.icon,
          rotation: a.rotation,
          showFacing: a.show_facing,
          ...positionOf(plan, a),
        } };
      });
      return `Added player ${idOf(res.values[0])}`;
    },
  }),

  def({
    name: "add_enemy",
    description:
      "Add a boss, an add, or any object a mechanic comes out of — an orb, a portal, a crystal. " +
      "Small ones (size ~60) are what you point a bait's `from` at when the source is not the boss. " +
      "`anchor` makes a bare point instead of a creature: not part of the cast but a Part like any shape, " +
      "so it lives in a Beat and is on the floor for exactly as long as what it fires.",
    schema: {
      plan_id: z.string(),
      name: z.string().optional(),
      anchor: z
        .boolean()
        .optional()
        .describe("A bare bait anchor — a place a mechanic fires from, drawn as a reticle"),
      mech: z
        .string()
        .optional()
        .describe(
          "With `anchor`: the Beat it joins (id, index or name); leave it out and a new Beat is made for it in `step`"
        ),
      size: z.number().positive().optional().describe("Hitbox radius in arena units"),
      icon: z.string().optional().describe("Override the art, e.g. actor/enemy2 (see list_assets)"),
      rotation: z.number().optional().describe("Facing in degrees, 0 = north"),
      color: z.string().optional(),
      locked: z
        .boolean()
        .optional()
        .describe("Locked things are skipped by a click on the canvas and unlocked by right-click. Defaults to true for a creature, false for an anchor"),
      ...stepArg,
      ...posArgs,
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => {
        const stepId = stepIdOf(plan, a.step);
        const variant = poseVariant(plan, stepId, a.variant, a.beat);
        // Only an anchor takes a Beat: a boss and its adds are the cast, there
        // for the whole fight, and belong to no one mechanic.
        const beat = a.anchor ? beatFor(plan, a.mech, stepId, a.name ?? "anchor") : undefined;
        return [
          ...(beat?.prelude ?? []),
          { op: "add_entity" as const, stepId, variant, spec: {
            type: "enemy",
            name: a.name,
            // An anchor is a reticle, not a creature: no art, no facing.
            ...(a.anchor ? { role: "anchor", showFacing: false } : {}),
            size: a.size ?? (a.anchor ? 60 : undefined),
            icon: a.icon,
            rotation: a.rotation,
            color: a.color,
            // The boss is the biggest thing on the floor, so it would otherwise
            // be the easiest thing to grab by mistake.
            locked: a.locked ?? !a.anchor,
            mech: beat?.mech,
            declaredIn: beat ? stepId : undefined,
            ...positionOf(plan, a),
          } },
        ];
      });
      return `Added enemy ${idOf(res.values.at(-1))}`;
    },
  }),

  def({
    name: "add_marker",
    description: "Add one waymark (A-D, 1-4).",
    schema: { plan_id: z.string(), marker: z.enum(MARKER_IDS), size: z.number().optional(), ...posArgs },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => ({
        op: "add_entity",
        spec: { type: "marker", marker: a.marker, size: a.size, ...positionOf(plan, a) },
      }));
      return `Added waymark ${a.marker} (${idOf(res.values[0])})`;
    },
  }),

  def({
    name: "add_waymarks",
    description:
      "Place the standard waymark set — clockwise from north: A, 2, B, 3, C, 4, D, 1. Markers the plan already has are moved into place, so this also resets a scrambled set.",
    schema: {
      plan_id: z.string(),
      distance: z.number().min(0).max(1.2).optional(),
    },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, () => ({ op: "add_waymarks", distance: a.distance }));
      return "Waymarks placed. Save them for the fight with save_encounter.";
    },
  }),

  def({
    name: "arrange_party",
    description:
      "Move the players already in the plan onto the PF clock, just inside the waymark ring — clockwise from north: MT, R2, H2, M2, OT, M1, H1, R1. Names like D1-D4 map to the melee/ranged slots.",
    schema: {
      plan_id: z.string(),
      distance: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Ring radius as a fraction of the arena radius (default 0.25)"),
      ...stepArg,
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => ({
        op: "arrange_party",
        radiusFraction: a.distance,
        stepId: stepIdOf(plan, a.step),
        variant: poseVariant(plan, stepIdOf(plan, a.step), a.variant, a.beat),
      }));
      return `Arranged ${(res.values[0] as string[]).length} players.`;
    },
  }),

  def({
    name: "add_party",
    description:
      "Restore a standard 8-player party (MT/OT/H1/H2/M1/M2/R1/R2) and align it to PF clock positions. Existing players are reused, only missing members are added, extras are preserved, and an already aligned party is unchanged.",
    schema: {
      plan_id: z.string(),
      jobs: z
        .array(z.object({ job: z.string(), name: z.string() }))
        .optional()
        .describe("Custom composition; defaults to PLD/WAR/WHM/SCH/SAM/DRG/BRD/BLM"),
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, () => ({ op: "add_party", party: a.jobs }));
      const changed = (res.values[0] as string[]).length;
      return changed ? `Restored or aligned ${changed} players.` : "Party was already complete and aligned.";
    },
  }),

  def({
    name: "add_zone",
    description:
      "Add an AoE / mechanic zone. circle, donut, proximity: radius (+inner_radius). cone: radius + angle + rotation. rect, line, knockback, arrow: width + length + rotation. cross: width (bar) + length (end to end) + rotation (0 = +, 45 = ×). stack, spread, tower: radius + soak. exaflare: radius + count + rotation.",
    schema: {
      plan_id: z.string(),
      shape: z.enum(ZONE_SHAPES),
      name: z.string().optional(),
      radius: z.number().positive().optional(),
      inner_radius: z.number().min(0).optional(),
      angle: z.number().min(1).max(360).optional().describe("Cone width in degrees"),
      width: z.number().positive().optional(),
      length: z.number().positive().optional(),
      rotation: z.number().optional().describe("Facing in degrees, 0 = north, 90 = east"),
      count: z.number().int().min(1).max(32).optional().describe("Exaflare repeat count"),
      soak: z.number().int().min(1).max(8).optional().describe("Players a stack or tower wants"),
      color: z.string().optional().describe("CSS colour, e.g. #ff8040"),
      hollow: z.boolean().optional(),
      mech: z
        .string()
        .optional()
        .describe(
          "The Beat it joins (id, index or name). Every Part lives in a Beat, which decides which steps it is on the floor for; leave it out and a new Beat is made for it in `step`"
        ),
      ...stepArg,
      ...posArgs,
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => {
        const stepId = stepIdOf(plan, a.step);
        const variant = poseVariant(plan, stepId, a.variant, a.beat);
        const beat = beatFor(plan, a.mech, stepId, a.name ?? a.shape);
        return [...beat.prelude, {
          op: "add_entity",
          stepId,
          variant,
          spec: {
            type: "zone",
            shape: a.shape,
            name: a.name,
            radius: a.radius,
            innerRadius: a.inner_radius,
            angle: a.angle,
            width: a.width,
            length: a.length,
            rotation: a.rotation,
            count: a.count,
            soak: a.soak,
            color: a.color,
            hollow: a.hollow,
            mech: beat.mech,
            ...positionOf(plan, a),
          },
        }];
      });
      return `Added ${a.shape} zone ${idOf(res.values.at(-1))}`;
    },
  }),

  def({
    name: "add_text",
    description: "Add a text label to the arena.",
    schema: {
      plan_id: z.string(),
      text: z.string(),
      size: z.number().positive().optional(),
      color: z.string().optional(),
      mech: z
        .string()
        .optional()
        .describe(
          "The Beat it joins (id, index or name). Every Part lives in a Beat, which decides which steps it is on the floor for; leave it out and a new Beat is made for it in `step`"
        ),
      ...stepArg,
      ...posArgs,
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => {
        const stepId = stepIdOf(plan, a.step);
        const variant = poseVariant(plan, stepId, a.variant, a.beat);
        const beat = beatFor(plan, a.mech, stepId, a.text);
        return [...beat.prelude, {
          op: "add_entity",
          stepId,
          variant,
          spec: {
            type: "text",
            text: a.text,
            fontSize: a.size,
            color: a.color,
            mech: beat.mech,
            ...positionOf(plan, a),
          },
        }];
      });
      return `Added text ${idOf(res.values.at(-1))}`;
    },
  }),

  def({
    name: "add_tether",
    description: "Tether two entities together.",
    schema: {
      plan_id: z.string(),
      from: z.string().describe("Entity id, name or job"),
      to: z.string(),
      style: z.enum(TETHER_STYLES).optional(),
      color: z.string().optional(),
      mech: z
        .string()
        .optional()
        .describe(
          "The Beat it joins (id, index or name). Every Part lives in a Beat, which decides which steps it is on the floor for; leave it out and a new Beat is made for it in `step`"
        ),
      ...stepArg,
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => {
        const stepId = stepIdOf(plan, a.step);
        const variant = poseVariant(plan, stepId, a.variant, a.beat);
        const visible = scenePlan(plan, stepId, variant);
        const beat = beatFor(plan, a.mech, stepId, "Tether");
        return [...beat.prelude, {
          op: "add_entity",
          stepId,
          variant,
          spec: {
            type: "tether",
            from: resolveRef(visible, a.from).id,
            to: resolveRef(visible, a.to).id,
            style: a.style,
            color: a.color,
            mech: beat.mech,
          },
        }];
      });
      return `Added tether ${idOf(res.values.at(-1))}`;
    },
  }),

  def({
    name: "add_bait",
    description:
      "A mechanic that belongs to whoever it targets, not to a spot on the floor. The shape is " +
      "re-solved every time the plan is drawn, so it stays true as the party moves — in every " +
      "step, with no overrides to maintain. Give it either `on` (named players: one bait each) " +
      "or `pick` (closest/farthest, where `count` is how many of them one bait covers), which is what a " +
      "proximity-baited mechanic actually does: rearrange the party and the AoE re-targets. " +
      "kinds: beam and cone fire from `from` through the target (out to the wall by default); " +
      "donut, spread, puddle, stack, tower, proximity, cross sit on the target; tether links the two. " +
      "A cross is two bars through the target: rotation 0 is a +, 45 an ×. " +
      "Or give `along` (a tether) instead of on/pick/from: a beam, cone or linestack then fires down " +
      "that tether, out of its enemy end, and follows it when it is re-paired.",
    schema: {
      plan_id: z.string(),
      kind: z.enum(BAIT_KINDS),
      on: z
        .string()
        .optional()
        .describe("Named targets: an id, name, job or slot — comma-separated for several"),
      pick: z
        .enum(BAIT_RULES)
        .optional()
        .describe("Instead of `on`: bait whoever is closest to (or farthest from) `from`"),
      count: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe(
          "With `pick`: how many targets this one bait covers, so `closest` + 2 is a single bait on the two nearest players"
        ),
      of: z.enum(["player", "enemy", "any"]).optional().describe("With `pick`: what counts as a target"),
      from: z
        .string()
        .optional()
        .describe("What the beam/cone/tether comes out of: the boss, an add, an orb, any entity"),
      along: z
        .string()
        .optional()
        .describe(
          "Instead of on/pick/from: a tether id or name for a beam, cone or linestack to fire down. It joins the tether's Beat unless `mech` says otherwise"
        ),
      name: z.string().optional().describe("Mechanic name; each bait gets the target appended"),
      radius: z.number().positive().optional(),
      inner_radius: z.number().min(0).optional(),
      width: z.number().positive().optional().describe("Beam width, or a cross's bar width"),
      length: z.number().positive().optional().describe("Beam length, if not extending to the wall, or a cross's span end to end"),
      rotation: z.number().optional().describe("Cross: 0 = +, 45 = ×. Aimed kinds take their facing from the aim instead"),
      angle: z.number().min(1).max(360).optional().describe("Cone width in degrees"),
      soak: z.number().int().min(1).max(8).optional(),
      style: z.enum(TETHER_STYLES).optional(),
      color: z.string().optional(),
      extend: z
        .boolean()
        .optional()
        .describe("Aimed kinds: reach the arena wall (default true) instead of using length/radius"),
      mech: z
        .string()
        .optional()
        .describe(
          "The Beat it joins (id, index or name). Every Part lives in a Beat, which decides which steps it is on the floor for; leave it out and a new Beat is made for it in `step`"
        ),
      ...stepArg,
    },
    async run(ctx, a) {
      const named = (a.on ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (a.along) {
        if (named.length || a.pick || a.from) throw new Error("`along` replaces on, pick and from: give it alone");
        if (!baitNeedsSource(a.kind) || a.kind === "tether")
          throw new Error("Only a beam, cone or linestack can fire along a tether");
      } else {
        if (!named.length && !a.pick)
          throw new Error("Give `on` (named targets), `pick` (closest/farthest) or `along` (a tether)");
        if (named.length && a.pick) throw new Error("Give either `on` or `pick`, not both");
      }

      const props = {
        radius: a.radius,
        innerRadius: a.inner_radius,
        width: a.width,
        length: a.length,
        angle: a.angle,
        rotation: a.rotation,
        soak: a.soak,
        style: a.style,
        color: a.color,
        extend: a.extend,
      };

      let labels: string[] = [];
      const res = await edit(ctx, a.plan_id, (plan) => {
        const stepId = stepIdOf(plan, a.step);
        const variant = poseVariant(plan, stepId, a.variant, a.beat);
        const visible = scenePlan(plan, stepId, variant);
        const source = a.from ? resolveRef(visible, a.from).id : undefined;
        const tether = a.along ? resolveRef(visible, a.along) : undefined;
        if (tether && tether.type !== "tether") throw new Error(`${a.along} is not a tether`);
        const beat = beatFor(plan, a.mech ?? tether?.mech, stepId, a.name ?? a.kind);
        labels = [];

        if (tether?.type === "tether") {
          // Built as an ordinary aimed bait, then bound to the tether alone:
          // named ends of its own would go stale when the tether is re-paired.
          const spec = baitSpec(a.kind, tether.to, tether.from, { ...props, name: a.name, mech: beat.mech });
          const { extend } = spec.anchor as { extend?: boolean };
          labels.push(`along ${tether.name ?? tether.id}`);
          return [
            ...beat.prelude,
            {
              op: "add_entity",
              stepId,
              variant,
              spec: { ...spec, anchor: { along: tether.id, extend } },
            } satisfies Op,
          ];
        }

        if (a.pick) {
          // Several targets is one bait with a count, not one bait per slot of
          // the targeting: the mechanic is a single thing the plan can restyle,
          // move or retarget in one edit.
          const count = a.count ?? 1;
          labels.push(count > 1 ? `${count} ${a.pick}` : (a.pick as string));
          return [
            ...beat.prelude,
            {
              op: "add_entity",
              stepId,
              variant,
              spec: baitSpec(a.kind, { pick: a.pick, count, of: a.of }, source, {
                ...props,
                name: a.name,
                mech: beat.mech,
              }),
            } satisfies Op,
          ];
        }

        return [...beat.prelude, ...named.map((ref) => {
          const target = resolveRef(visible, ref);
          labels.push(target.name ?? target.id);
          return {
            op: "add_entity",
            stepId,
            variant,
            spec: baitSpec(a.kind, target.id, source, {
              ...props,
              name: a.name ? `${a.name} ${target.name ?? ref}` : undefined,
              mech: beat.mech,
            }),
          } satisfies Op;
        })];
      });

      const ids = res.values.slice(res.values.length - labels.length).map((v: unknown) => idOf(v));
      const what = labels.map((l, i) => `${l} [${ids[i]}]`).join(", ");
      if (a.along)
        return `Added a ${a.kind} ${what}. It fires down the tether and follows it when it is re-paired.`;
      if (a.pick) {
        const covered = a.count ?? 1;
        const who = `the ${covered > 1 ? `${covered} ` : ""}${a.pick} ${a.of ?? "player"}${covered > 1 ? "s" : ""}`;
        return `Added one ${a.kind} bait on ${who}: ${what}. It draws ${covered > 1 ? `${covered} shapes` : "one shape"} and re-targets itself whenever the party moves.`;
      }
      return `Added ${ids.length} ${a.kind} bait${ids.length > 1 ? "s" : ""}: ${what}. They follow their targets — no need to reposition them per step.`;
    },
  }),

  def({
    name: "move_entity",
    description:
      "Move (and optionally turn) an entity. With `step`, the move applies to that step only and the entity keeps its pose elsewhere — this is how you choreograph movement between steps.",
    schema: {
      plan_id: z.string(),
      entity: z.string().describe("Entity id, name, or job — e.g. 'MT', 'WAR', 'player_ab12cd34'"),
      rotation: z.number().optional(),
      ...stepArg,
      ...posArgs,
    },
    async run(ctx, a) {
      let moved = { id: "", x: 0, y: 0, step: "" };
      await edit(ctx, a.plan_id, (plan) => {
        const stepId = stepIdOf(plan, a.step);
        const variant = poseVariant(plan, stepId, a.variant, a.beat);
        const target = resolveRef(scenePlan(plan, stepId, variant), a.entity);
        const pos = positionOf(plan, a);
        // Report where it ends up, which for a step override is not its base pose.
        moved = {
          id: target.id,
          x: pos.x ?? target.x,
          y: pos.y ?? target.y,
          step:
            stepId && target.type !== "marker"
              ? ` in step ${plan.steps.find((s) => s.id === stepId)?.name}`
              : target.type === "marker"
                ? " — waymarks move in every step"
                : "",
        };
        return {
          op: "update_entity",
          id: target.id,
          patch: { ...pos, ...(a.rotation !== undefined ? { rotation: a.rotation } : {}) },
          stepId,
          variant,
        };
      });
      return `Moved ${moved.id} to (${Math.round(moved.x)}, ${Math.round(moved.y)})${moved.step}`;
    },
  }),

  def({
    name: "update_entity",
    description:
      "Patch any property of an entity (color, size, radius, job, text, name, hidden, rotation…). With `step`, the patch becomes a per-step override.",
    schema: {
      plan_id: z.string(),
      entity: z.string(),
      patch: z
        .record(z.string(), z.unknown())
        .describe("Properties to set, e.g. { \"radius\": 200, \"color\": \"#ff0000\" }"),
      ...stepArg,
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => {
        const stepId = stepIdOf(plan, a.step);
        const variant = poseVariant(plan, stepId, a.variant, a.beat);
        return {
          op: "update_entity",
          id: resolveRef(scenePlan(plan, stepId, variant), a.entity).id,
          patch: a.patch,
          stepId,
          variant,
        };
      });
      return `Updated ${idOf(res.values[0])}`;
    },
  }),

  def({
    name: "delete_entity",
    description: "Delete one or more entities.",
    schema: { plan_id: z.string(), entities: z.array(z.string()).min(1), ...stepArg },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => {
        const stepId = stepIdOf(plan, a.step);
        const variant = poseVariant(plan, stepId, a.variant, a.beat);
        const visible = scenePlan(plan, stepId, variant);
        return {
          op: "delete_entities",
          ids: a.entities.map((ref) => resolveRef(visible, ref).id),
          stepId,
          variant,
        };
      });
      return `Deleted ${(res.values[0] as string[]).length} entities.`;
    },
  }),

  def({
    name: "find_entities",
    description: "Search a plan's entities by text, type or job.",
    schema: {
      plan_id: z.string(),
      query: z.string().optional(),
      type: z.enum(ENTITY_TYPES as [string, ...string[]]).optional(),
      ...stepArg,
    },
    async run(ctx, a) {
      const { plan } = await load(ctx, a.plan_id, "view");
      const stepId = stepIdOf(plan, a.step);
      const variant = poseVariant(plan, stepId, a.variant, a.beat);
      const hits = findEntities(scenePlan(plan, stepId, variant), {
        text: a.query,
        type: a.type as never,
      });
      if (!hits.length) return "No matches.";
      return hits
        .map((e) => `- [${e.id}] ${e.type}${e.name ? ` "${e.name}"` : ""} at (${Math.round(e.x)}, ${Math.round(e.y)})`)
        .join("\n");
    },
  }),

  def({
    name: "list_assets",
    description:
      "List the bundled FFXIV art you can reference: job/role/enemy tokens (actor/…), field markers (marker/…), encounter telegraphs such as stack, tower, gaze, proximity and knockback (mechanic/…), and arena backdrops (arena/…).",
    schema: {
      kind: z.enum(["actor", "marker", "mechanic", "arena"]).describe("Which catalogue to list"),
      query: z.string().optional().describe("Substring filter, e.g. 'attack' or 'p12'"),
    },
    async run(_ctx, a) {
      const q = a.query?.toLowerCase();
      if (a.kind === "arena") {
        const hits = ARENA_BACKGROUNDS.filter((b) => !q || b.key.toLowerCase().includes(q));
        return hits.map((b) => `- ${b.key} — ${b.label}`).join("\n") || "No matches.";
      }
      const keys = a.kind === "actor" ? ACTOR_KEYS : a.kind === "mechanic" ? MECHANIC_KEYS : MARKER_KEYS;
      const hits = keys.filter((k) => !q || k.toLowerCase().includes(q));
      return hits.join("\n") || "No matches.";
    },
  }),

  def({
    name: "add_icon",
    description:
      "Place bundled FFXIV art on the arena — field markers or encounter telegraphs such as stack, tower, gaze, proximity, tankbuster and knockback. Use list_assets to see them all.",
    schema: {
      plan_id: z.string(),
      icon: z.string().describe("Asset key, e.g. marker/attack1, or an image URL"),
      name: z.string().optional(),
      size: z.number().positive().optional(),
      mech: z
        .string()
        .optional()
        .describe(
          "The Beat it joins (id, index or name). Every Part lives in a Beat, which decides which steps it is on the floor for; leave it out and a new Beat is made for it in `step`"
        ),
      ...stepArg,
      ...posArgs,
    },
    async run(ctx, a) {
      if (!/^(https?:|\/)/.test(a.icon) && !ASSETS[a.icon])
        throw new Error(`Unknown asset "${a.icon}". Use list_assets to find one.`);
      const res = await edit(ctx, a.plan_id, (plan) => {
        const stepId = stepIdOf(plan, a.step);
        const variant = poseVariant(plan, stepId, a.variant, a.beat);
        const beat = beatFor(plan, a.mech, stepId, a.name ?? "Icon");
        return [...beat.prelude, {
          op: "add_entity",
          stepId,
          variant,
          spec: {
            type: "icon",
            src: a.icon,
            name: a.name,
            size: a.size,
            mech: beat.mech,
            ...positionOf(plan, a),
          },
        }];
      });
      return `Added icon ${idOf(res.values.at(-1))}`;
    },
  }),

  /* ----------------------------------------------------------- encounters */

  def({
    name: "save_encounter",
    description:
      "Remember this plan's arena and waymark positions as the setup for its encounter. Every later plan for that fight starts from them.",
    schema: {
      plan_id: z.string(),
      encounter: z.string().optional().describe("Defaults to the plan's own encounter"),
    },
    async run(ctx, a) {
      const { plan } = await load(ctx, a.plan_id, "edit");
      const encounter = a.encounter ?? plan.encounter;
      if (!encounter)
        throw new Error("This plan has no encounter — set one with set_plan_info, or pass `encounter`.");
      const setup = encounterSetup(plan);
      await registry(ctx.env).saveEncounter(ctx.userId, encounter, setup);
      if (!plan.encounter) await edit(ctx, a.plan_id, () => ({ op: "set_meta", encounter }));
      return `Saved ${setup.markers.length} waymarks and the arena as the setup for "${encounter}".`;
    },
  }),

  def({
    name: "apply_encounter",
    description:
      "Put the saved arena and waymarks for an encounter onto this plan, moving any that have drifted.",
    schema: {
      plan_id: z.string(),
      encounter: z.string().optional().describe("Defaults to the plan's own encounter"),
    },
    async run(ctx, a) {
      const { plan } = await load(ctx, a.plan_id, "edit");
      const encounter = a.encounter ?? plan.encounter;
      if (!encounter) throw new Error("This plan has no encounter — pass `encounter`.");
      const setup = await registry(ctx.env).getEncounter(ctx.userId, encounter);
      if (!setup) throw new Error(`No saved setup for "${encounter}". Use save_encounter on a plan you like.`);
      await edit(ctx, a.plan_id, () => ({ op: "apply_encounter", setup }));
      if (plan.encounter !== encounter) await edit(ctx, a.plan_id, () => ({ op: "set_meta", encounter }));
      return `Applied the "${encounter}" arena and ${setup.markers.length} waymarks.`;
    },
  }),

  def({
    name: "list_encounters",
    description: "Encounters you have saved a setup for.",
    schema: {},
    async run(ctx) {
      const saved = await registry(ctx.env).listEncounters(ctx.userId);
      if (!saved.length) return "No saved encounters yet — use save_encounter on a plan.";
      return saved.map((e) => `- ${e.encounter} — ${e.markers} waymarks`).join("\n");
    },
  }),

  /* --------------------------------------------------------------- access */

  def({
    name: "share_plan",
    description: "Give another user access to a plan (owner only).",
    schema: {
      plan_id: z.string(),
      user_id: z.string().describe("e.g. discord:123456789012345678"),
      role: z.enum(["editor", "viewer"]),
    },
    async run(ctx, a) {
      await load(ctx, a.plan_id, "own");
      await registry(ctx.env).share(a.plan_id, a.user_id, a.role);
      return `${a.user_id} now has ${a.role} access.`;
    },
  }),

  def({
    name: "set_plan_public",
    description: "Make a plan readable by anyone with the link (owner only).",
    schema: { plan_id: z.string(), public: z.boolean() },
    async run(ctx, a) {
      await load(ctx, a.plan_id, "own");
      await registry(ctx.env).setPublic(a.plan_id, a.public);
      return a.public ? `Public: ${planUrl(ctx, a.plan_id)}` : "Link sharing off.";
    },
  }),
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** How to think about the coordinate system — prepended to chat system prompts. */
export const PLAN_PRIMER = `Raid plans are top-down diagrams of an FFXIV arena.
Coordinates are arena units with the origin at the arena centre: +x is east (right), +y is south (down).
A default arena is 1000x1000, so the north wall is y = -500. Rotation is in degrees, 0 = north, increasing clockwise (90 = east).
Arena distances are yalms: a manual arena.widthYalms wins, supported encounters use known dimensions, and unknown fights default to 40 yalms across. Calibration never changes stored coordinates.
Actors (players, enemies) and waymarks are plan-wide; per-step position overrides are how movement is expressed. Every Part (zone, bait, tether, text, icon, bait anchor) lives in a Beat, which decides the steps it is on the floor for: an add without mech makes a new Beat for it in that step, and merge_mechs folds Beats together.
A Beat's baits, anchors and tethers follow their targets up to the step it freezes in (update_mech freezes_in, the snapshot by default) and are drawn where they stood there from then until it goes off. Only a Beat of three or more steps has anywhere to put that marker.
Always read_plan first so you use real entity ids, then make the smallest set of edits that expresses the intent.
A Beat is one timed card/frame. Its child Variant boxes are mutually exclusive and contain only divergent Beat Parts plus optional sparse actor movement. Shared Parts stay directly on the Beat. Preview choices and edit destinations are separate: passing beat + variant explicitly chooses where an edit is stored, never a saved preview. Saved Routes are non-owning complete Beat-selection maps and cannot contain movement conflicts. Variants exist only on Beats; Mechanic-wide Variants are retired.
A mechanic aimed at a player belongs to that player, not to a coordinate: add it with add_bait (beam, cone, donut, spread, puddle, stack, tower, proximity, cross, tether). Bait named players with "on", or model the game's own targeting with pick = "closest" / "farthest", which re-targets itself as the party moves. A mechanic that catches several people is one bait with "count" — it draws that many shapes, over the ranks after "rank" — not one bait per target. Either way it holds in every step with no overrides to redo.
Real FFXIV art is bundled: job/role tokens, waymarks A-D and 1-4, field markers (attack1-8, bind, ignore, limit cut, tankbuster) and arena backdrops. Call list_assets to browse it.`;
