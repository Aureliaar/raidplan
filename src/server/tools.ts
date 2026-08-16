import { z } from "zod";
import type { AppEnv } from "./env";
import { registry } from "./registry";
import { planStub } from "./plan-agent";
import type { Op } from "../shared/apply";
import {
  ANCHORS,
  type Anchor,
  anchorToPoint,
  createPlan,
  describePlan,
  findEntities,
  resolveRef,
} from "../shared/ops";
import {
  ARENA_SHAPES,
  ENTITY_TYPES,
  GRID_TYPES,
  MARKER_IDS,
  TETHER_STYLES,
  ZONE_SHAPES,
  type Plan,
} from "../shared/schema";
import { JOB_IDS } from "../shared/jobs";
import { ACTOR_KEYS, ARENA_BACKGROUNDS, ASSETS, MARKER_KEYS } from "../shared/assets";

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
  const { stub, plan } = await load(ctx, planId, "edit");
  const res = await stub.apply(make(plan));
  await registry(ctx.env).touchPlan(planId, { name: res.plan.name, encounter: res.plan.encounter });
  return res;
}

const planUrl = (ctx: ToolContext, id: string) => `${ctx.appUrl}/p/${id}`;
const idOf = (v: unknown) => (v as { id: string }).id;

const stepArg = {
  step: z
    .string()
    .optional()
    .describe("Step id, 1-based index or name. Omit to affect the entity in every step."),
};

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
      const draft = createPlan({ name: a.name, encounter: a.encounter, ownerId: ctx.userId });
      const stub = await planStub(ctx.env, draft.id);
      await stub.init({
        id: draft.id,
        name: a.name,
        encounter: a.encounter,
        ownerId: ctx.userId,
        withParty: a.with_party ?? true,
      });
      await registry(ctx.env).registerPlan({
        id: draft.id,
        name: a.name,
        encounter: a.encounter,
        ownerId: ctx.userId,
      });
      const follow: Op[] = [];
      if (a.arena_shape || a.arena_size)
        follow.push({
          op: "set_arena",
          patch: { shape: a.arena_shape, width: a.arena_size, height: a.arena_size },
        });
      if (a.with_waymarks) follow.push({ op: "add_waymarks" });
      if (follow.length) await stub.apply(follow);
      // Say what was seeded: a model that assumes an empty plan adds a second party.
      const seeded = [a.with_party ?? true ? "an 8-player party" : "", a.with_waymarks ? "waymarks" : ""].filter(Boolean);
      return `Created plan ${draft.id}${seeded.length ? ` with ${seeded.join(" and ")}` : " (empty)"} — ${planUrl(ctx, draft.id)}`;
    },
  }),

  def({
    name: "read_plan",
    description:
      "Read a plan as text: arena, steps, and every entity with its id and position. Call this before editing.",
    schema: {
      plan_id: z.string(),
      step: z.string().optional().describe("Step id, 1-based index or name; omit for every step"),
    },
    async run(ctx, a) {
      const { plan } = await load(ctx, a.plan_id, "view");
      return describePlan(plan, stepIdOf(plan, a.step));
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
    description: "Change the arena shape, size, grid or backdrop image.",
    schema: {
      plan_id: z.string(),
      shape: z.enum(ARENA_SHAPES).optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
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
      return plan.steps.map((s, i) => `${i + 1}. ${s.name} [${s.id}]${s.notes ? ` — ${s.notes}` : ""}`).join("\n");
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
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) =>
        a.copy_from
          ? { op: "duplicate_step", stepId: stepIdOf(plan, a.copy_from)!, name: a.name }
          : { op: "add_step", name: a.name, notes: a.notes }
      );
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
    name: "delete_step",
    description: "Delete a step.",
    schema: { plan_id: z.string(), step: z.string() },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => ({ op: "delete_step", stepId: stepIdOf(plan, a.step)! }));
      return "Step deleted.";
    },
  }),

  /* ------------------------------------------------------------- entities */

  def({
    name: "add_player",
    description: "Add a party member token.",
    schema: {
      plan_id: z.string(),
      job: z.string().describe(`Job (${JOB_IDS.join(", ")}), role (tank/healer/melee/ranged/caster) or slot (MT, H1, D3)`),
      name: z.string().optional().describe("Label, e.g. MT or a player name"),
      icon: z.string().optional().describe("Override the art, e.g. actor/tank1 (see list_assets)"),
      rotation: z.number().optional().describe("Facing in degrees, 0 = north"),
      show_facing: z.boolean().optional(),
      ...posArgs,
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => ({
        op: "add_entity",
        spec: {
          type: "player",
          job: a.job,
          name: a.name,
          icon: a.icon,
          rotation: a.rotation,
          showFacing: a.show_facing,
          ...positionOf(plan, a),
        },
      }));
      return `Added player ${idOf(res.values[0])}`;
    },
  }),

  def({
    name: "add_enemy",
    description: "Add a boss/enemy token.",
    schema: {
      plan_id: z.string(),
      name: z.string().optional(),
      size: z.number().positive().optional().describe("Hitbox radius in arena units"),
      icon: z.string().optional().describe("Override the art, e.g. actor/enemy2 (see list_assets)"),
      rotation: z.number().optional().describe("Facing in degrees, 0 = north"),
      color: z.string().optional(),
      ...posArgs,
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => ({
        op: "add_entity",
        spec: {
          type: "enemy",
          name: a.name,
          size: a.size,
          icon: a.icon,
          rotation: a.rotation,
          color: a.color,
          ...positionOf(plan, a),
        },
      }));
      return `Added enemy ${idOf(res.values[0])}`;
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
      step: z.string().optional().describe("Move them in this step only"),
    },
    async run(ctx, a) {
      await edit(ctx, a.plan_id, (plan) => ({
        op: "add_waymarks",
        distance: a.distance,
        stepId: stepIdOf(plan, a.step),
      }));
      return "Waymarks placed.";
    },
  }),

  def({
    name: "arrange_party",
    description:
      "Move the players already in the plan onto the PF clock — clockwise from north: MT, R2, H2, M2, OT, R1, H1, M1. Names like D1-D4 map to the melee/ranged slots.",
    schema: {
      plan_id: z.string(),
      distance: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Ring radius as a fraction of the arena radius (default 0.25)"),
      step: z.string().optional().describe("Arrange them in this step only"),
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => ({
        op: "arrange_party",
        radiusFraction: a.distance,
        stepId: stepIdOf(plan, a.step),
      }));
      return `Arranged ${(res.values[0] as string[]).length} players.`;
    },
  }),

  def({
    name: "add_party",
    description:
      "Add a standard 8-player party (MT/OT/H1/H2/D1-D4) in a ring near the centre. New plans already have one — use arrange_party to reposition it instead.",
    schema: {
      plan_id: z.string(),
      jobs: z
        .array(z.object({ job: z.string(), name: z.string() }))
        .optional()
        .describe("Custom composition; defaults to PLD/WAR/WHM/SCH/SAM/DRG/BRD/BLM"),
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, () => ({ op: "add_party", party: a.jobs }));
      return `Added ${(res.values[0] as string[]).length} players.`;
    },
  }),

  def({
    name: "add_zone",
    description:
      "Add an AoE / mechanic zone. circle, donut, proximity: radius (+inner_radius). cone: radius + angle + rotation. rect, line, knockback, arrow: width + length + rotation. stack, spread, tower: radius + soak. exaflare: radius + count + rotation.",
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
      ...stepArg,
      ...posArgs,
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => {
        const stepId = stepIdOf(plan, a.step);
        return {
          op: "add_entity",
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
            steps: stepId ? [stepId] : "all",
            ...positionOf(plan, a),
          },
        };
      });
      return `Added ${a.shape} zone ${idOf(res.values[0])}`;
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
      ...stepArg,
      ...posArgs,
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => {
        const stepId = stepIdOf(plan, a.step);
        return {
          op: "add_entity",
          spec: {
            type: "text",
            text: a.text,
            fontSize: a.size,
            color: a.color,
            steps: stepId ? [stepId] : "all",
            ...positionOf(plan, a),
          },
        };
      });
      return `Added text ${idOf(res.values[0])}`;
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
      ...stepArg,
    },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => {
        const stepId = stepIdOf(plan, a.step);
        return {
          op: "add_entity",
          spec: {
            type: "tether",
            from: resolveRef(plan, a.from).id,
            to: resolveRef(plan, a.to).id,
            style: a.style,
            color: a.color,
            steps: stepId ? [stepId] : "all",
          },
        };
      });
      return `Added tether ${idOf(res.values[0])}`;
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
        const target = resolveRef(plan, a.entity);
        const pos = positionOf(plan, a);
        const stepId = stepIdOf(plan, a.step);
        // Report where it ends up, which for a step override is not its base pose.
        moved = {
          id: target.id,
          x: pos.x ?? target.x,
          y: pos.y ?? target.y,
          step: stepId ? ` in step ${plan.steps.find((s) => s.id === stepId)?.name}` : "",
        };
        return {
          op: "update_entity",
          id: target.id,
          patch: { ...pos, ...(a.rotation !== undefined ? { rotation: a.rotation } : {}) },
          stepId,
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
      const res = await edit(ctx, a.plan_id, (plan) => ({
        op: "update_entity",
        id: resolveRef(plan, a.entity).id,
        patch: a.patch,
        stepId: stepIdOf(plan, a.step),
      }));
      return `Updated ${idOf(res.values[0])}`;
    },
  }),

  def({
    name: "delete_entity",
    description: "Delete one or more entities.",
    schema: { plan_id: z.string(), entities: z.array(z.string()).min(1) },
    async run(ctx, a) {
      const res = await edit(ctx, a.plan_id, (plan) => ({
        op: "delete_entities",
        ids: a.entities.map((ref) => resolveRef(plan, ref).id),
      }));
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
    },
    async run(ctx, a) {
      const { plan } = await load(ctx, a.plan_id, "view");
      const hits = findEntities(plan, { text: a.query, type: a.type as never });
      if (!hits.length) return "No matches.";
      return hits
        .map((e) => `- [${e.id}] ${e.type}${e.name ? ` "${e.name}"` : ""} at (${Math.round(e.x)}, ${Math.round(e.y)})`)
        .join("\n");
    },
  }),

  def({
    name: "list_assets",
    description:
      "List the bundled FFXIV art you can reference: job/role/enemy tokens (actor/…), field markers such as attack1-8, bind, ignore, limit-cut, tankbuster, targets (marker/…), and arena backdrops (arena/…).",
    schema: {
      kind: z.enum(["actor", "marker", "arena"]).describe("Which catalogue to list"),
      query: z.string().optional().describe("Substring filter, e.g. 'attack' or 'p12'"),
    },
    async run(_ctx, a) {
      const q = a.query?.toLowerCase();
      if (a.kind === "arena") {
        const hits = ARENA_BACKGROUNDS.filter((b) => !q || b.key.toLowerCase().includes(q));
        return hits.map((b) => `- ${b.key} — ${b.label}`).join("\n") || "No matches.";
      }
      const keys = a.kind === "actor" ? ACTOR_KEYS : MARKER_KEYS;
      const hits = keys.filter((k) => !q || k.toLowerCase().includes(q));
      return hits.join("\n") || "No matches.";
    },
  }),

  def({
    name: "add_icon",
    description:
      "Place a bundled marker icon on the arena — attack1-8, bind1-8, ignore1-8, limit1-8, tankbuster, eye, proximity, targets, shapes. Use list_assets to see them all.",
    schema: {
      plan_id: z.string(),
      icon: z.string().describe("Asset key, e.g. marker/attack1, or an image URL"),
      name: z.string().optional(),
      size: z.number().positive().optional(),
      ...stepArg,
      ...posArgs,
    },
    async run(ctx, a) {
      if (!/^(https?:|\/)/.test(a.icon) && !ASSETS[a.icon])
        throw new Error(`Unknown asset "${a.icon}". Use list_assets to find one.`);
      const res = await edit(ctx, a.plan_id, (plan) => {
        const stepId = stepIdOf(plan, a.step);
        return {
          op: "add_entity",
          spec: {
            type: "icon",
            src: a.icon,
            name: a.name,
            size: a.size,
            steps: stepId ? [stepId] : "all",
            ...positionOf(plan, a),
          },
        };
      });
      return `Added icon ${idOf(res.values[0])}`;
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
Entities live in a plan and may appear in one step or all steps; per-step position overrides are how movement is expressed.
Always read_plan first so you use real entity ids, then make the smallest set of edits that expresses the intent.
Real FFXIV art is bundled: job/role tokens, waymarks A-D and 1-4, field markers (attack1-8, bind, ignore, limit cut, tankbuster) and arena backdrops. Call list_assets to browse it.`;
