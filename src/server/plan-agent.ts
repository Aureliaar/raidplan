import { Agent, getAgentByName, type Connection, type ConnectionContext } from "agents";
import type { AppEnv } from "./env";
import { registry } from "./registry";
import { authenticate } from "./auth";
import { type Op, applyOp } from "../shared/apply";
import { PlanSchema, hydratePlan, type Plan, type PlanRole, type PropBag } from "../shared/schema";
import { createPlan, describePlan } from "../shared/ops";
import type { HistoryActor, HistoryResult, PlanHistory, PlanRevision } from "../shared/history";

const EMPTY: Plan = PlanSchema.parse({ id: "", name: "", steps: [], entities: [] });
const HISTORY_INDEX = "plan-history:index:v1";
const HISTORY_LIMIT = 100;
const SESSION_GAP = 30 * 60 * 1000;

interface StoredRevision extends PlanRevision {
  plan: Plan;
}

interface HistoryIndex {
  revisions: PlanRevision[];
  head: string | null;
  undo: string[];
  redo: string[];
  sessions?: Record<string, { id: string; startedAt: number; lastAt: number }>;
}

const revisionKey = (id: string) => `plan-history:revision:${id}`;

function summarize(op: Op | Op[]): string {
  const list = Array.isArray(op) ? op : [op];
  if (list.length > 1) return `${list.length} changes`;
  const one = list[0];
  switch (one.op) {
    case "set_meta": return "Updated plan details";
    case "set_arena": return "Updated arena";
    case "add_entity": return `Added ${one.spec.type}`;
    case "update_entity": return "Moved or updated an object";
    case "clear_override": return "Cleared a step position";
    case "delete_entities": return `Deleted ${one.ids.length} object${one.ids.length === 1 ? "" : "s"}`;
    case "duplicate_entity": return "Duplicated an object";
    case "reorder_entity": return "Changed object order";
    case "add_step": return "Added a step";
    case "duplicate_step": return "Duplicated a step";
    case "update_step": return "Updated a step";
    case "delete_step": return "Deleted a step";
    case "move_step": return "Reordered a step";
    case "add_mechanic": return "Added a mechanic";
    case "update_mechanic": return "Renamed a mechanic";
    case "delete_mechanic": return "Deleted a mechanic";
    case "move_mechanic": return "Reordered a mechanic";
    case "add_variant": return "Added a reading";
    case "gate_mech": return "Changed a cast reading";
    case "update_variant": return "Updated a reading";
    case "delete_variant": return "Deleted a reading";
    case "enable_beat_variants": return "Enabled Beat Variants";
    case "add_beat_variant": return "Added a Beat Variant";
    case "update_beat_variant": return "Updated a Beat Variant";
    case "duplicate_beat_variant": return "Duplicated a Beat Variant";
    case "delete_beat_variant": return "Deleted a Beat Variant";
    case "resume_beat_variant_content": return "Resumed shared Beat content";
    case "update_beat_variant_content": return "Updated Beat Variant content";
    case "clear_beat_variant_movement": return "Cleared Beat Variant movement";
    case "reset_beat_variant_step": return "Reset a Beat Variant Step";
    case "add_beat_variant_route": return "Added a Variant Route";
    case "update_beat_variant_route": return "Updated a Variant Route";
    case "delete_beat_variant_route": return "Deleted a Variant Route";
    case "set_default_beat_variant_route": return "Changed the default Variant Route";
    case "add_mech": return "Added a cast";
    case "update_mech": return "Updated a cast";
    case "delete_mech": return "Deleted a cast";
    case "assign_mech": return "Assigned objects to a cast";
    case "add_waymarks": return "Added waymarks";
    case "apply_encounter": return "Applied encounter setup";
    case "add_party": return "Added party";
    case "arrange_party": return "Arranged party";
  }
}

/**
 * One Durable Object per plan. Its `state` *is* the plan JSON, which the Agents
 * SDK persists and pushes to every connected browser over WebSocket — so an
 * edit made by a model through MCP shows up on the canvas immediately.
 *
 * Writes only ever happen server-side through `apply()`; client sockets are
 * read-only by construction (see `validateStateChange`).
 */
export class PlanAgent extends Agent<AppEnv, Plan> {
  initialState = EMPTY;

  /** Create the document if this is a fresh instance. Idempotent. */
  async init(input: { id: string; name?: string; encounter?: string; ownerId: string; withParty?: boolean }) {
    if (this.state?.id) return this.state;
    const plan = createPlan({ ...input, withParty: input.withParty ?? true });
    this.setState(plan);
    await this.ensureHistory(plan);
    return plan;
  }

  async getPlan(): Promise<Plan> {
    return this.plan;
  }

  /**
   * The stored document brought up to what this build expects. A plan written
   * before a field existed is still out there in storage, and everything that
   * reads one would sooner throw than default it.
   */
  private get plan(): Plan {
    return this.state?.id ? hydratePlan(this.state) : this.state;
  }

