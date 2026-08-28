import type {
  Arena,
  EncounterSetup,
  Entity,
  EntityType,
  Mech,
  Mechanic,
  Plan,
  PropBag,
  Step,
  Variant,
} from "./schema";
import * as ops from "./ops";

/**
 * The single funnel every mutation goes through — canvas, REST API and MCP
 * tools all send `Op`s to PlanAgent.apply(). Keeping one dispatch table means a
 * model editing over MCP and a human dragging a token hit identical code.
 */
export type Op =
  | { op: "set_meta"; name?: string; description?: string; encounter?: string }
  | { op: "set_arena"; patch: ops.ArenaPatch }
  | { op: "add_entity"; spec: PropBag & { type: EntityType }; stepId?: string; variant?: string }
  | { op: "update_entity"; id: string; patch: PropBag; stepId?: string; variant?: string }
  | { op: "clear_override"; id: string; stepId: string; variant?: string }
  | { op: "delete_entities"; ids: string[]; stepId?: string; variant?: string }
  | { op: "duplicate_entity"; id: string; offset?: number; stepId?: string; variant?: string }
  | { op: "reorder_entity"; id: string; where: ops.ZOrder; stepId?: string; variant?: string }
  | { op: "add_step"; name?: string; notes?: string; index?: number; mechanic?: string }
  | { op: "duplicate_step"; stepId: string; name?: string }
  | { op: "update_step"; stepId: string; patch: Partial<Omit<Step, "id" | "variantScenes">> }
  | { op: "delete_step"; stepId: string }
  | { op: "move_step"; stepId: string; index: number }
  | { op: "add_mechanic"; name?: string; after?: string; stepIds?: string[] }
  | { op: "update_mechanic"; mechanicId: string; patch: { name?: string } }
  | { op: "delete_mechanic"; mechanicId: string; keepSteps?: boolean }
  | { op: "move_mechanic"; mechanicId: string; index: number }
  | { op: "add_variant"; mechanicId: string; name?: string; ownerId?: string; ownerName?: string }
  | { op: "gate_mech"; mechId: string; variant?: string }
  | { op: "update_variant"; mechanicId: string; variantId: string; patch: { name?: string } }
  | { op: "delete_variant"; mechanicId: string; variantId: string }
  | { op: "add_mech"; name?: string; snap?: string; boom?: string; color?: string }
  | { op: "update_mech"; mechId: string; patch: Partial<Omit<Mech, "id">> }
  | { op: "delete_mech"; mechId: string; keepEntities?: boolean }
  | { op: "assign_mech"; ids: string[]; mechId: string | null; stepId?: string; variant?: string }
  | { op: "add_waymarks"; distance?: number }
  | { op: "apply_encounter"; setup: EncounterSetup }
  | { op: "add_party"; party?: { job: string; name: string }[]; radiusFraction?: number }
  | { op: "arrange_party"; radiusFraction?: number; stepId?: string; variant?: string };

export interface OpResult {
  plan: Plan;
  /** Whatever the op created, for the caller to report back. */
  value?: Entity | Step | Mech | Mechanic | Variant | string[] | null;
}

/**
 * Validate the optional scene address before either authorization or mutation.
 * A claimed variant without its step used to fall through to a global edit,
 * while the authorization layer trusted the claimed variant.
 */
export function validateOpContext(plan: Plan, op: Op): void {
  let stepId: string | undefined;
  let variant: string | undefined;
  switch (op.op) {
    case "add_entity":
    case "update_entity":
    case "clear_override":
    case "delete_entities":
    case "duplicate_entity":
    case "reorder_entity":
    case "assign_mech":
    case "arrange_party":
      stepId = op.stepId;
      variant = op.variant;
      break;
    default:
      return;
  }
  if (variant && !stepId) throw new Error("A variant-scoped edit also needs its step");
  if (!stepId) return;
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`No step ${stepId}`);
  if (!variant) return;
  const mechanic = plan.mechanics.find((candidate) => candidate.id === step.mechanic);
  if (!mechanic?.variants.some((candidate) => candidate.id === variant))
    throw new Error(`Variant ${variant} does not belong to step ${stepId}`);
}

export function applyOp(plan: Plan, op: Op): OpResult {
  validateOpContext(plan, op);
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
      const r = ops.addEntity(plan, op.spec, op.stepId, op.variant);
      return { plan: r.plan, value: r.entity };
    }
    case "update_entity": {
      const r = ops.updateEntity(plan, op.id, op.patch, op.stepId, op.variant);
      return { plan: r.plan, value: r.entity };
    }
    case "clear_override":
      return { plan: ops.clearOverride(plan, op.id, op.stepId, op.variant) };
    case "delete_entities":
      return { plan: ops.deleteEntities(plan, op.ids, op.stepId, op.variant), value: op.ids };
    case "duplicate_entity": {
      const r = ops.duplicateEntity(plan, op.id, op.offset, op.stepId, op.variant);
      return { plan: r.plan, value: r.entity };
    }
    case "reorder_entity":
      return { plan: ops.reorderEntity(plan, op.id, op.where, op.stepId, op.variant) };
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
    case "add_mechanic": {
      const r = ops.addMechanic(plan, op);
      return { plan: r.plan, value: r.mechanic };
    }
    case "update_mechanic":
      return { plan: ops.updateMechanic(plan, op.mechanicId, op.patch) };
    case "delete_mechanic":
      return { plan: ops.deleteMechanic(plan, op.mechanicId, op.keepSteps), value: [op.mechanicId] };
    case "move_mechanic":
      return { plan: ops.moveMechanic(plan, op.mechanicId, op.index) };
    case "add_variant": {
      const r = ops.addVariant(plan, op.mechanicId, {
        name: op.name,
        ownerId: op.ownerId,
        ownerName: op.ownerName,
      });
      return { plan: r.plan, value: r.variant };
    }
    case "gate_mech":
      return { plan: ops.gateMech(plan, op.mechId, op.variant) };
    case "update_variant":
      return { plan: ops.updateVariant(plan, op.mechanicId, op.variantId, op.patch) };
    case "delete_variant":
      return { plan: ops.deleteVariant(plan, op.mechanicId, op.variantId), value: [op.variantId] };
    case "add_mech": {
      const r = ops.addMech(plan, op);
      return { plan: r.plan, value: r.mech };
    }
    case "update_mech":
      return { plan: ops.updateMech(plan, op.mechId, op.patch) };
    case "delete_mech":
      return { plan: ops.deleteMech(plan, op.mechId, op.keepEntities), value: [op.mechId] };
    case "assign_mech":
      return { plan: ops.assignMech(plan, op.ids, op.mechId, op.stepId, op.variant), value: op.ids };
    case "add_waymarks":
      return { plan: ops.addWaymarks(plan, op.distance) };
    case "apply_encounter":
      return { plan: ops.applyEncounterSetup(plan, op.setup) };
    case "add_party": {
      const r = ops.addParty(plan, op.party, op.radiusFraction);
      return { plan: r.plan, value: r.ids };
    }
    case "arrange_party": {
      const r = ops.arrangeParty(plan, op.radiusFraction, op.stepId, op.variant);
      return { plan: r.plan, value: r.ids };
    }
    default: {
      const never: never = op;
      throw new Error(`Unknown op ${JSON.stringify(never)}`);
    }
  }
}
