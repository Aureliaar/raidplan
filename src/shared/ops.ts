import { nanoid } from "nanoid";
import {
  type Arena,
  type Entity,
  type EntityType,
  type Plan,
  type Step,
  type PropBag,
  ArenaSchema,
  EntitySchema,
  PlanSchema,
  entitiesForStep,
  resolveEntity,
} from "./schema";
import { DEFAULT_PARTY, jobLabel } from "./jobs";

/**
 * Every mutation of a plan lives here so the canvas, the HTTP API and the MCP
 * tools all behave identically. Ops are pure: they take a plan and return a new
 * one (the caller persists it).
 */

export const newId = (prefix: string) => `${prefix}_${nanoid(8)}`;

export function touch(plan: Plan): Plan {
  return { ...plan, updatedAt: Date.now(), rev: plan.rev + 1 };
}

export function createPlan(opts: {
  id?: string;
  name?: string;
  encounter?: string;
  ownerId?: string;
  arena?: Partial<Arena>;
  withParty?: boolean;
}): Plan {
  const stepId = newId("step");
  const now = Date.now();
  const plan: Plan = PlanSchema.parse({
    id: opts.id ?? newId("plan"),
    name: opts.name ?? "Untitled plan",
    encounter: opts.encounter ?? "",
    ownerId: opts.ownerId ?? "",
    arena: ArenaSchema.parse(opts.arena ?? {}),
    steps: [{ id: stepId, name: "Step 1", notes: "" }],
    entities: [],
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
  player: { job: "any" },
  enemy: {},
  zone: { shape: "circle" },
  tether: { from: "", to: "" },
  text: { text: "text" },
  path: { points: [] },
  icon: { src: "" },
};

/** Add an entity. `spec.type` is required; everything else is defaulted. */
export function addEntity(
  plan: Plan,
  spec: PropBag & { type: EntityType }
): { plan: Plan; entity: Entity } {
  const entity = EntitySchema.parse({
    ...DEFAULTS_BY_TYPE[spec.type],
    ...spec,
    id: (spec.id as string | undefined) ?? newId(spec.type),
  });
  return { plan: touch({ ...plan, entities: [...plan.entities, entity] }), entity };
}

export function getEntity(plan: Plan, id: string): Entity | undefined {
  return plan.entities.find((e) => e.id === id);
}

/**
 * Patch an entity. With `stepId`, the patch is written as a per-step override
 * (so the entity keeps its base pose in every other step); without one it edits
 * the base properties.
 */
export function updateEntity(
  plan: Plan,
  id: string,
  patch: PropBag,
  stepId?: string
): { plan: Plan; entity: Entity } {
  const idx = plan.entities.findIndex((e) => e.id === id);
  if (idx < 0) throw new Error(`No entity ${id}`);
  const current = plan.entities[idx];

  const clean: PropBag = defined(patch);
  delete clean.id;
  delete clean.type;
  delete clean.overrides;

  let next: Entity;
  if (stepId) {
    const overrides = { ...current.overrides, [stepId]: { ...current.overrides?.[stepId], ...clean } };
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

/** Drop a step's overrides for an entity, so it reverts to its base pose. */
export function clearOverride(plan: Plan, id: string, stepId: string): Plan {
  const idx = plan.entities.findIndex((e) => e.id === id);
  if (idx < 0) throw new Error(`No entity ${id}`);
  const overrides = { ...plan.entities[idx].overrides };
  delete overrides[stepId];
  const entities = [...plan.entities];
  entities[idx] = { ...entities[idx], overrides } as Entity;
  return touch({ ...plan, entities });
}

export function deleteEntities(plan: Plan, ids: string[]): Plan {
  const gone = new Set(ids);
  const entities = plan.entities
    .filter((e) => !gone.has(e.id))
    // Tethers pointing at a deleted entity go with it.
    .filter((e) => !(e.type === "tether" && (gone.has(e.from) || gone.has(e.to))));
  return touch({ ...plan, entities });
}

export function duplicateEntity(plan: Plan, id: string, offset = 60): { plan: Plan; entity: Entity } {
  const src = getEntity(plan, id);
  if (!src) throw new Error(`No entity ${id}`);
  const copy = { ...src, id: newId(src.type), x: src.x + offset, y: src.y + offset } as Entity;
  return { plan: touch({ ...plan, entities: [...plan.entities, copy] }), entity: copy };
}

export type ZOrder = "front" | "back" | "forward" | "backward";

export function reorderEntity(plan: Plan, id: string, where: ZOrder): Plan {
  const idx = plan.entities.findIndex((e) => e.id === id);
  if (idx < 0) throw new Error(`No entity ${id}`);
  const entities = [...plan.entities];
  const [item] = entities.splice(idx, 1);
  const target =
    where === "front"
      ? entities.length
      : where === "back"
        ? 0
        : where === "forward"
          ? Math.min(entities.length, idx + 1)
          : Math.max(0, idx - 1);
  entities.splice(target, 0, item);
  return touch({ ...plan, entities });
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

export function addStep(plan: Plan, opts: { name?: string; notes?: string; index?: number } = {}): {
  plan: Plan;
  step: Step;
} {
  const step: Step = {
    id: newId("step"),
    name: opts.name ?? `Step ${plan.steps.length + 1}`,
    notes: opts.notes ?? "",
  };
  const steps = [...plan.steps];
  steps.splice(opts.index ?? steps.length, 0, step);
  return { plan: touch({ ...plan, steps }), step };
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
  const step: Step = { id: newId("step"), name: name ?? `${src.name} (copy)`, notes: src.notes };
  const steps = [...plan.steps];
  steps.splice(idx + 1, 0, step);

  const entities = plan.entities.map((e) => {
    const next = { ...e } as Entity;
    if (e.overrides?.[stepId]) next.overrides = { ...e.overrides, [step.id]: { ...e.overrides[stepId] } };
    return next;
  });

  return { plan: touch({ ...plan, steps, entities }), step };
}

export function updateStep(plan: Plan, stepId: string, patch: Partial<Omit<Step, "id">>): Plan {
  const steps = plan.steps.map((s) => (s.id === stepId ? { ...s, ...defined(patch) } : s));
  return touch({ ...plan, steps });
}

export function deleteStep(plan: Plan, stepId: string): Plan {
  if (plan.steps.length <= 1) throw new Error("A plan needs at least one step");
  const steps = plan.steps.filter((s) => s.id !== stepId);
  const entities = plan.entities
    .map((e) => {
      const overrides = { ...e.overrides };
      delete overrides[stepId];
      const steps2 = Array.isArray(e.steps) ? e.steps.filter((s) => s !== stepId) : e.steps;
      return { ...e, overrides, steps: steps2 } as Entity;
    })
    // An entity that only existed in the deleted step goes away with it.
    .filter((e) => e.steps === "all" || (e.steps as string[]).length > 0);
  return touch({ ...plan, steps, entities });
}

export function moveStep(plan: Plan, stepId: string, index: number): Plan {
  const from = plan.steps.findIndex((s) => s.id === stepId);
  if (from < 0) throw new Error(`No step ${stepId}`);
  const steps = [...plan.steps];
  const [s] = steps.splice(from, 1);
  steps.splice(Math.max(0, Math.min(steps.length, index)), 0, s);
  return touch({ ...plan, steps });
}

/* -------------------------------------------------------------- convenience */

export function setArena(plan: Plan, patch: Partial<Arena>): Plan {
  const arena = ArenaSchema.parse({
    ...plan.arena,
    ...defined(patch),
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
 * Place the 8 standard waymarks. Markers the plan already has are *moved* into
 * position rather than skipped, so this doubles as a "reset to standard" button.
 */
export function addWaymarks(plan: Plan, distance = 0.8, stepId?: string): Plan {
  let next = plan;
  STANDARD_WAYMARKS.forEach((marker, i) => {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(a) * (plan.arena.width / 2) * distance;
    const y = Math.sin(a) * (plan.arena.height / 2) * distance;
    const existing = findEntities(next, { type: "marker" }).find(
      (e) => (e as { marker: string }).marker === marker
    );
    next = existing
      ? updateEntity(next, existing.id, { x, y }, stepId).plan
      : addEntity(next, { type: "marker", marker, x, y }).plan;
  });
  return next;
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
  { slot: "R1", names: ["R1", "D3"] },
  { slot: "H1", names: ["H1"] },
  { slot: "M1", names: ["M1", "D1"] },
];

/**
 * Move the players already in the plan onto the PF clock. Anyone whose name
 * doesn't name a slot fills whatever slots are left, in order.
 */
export function arrangeParty(
  plan: Plan,
  radiusFraction = 0.25,
  stepId?: string
): { plan: Plan; ids: string[] } {
  const players = findEntities(plan, { type: "player" });
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
      stepId
    ).plan;
    ids.push(entity.id);
  }
  // Anyone past the eighth player keeps their position — better than stacking.
  return { plan: next, ids };
}

/* ------------------------------------------------------------- descriptions */

function describeEntity(plan: Plan, e: Entity): string {
  const label = e.name ? `"${e.name}"` : "";
  const at = `(${Math.round(e.x)}, ${Math.round(e.y)}) ${pointToCompass(e.x, e.y)}`;
  switch (e.type) {
    case "marker":
      return `waymark ${e.marker} at ${at}`;
    case "player":
      return `player ${jobLabel(e.job)} ${label} at ${at}${e.showFacing ? `, facing ${Math.round(e.rotation)}°` : ""}`;
    case "enemy":
      return `enemy ${label} r=${Math.round(e.size)} at ${at}, facing ${Math.round(e.rotation)}°`;
    case "zone": {
      const geo =
        e.shape === "cone"
          ? `${Math.round(e.angle)}° cone r=${Math.round(e.radius)} facing ${Math.round(e.rotation)}°`
          : e.shape === "donut"
            ? `donut ${Math.round(e.innerRadius)}–${Math.round(e.radius)}`
            : e.shape === "rect" || e.shape === "line" || e.shape === "knockback" || e.shape === "arrow"
              ? `${e.shape} ${Math.round(e.width)}x${Math.round(e.length)} facing ${Math.round(e.rotation)}°`
              : `${e.shape} r=${Math.round(e.radius)}`;
      return `zone ${geo} ${label} at ${at}`;
    }
    case "tether": {
      const a = getEntity(plan, e.from);
      const b = getEntity(plan, e.to);
      return `tether ${e.style} ${a?.name ?? e.from} → ${b?.name ?? e.to}`;
    }
    case "text":
      return `text "${e.text}" at ${at}`;
    case "path":
      return `path ${e.points.length / 2} points from ${at}`;
    case "icon":
      return `icon ${label} at ${at}`;
  }
}

/** Compact, model-readable rendering of a plan — what `read_plan` returns. */
export function describePlan(plan: Plan, stepId?: string): string {
  const lines: string[] = [];
  lines.push(`# ${plan.name}${plan.encounter ? ` — ${plan.encounter}` : ""} (${plan.id}, rev ${plan.rev})`);
  if (plan.description) lines.push(plan.description);
  lines.push(
    `Arena: ${plan.arena.shape} ${plan.arena.width}x${plan.arena.height}, grid ${plan.arena.grid.type}. ` +
      `Origin is the centre; +x east, +y south; rotation 0 = north, clockwise.`
  );
  const steps = stepId ? plan.steps.filter((s) => s.id === stepId) : plan.steps;
  for (const step of steps) {
    lines.push("");
    lines.push(`## Step ${plan.steps.indexOf(step) + 1}: ${step.name} [${step.id}]`);
    if (step.notes) lines.push(`Notes: ${step.notes}`);
    const items = entitiesForStep(plan, step.id);
    if (!items.length) lines.push("(empty)");
    for (const e of items) {
      const base = plan.entities.find((b) => b.id === e.id)!;
      const moved = base.overrides?.[step.id] ? " *" : "";
      lines.push(`- [${e.id}]${moved} ${describeEntity(plan, e)}`);
    }
  }
  if (!stepId && plan.steps.length > 1) lines.push("", "(* = entity has a pose override in that step)");
  return lines.join("\n");
}

export { entitiesForStep, resolveEntity };