  async exists(): Promise<boolean> {
    return !!this.state?.id;
  }

  /**
   * Take a whole document in, keeping this plan's own identity and owner: the
   * same fight, on another instance. A plan copied up to a deployed worker is
   * still that worker's plan — only what is drawn on it comes across.
   */
  async replace(doc: unknown, keep: { id: string; ownerId: string }, actor?: HistoryActor): Promise<Plan> {
    const index = await this.ensureHistory(this.plan);
    const plan = hydratePlan({ ...PlanSchema.parse(doc), ...keep, rev: (this.state?.rev ?? 0) + 1 });
    this.setState(plan);
    await this.recordRevision(index, plan, "Imported plan contents", actor);
    return plan;
  }

  /** Apply one or more ops atomically; returns the new plan and each op's value. */
  async apply(
    op: Op | Op[],
    actor?: HistoryActor,
    expectedRev?: number
  ): Promise<{ plan: Plan; values: (PropBag | null)[]; conflict?: boolean }> {
    if (!this.state?.id) throw new Error("Plan not initialised");
    const index = await this.ensureHistory(this.plan);
    // Validation and ownership happen against expectedRev. Re-check it here,
    // immediately before the synchronous mutation, so another request cannot
    // change what the addressed entity/variant means in between.
    if (expectedRev !== undefined && this.plan.rev !== expectedRev)
      return { plan: this.plan, values: [], conflict: true };
    const list = Array.isArray(op) ? op : [op];
    let plan = this.plan;
    const values: (PropBag | null)[] = [];
    for (const one of list) {
      const res = applyOp(plan, one);
      plan = res.plan;
      values.push((res.value ?? null) as PropBag | null);
    }
    // The op boundary is strict, and this is the final invariant before a
    // document becomes durable state. No malformed internal result is stored.
    plan = hydratePlan(PlanSchema.parse(plan));
    this.setState(plan);
    await this.recordRevision(index, plan, summarize(op), actor);
    return { plan, values };
  }

  /** Persistent history metadata, newest first. Snapshots stay server-side. */
  async history(): Promise<PlanHistory> {
    const index = await this.ensureHistory(this.plan);
    return this.publicHistory(index);
  }

  async undo(): Promise<HistoryResult> {
    const index = await this.ensureHistory(this.plan);
    const target = index.undo.pop();
    if (!target) return { plan: this.plan, history: this.publicHistory(index) };
    const revision = await this.ctx.storage.get<StoredRevision>(revisionKey(target));
    if (!revision) return { plan: this.plan, history: this.publicHistory(index) };
    if (index.head) index.redo.push(index.head);
    index.head = target;
    const plan = this.restored(revision.plan);
    this.setState(plan);
    await this.ctx.storage.put(HISTORY_INDEX, index);
    return { plan, history: this.publicHistory(index) };
  }

  async redo(): Promise<HistoryResult> {
    const index = await this.ensureHistory(this.plan);
    const target = index.redo.pop();
    if (!target) return { plan: this.plan, history: this.publicHistory(index) };
    const revision = await this.ctx.storage.get<StoredRevision>(revisionKey(target));
    if (!revision) return { plan: this.plan, history: this.publicHistory(index) };
    if (index.head) index.undo.push(index.head);
    index.head = target;
    const plan = this.restored(revision.plan);
    this.setState(plan);
    await this.ctx.storage.put(HISTORY_INDEX, index);
    return { plan, history: this.publicHistory(index) };
  }

  /** Restore old content as a fresh revision, preserving the audit trail. */
  async revert(revisionId: string, actor?: HistoryActor): Promise<HistoryResult> {
    const index = await this.ensureHistory(this.plan);
    const target = await this.ctx.storage.get<StoredRevision>(revisionKey(revisionId));
    if (!target) throw new Error("That revision is no longer available");
    const plan = this.restored(target.plan);
    this.setState(plan);
    await this.recordRevision(index, plan, `Restored revision ${target.rev}`, actor);
    return { plan, history: this.publicHistory(index) };
  }

  private restored(snapshot: Plan): Plan {
    return hydratePlan(PlanSchema.parse({
      ...structuredClone(snapshot),
      id: this.plan.id,
      ownerId: this.plan.ownerId,
      rev: this.plan.rev + 1,
    }));
  }

  private publicHistory(index: HistoryIndex): PlanHistory {
    return {
      revisions: [...index.revisions].reverse(),
      currentId: index.head,
      undoId: index.undo.at(-1) ?? null,
      redoId: index.redo.at(-1) ?? null,
      canUndo: index.undo.length > 0,
      canRedo: index.redo.length > 0,
    };
  }

