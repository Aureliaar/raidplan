import type { Arena, Entity, EntityType, Plan, PropBag, Step } from "./schema";
import * as ops from "./ops";

/**
 * The single funnel every mutation goes through — canvas, REST API and MCP
 * tools all send `Op`s to PlanAgent.apply(). Keeping one dispatch table means a
 * model editing over MCP and a human dragging a token hit identical code.
 */
export type Op =
  | { op: "set_meta"; name?: string; description?: string; encounter?: string }
  | { op: "set_arena"; patch: Partial<Arena> }
  | { op: "add_entity"; spec: PropBag & { type: EntityType } }
  | { op: "update_entity"; id: string; patch: PropBag; stepId?: string }
  | { op: "clear_override"; id: string; stepId: string }
  | { op: "delete_entities"; ids: string[] }
  | { op: "duplicate_entity"; id: string; offset?: number }
  | { op: "reorder_entity"; id: string; where: ops.ZOrder }
  | { op: "add_step"; name?: string; notes?: string; index?: number }
  | { op: "duplicate_step"; stepId: string; name?: string }
  | { op: "update_step"; stepId: string; patch: Partial<Omit<Step, "id">> }
  | { op: "delete_step"; stepId: string }
  | { op: "move_step"; stepId: string; index: number }
  | { op: "add_waymarks"; distance?: number }
  | { op: "add_party"; party?: { job: string; name: string }[]; radiusFraction?: number }
  | { op: "replace_plan"; plan: Plan };

export interface OpResult {
  plan: Plan;
  /** Whatever the op created, for the caller to report back. */
  value?: Entity | Step | string[] | null;
}

export function applyOp(plan: Plan, op: Op): OpResult {
  switch (op.op) {
    case "set_meta":
      return {
        plan: ops.touch({
          ...plan,
          name: op.name ?? plan.name,
          description: op.description ?? plan.description,
          encounter: op.encounter ?? plan.encounter,
        }),
      };
    case "set_arena":
      return { plan: ops.setArena(plan, op.patch) };
    case "add_entity": {
      const r = ops.addEntity(plan, op.spec);
      return { plan: r.plan, value: r.entity };
    }
    case "update_entity": {
      const r = ops.updateEntity(plan, op.id, op.patch, op.stepId);
      return { plan: r.plan, value: r.entity };
    }
    case "clear_override":
      return { plan: ops.clearOverride(plan, op.id, op.stepId) };
    case "delete_entities":
      return { plan: ops.deleteEntities(plan, op.ids), value: op.ids };
    case "duplicate_entity": {
      const r = ops.duplicateEntity(plan, op.id, op.offset);
      return { plan: r.plan, value: r.entity };
    }
    case "reorder_entity":
      return { plan: ops.reorderEntity(plan, op.id, op.where) };
    case "add_step": {
      const r = ops.addStep(plan, op);
      return { plan: r.plan, value: r.step };
    }
    case "duplicate_step": {
      const r = ops.duplicateStep(plan, op.stepId, op.name);
      return { plan: r.plan, value: r.step };
    }
    case "update_step":
      return { plan: ops.updateStep(plan, op.stepId, op.patch) };
    case "delete_step":
      return { plan: ops.deleteStep(plan, op.stepId) };
    case "move_step":
      return { plan: ops.moveStep(plan, op.stepId, op.index) };
    case "add_waymarks":
      return { plan: ops.addWaymarks(plan, op.distance) };
    case "add_party": {
      const r = ops.addParty(plan, op.party, op.radiusFraction);
      return { plan: r.plan, value: r.ids };
    }
    case "replace_plan":
      return { plan: ops.touch({ ...op.plan, id: plan.id, ownerId: plan.ownerId, rev: plan.rev }) };
    default: {
      const never: never = op;
      throw new Error(`Unknown op ${JSON.stringify(never)}`);
    }
  }
}
