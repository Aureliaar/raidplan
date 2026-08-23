import { Agent, getAgentByName, type Connection, type ConnectionContext } from "agents";
import type { AppEnv } from "./env";
import { registry } from "./registry";
import { authenticate } from "./auth";
import { type Op, applyOp } from "../shared/apply";
import { PlanSchema, hydratePlan, type Plan, type PlanRole, type PropBag } from "../shared/schema";
import { createPlan, describePlan } from "../shared/ops";

const EMPTY: Plan = PlanSchema.parse({ id: "", name: "", steps: [], entities: [] });

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

  /** Apply one or more ops atomically; returns the new plan and each op's value. */
  async apply(op: Op | Op[]): Promise<{ plan: Plan; values: (PropBag | null)[] }> {
    if (!this.state?.id) throw new Error("Plan not initialised");
    const list = Array.isArray(op) ? op : [op];
    let plan = this.plan;
    const values: (PropBag | null)[] = [];
    for (const one of list) {
      const res = applyOp(plan, one);
      plan = res.plan;
      values.push((res.value ?? null) as PropBag | null);
    }
    this.setState(plan);
    return { plan, values };
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
  exists(): Promise<boolean>;
  apply(op: Op | Op[]): Promise<{ plan: Plan; values: (PropBag | null)[] }>;
  describe(stepId?: string): Promise<string>;
  destroy(): Promise<void>;
}

/** Stub for a plan's DO, with the instance name set so `this.name` is the plan id. */
export async function planStub(env: AppEnv, planId: string): Promise<PlanStub> {
  const stub = await getAgentByName<AppEnv, PlanAgent>(env.PlanAgent, planId);
  return stub as unknown as PlanStub;
}