  /** Seed history lazily for plans created before revision storage existed. */
  private async ensureHistory(plan: Plan): Promise<HistoryIndex> {
    const found = await this.ctx.storage.get<HistoryIndex>(HISTORY_INDEX);
    if (found) return found;
    const now = Date.now();
    const id = crypto.randomUUID();
    const entry: PlanRevision = {
      id,
      rev: plan.rev,
      createdAt: now,
      sessionId: `system-${id}`,
      sessionStartedAt: now,
      actorName: "RaidPlan",
      source: "system",
      summary: "History started",
    };
    const index: HistoryIndex = { revisions: [entry], head: id, undo: [], redo: [], sessions: {} };
    await this.ctx.storage.put(revisionKey(id), { ...entry, plan } satisfies StoredRevision);
    await this.ctx.storage.put(HISTORY_INDEX, index);
    return index;
  }

  private async recordRevision(
    index: HistoryIndex,
    plan: Plan,
    summary: string,
    actor: HistoryActor = {}
  ): Promise<void> {
    const now = Date.now();
    const source = actor.source ?? "system";
    index.sessions ??= {};
    for (const [key, session] of Object.entries(index.sessions))
      if (now - session.lastAt > SESSION_GAP) delete index.sessions[key];
    const sessionKey = `${source}:${actor.actorId ?? actor.actorName ?? "anonymous"}:${actor.sessionId ?? "automatic"}`;
    const active = index.sessions[sessionKey];
    const sessionId = active && now - active.lastAt <= SESSION_GAP
      ? active.id
      : `${source}-${crypto.randomUUID()}`;
    const sessionStartedAt = active?.id === sessionId ? active.startedAt : now;
    index.sessions[sessionKey] = { id: sessionId, startedAt: sessionStartedAt, lastAt: now };
    const id = crypto.randomUUID();
    const entry: PlanRevision = {
      id,
      rev: plan.rev,
      createdAt: now,
      sessionId,
      sessionStartedAt,
      actorId: actor.actorId,
      actorName: actor.actorName || (source === "mcp" || source === "chat" ? "Assistant" : "RaidPlan"),
      source,
      summary,
    };
    if (index.head) index.undo.push(index.head);
    index.redo = [];
    index.head = id;
    index.revisions.push(entry);
    await this.ctx.storage.put(revisionKey(id), { ...entry, plan } satisfies StoredRevision);

    if (index.revisions.length > HISTORY_LIMIT) {
      const removed = index.revisions.splice(0, index.revisions.length - HISTORY_LIMIT);
      const gone = new Set(removed.map((item) => item.id));
      index.undo = index.undo.filter((item) => !gone.has(item));
      index.redo = index.redo.filter((item) => !gone.has(item));
      await Promise.all(removed.map((item) => this.ctx.storage.delete(revisionKey(item.id))));
    }
    await this.ctx.storage.put(HISTORY_INDEX, index);
  }

  /** Model-readable rendering, used by the MCP `read_plan` tool. */
  async describe(stepId?: string): Promise<string> {
    return describePlan(this.plan, stepId);
  }

  async destroy() {
    this.setState(EMPTY);
    await this.ctx.storage.deleteAll();
  }

  /* --------------------------------------------------------------- sockets */

  async onConnect(connection: Connection, ctx: ConnectionContext) {
    const auth = await authenticate(ctx.request, this.env);
    const planId = this.name;
    const role: PlanRole | null = await registry(this.env).roleFor(auth.user?.id ?? null, planId);
    if (!role) {
      connection.close(1008, "not authorised for this plan");
      return;
    }
    connection.setState({ role, userId: auth.user?.id ?? null });
  }

  /** Browsers may observe, never write. Every mutation goes through `apply`. */
  validateStateChange(_next: Plan, source: Connection | "server") {
    if (source !== "server") throw new Error("Plans are read-only over the socket; POST /api/plans/:id/ops");
  }
}

/**
 * The subset of PlanAgent reachable over Durable Object RPC. Declared by hand:
 * inferring it from the class makes TypeScript walk the whole `Op` union for
 * serializability, which it bails out of.
 */
export interface PlanStub {
  init(input: {
    id: string;
    name?: string;
    encounter?: string;
    ownerId: string;
    withParty?: boolean;
  }): Promise<Plan>;
  getPlan(): Promise<Plan>;
  replace(doc: unknown, keep: { id: string; ownerId: string }, actor?: HistoryActor): Promise<Plan>;
  exists(): Promise<boolean>;
  apply(
    op: Op | Op[],
    actor?: HistoryActor,
    expectedRev?: number
  ): Promise<{ plan: Plan; values: (PropBag | null)[]; conflict?: boolean }>;
  history(): Promise<PlanHistory>;
  undo(): Promise<HistoryResult>;
  redo(): Promise<HistoryResult>;
  revert(revisionId: string, actor?: HistoryActor): Promise<HistoryResult>;
  describe(stepId?: string): Promise<string>;
  destroy(): Promise<void>;
}

/** Stub for a plan's DO, with the instance name set so `this.name` is the plan id. */
export async function planStub(env: AppEnv, planId: string): Promise<PlanStub> {
  const stub = await getAgentByName<AppEnv, PlanAgent>(env.PlanAgent, planId);
  return stub as unknown as PlanStub;
}
