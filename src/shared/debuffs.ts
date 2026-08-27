import type { FFLogsDebuff, FFLogsDebuffDump } from "./fflogs";
import { formatFightTimestamp } from "./fflogs";
import { roleOf } from "./jobs";
import {
  type DebuffGroup,
  type DebuffRef,
  type DebuffMode,
  type Mech,
  type Plan,
  type PlayerEntity,
  entitiesForStep,
  mechSpan,
} from "./schema";

/**
 * The debuff picker, as rows: every status of the fight, grouped by the moment
 * it first lands. Casts apply their statuses together, so "what hit at 0:26"
 * is the natural unit to read — and to drag from.
 */
export type PickerRow = {
  /** First application, ms into the fight. */
  atMs: number;
  /** "00:26" — the row label. */
  at: string;
  debuffs: FFLogsDebuff[];
};

export function pickerRows(dump: FFLogsDebuffDump): PickerRow[] {
  const rows = new Map<number, FFLogsDebuff[]>();
  for (const d of dump.debuffs) {
    // Statuses of one cast land a server tick apart; fold them into one row.
    const key = Math.round(d.firstAppliedMs / 1000);
    rows.set(key, [...(rows.get(key) ?? []), d]);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([key, debuffs]) => ({
      atMs: key * 1000,
      at: formatFightTimestamp(debuffs[0].firstAppliedMs).slice(0, 5),
      debuffs,
    }));
}

/** What the plan keeps of a picked status: enough to draw it anywhere. */
export function debuffRef(d: FFLogsDebuff): DebuffRef {
  return { id: d.id, name: d.name, ...(d.icon ? { icon: d.icon.url } : {}) };
}

/**
 * Which pool a player belongs to. The same reading the editor's group drops
 * use: role off the job, else off the callout name (MT, H2), and a `supports`
 * pool claims tanks and healers both.
 */
export function debuffGroupOf(e: PlayerEntity): "tanks" | "healers" | "damagers" {
  const r = roleOf(e.job) === "any" ? roleOf(e.name ?? "") : roleOf(e.job);
  return r === "tank" ? "tanks" : r === "healer" ? "healers" : "damagers";
}

/** The players of one pool, this step, in plan order. */
export function debuffGroupMembers(
  plan: Plan,
  stepId: string | undefined,
  group: DebuffGroup,
  shown?: Record<string, string>,
): PlayerEntity[] {
  return entitiesForStep(plan, stepId, undefined, shown).filter((e): e is PlayerEntity => {
    if (e.type !== "player") return false;
    const g = debuffGroupOf(e);
    return group === "supports" ? g !== "damagers" : g === group;
  });
}

/**
 * The debuff mech on the floor in this step, if any. Two deals overlapping is
 * a plan being sketched, not a fight — the one that snapshots latest wins.
 */
export function activeDebuffMech(
  plan: Plan,
  stepId: string | undefined,
  shown?: Record<string, string>,
): Mech | null {
  if (!stepId) return null;
  const step = plan.steps.find((s) => s.id === stepId);
  const mechanic = step?.mechanic ? plan.mechanics.find((m) => m.id === step.mechanic) : undefined;
  const playing = mechanic?.variants.length
    ? (mechanic.variants.some((v) => v.id === shown?.[mechanic.id])
        ? shown![mechanic.id]
        : mechanic.variants[0].id)
    : undefined;
  const here = plan.mechs.filter(
    (m) =>
      m.debuffs &&
      mechSpan(plan, m).includes(stepId) &&
      (!m.variant || m.variant === playing),
  );
  if (!here.length) return null;
  const at = (m: Mech) => plan.steps.findIndex((s) => s.id === m.snap);
  return here.reduce((best, m) => (at(m) >= at(best) ? m : best));
}

/** What one player token wears while a debuff mech is active. */
export type DebuffDress = {
  mode: DebuffMode;
  /** The status this player carries, if their pool reached them. */
  debuff?: DebuffRef;
};

/**
 * The party dressed for the active debuff mech: token mode plus, per player,
 * the status their pool puts on them. Pools are role-scoped; spreading one
 * over its members in plan order is only how the drawing lands, not a claim
 * about who takes what.
 */
export function debuffDress(
  plan: Plan,
  stepId: string | undefined,
  shown?: Record<string, string>,
): Map<string, DebuffDress> | null {
  const mech = activeDebuffMech(plan, stepId, shown);
  if (!mech?.debuffs) return null;
  const dress = new Map<string, DebuffDress>();
  const { mode, pools } = mech.debuffs;
  const groups: DebuffGroup[] = pools.supports?.length
    ? ["supports", "damagers"]
    : ["tanks", "healers", "damagers"];
  for (const group of groups) {
    const members = debuffGroupMembers(plan, stepId, group, shown);
    const pool = pools[group] ?? [];
    members.forEach((e, i) => dress.set(e.id, { mode, debuff: pool[i] }));
  }
  return dress;
}

/** The token art a mode puts on a player, or undefined to keep their own. */
export function dressIconKey(e: PlayerEntity, mode: DebuffMode): string | undefined {
  if (mode === "normal") return undefined;
  if (mode === "generic") return "actor/any";
  const g = debuffGroupOf(e);
  if (mode === "sd") return g === "damagers" ? "actor/dps" : "actor/support";
  return g === "tanks" ? "actor/tank" : g === "healers" ? "actor/healer" : "actor/dps";
}
