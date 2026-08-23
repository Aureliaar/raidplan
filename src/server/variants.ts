/**
 * Who edits what, inside one plan.
 *
 * A master plan holds everybody's reading of the same fight: one mechanic, a
 * variant per person. What a variant owns is where people stand in it and which
 * casts happen in it — so those are the edits that belong to whoever owns the
 * variant, and nobody else. Everything else about the plan (its steps, its
 * sections, the shapes that happen whichever way it goes) stays as it was:
 * anyone who can edit the plan can edit those.
 *
 * The plan's owner is not bound by any of this. It is their plan.
 *
 * Enforced on the server because the browser is not the only way in: the same
 * check runs for the REST ops endpoint and for the MCP tools.
 */
import type { Op } from "../shared/apply";
import type { Mech, Plan, PlanRole } from "../shared/schema";

export interface Caller {
  id: string;
  name?: string;
}

/** A variant's owner, or undefined for one that belongs to the plan itself. */
function ownerOf(plan: Plan, variantId: string | undefined): string | undefined {
  if (!variantId) return undefined;
  for (const mechanic of plan.mechanics)
    for (const variant of mechanic.variants)
      if (variant.id === variantId) return variant.ownerId;
  return undefined;
}

/** What a variant is called, for saying no in words that mean something. */
function labelOf(plan: Plan, variantId: string): string {
  for (const mechanic of plan.mechanics) {
    const i = mechanic.variants.findIndex((v) => v.id === variantId);
    if (i >= 0)
      return `${mechanic.variants[i].name || String.fromCharCode(65 + i)}${
        mechanic.name ? ` of ${mechanic.name}` : ""
      }`;
  }
  return variantId;
}

const mechOf = (plan: Plan, id: string | null | undefined): Mech | undefined =>
  id ? plan.mechs.find((m) => m.id === id) : undefined;

/**
 * Every variant one op reaches into. A cast gated to a reading is that
 * reading's, so touching the cast is touching the reading — including taking it
 * out again, which is why a gate change counts on both sides.
 */
function variantsTouched(plan: Plan, op: Op): (string | undefined)[] {
  switch (op.op) {
    case "update_entity":
    case "clear_override":
      return [op.variant];
    case "update_variant":
    case "delete_variant":
      return [op.variantId];
    case "gate_mech":
      return [op.variant, mechOf(plan, op.mechId)?.variant];
    case "update_mech":
    case "delete_mech":
      return [mechOf(plan, op.mechId)?.variant];
    case "assign_mech":
      return [
        mechOf(plan, op.mechId)?.variant,
        // Taken out of whichever cast they were in, too.
        ...op.ids.map((id) => mechOf(plan, plan.entities.find((e) => e.id === id)?.mech)?.variant),
      ];
    case "add_entity":
      return [mechOf(plan, (op.spec as { mech?: string }).mech)?.variant];
    case "delete_entities":
      return op.ids.map((id) => mechOf(plan, plan.entities.find((e) => e.id === id)?.mech)?.variant);
    case "delete_mechanic":
      return plan.mechanics.find((m) => m.id === op.mechanicId)?.variants.map((v) => v.id) ?? [];
    default:
      return [];
  }
}

/**
 * Refuse the ops that reach into somebody else's reading. Returns the ops to
 * apply, with the server's own word for who is claiming a new variant — the
 * client does not get to say whose it is.
 */
export function guardVariants(
  plan: Plan,
  ops: Op | Op[],
  caller: Caller | null,
  role: PlanRole,
  deny: (message: string) => Error
): Op[] {
  const list = Array.isArray(ops) ? ops : [ops];
  const stamped = list.map((op) =>
    op.op === "add_variant"
      ? { ...op, ownerId: caller?.id, ownerName: caller?.name }
      : op
  );
  if (role === "owner") return stamped;
  for (const op of stamped)
    for (const id of variantsTouched(plan, op)) {
      const owner = ownerOf(plan, id);
      if (owner && owner !== caller?.id)
        throw deny(`“${labelOf(plan, id!)}” is someone else's reading — ask them, or add your own`);
    }
  return stamped;
}
