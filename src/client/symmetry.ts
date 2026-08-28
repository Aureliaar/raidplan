import type { Entity, Plan, PropBag } from "../shared/schema";
import type { Op } from "../shared/apply";
import { roleOf } from "../shared/jobs";

export type SymmetryKind = "mirror" | "rotate";
export type SymmetryCount = 1 | 2 | 4;

type Symmetry = NonNullable<Entity["symmetry"]>;
type MatchedMember = { member: Entity; symmetry: Symmetry };
type LooseSymmetryRole =
  | "tank"
  | "healer"
  | "melee"
  | "ranged"
  | "dps"
  | "support"
  | "damager"
  | "any";

const round = (n: number) => Math.round(n * 1000) / 1000;
const angle = (n: number) => ((round(n) % 360) + 360) % 360;

/**
 * Party symmetry follows encounter slots, rather than the game's more granular
 * job-role taxonomy. R1/R2 are one two-way pair even when one is physical
 * ranged and the other is a caster; four-way symmetry spans either half of the
 * party (all supports or all damage dealers).
 */
function looseSymmetryRole(entity: Extract<Entity, { type: "player" }>, count: 2 | 4): LooseSymmetryRole {
  const role = roleOf(entity.job) === "any" ? roleOf(entity.name ?? "") : roleOf(entity.job);
  if (count === 4) {
    if (role === "tank" || role === "healer") return "support";
    if (role === "melee" || role === "ranged" || role === "caster" || role === "dps")
      return "damager";
  }
  if (role === "caster") return "ranged";
  return role;
}

/** Apply one face of a symmetry set to a point authored in face zero. */
export function symmetryPoint(
  x: number,
  y: number,
  kind: SymmetryKind,
  count: 2 | 4,
  index: number
): { x: number; y: number } {
  if (kind === "rotate") {
    const turns = count === 2 ? index * 2 : index;
    return [
      { x, y },
      { x: -y, y: x },
      { x: -x, y: -y },
      { x: y, y: -x },
    ][turns % 4];
  }
  // Two-way mirror reflects across the north/south centre line. Four-way
  // mirror reflects into every quadrant.
  return count === 2
    ? index % 2 === 0
      ? { x, y }
      : { x: -x, y }
    : [
        { x, y },
        { x: -x, y },
        { x: -x, y: -y },
        { x, y: -y },
      ][index % 4];
}

/** Apply the same transform to clockwise degrees (zero is north). */
export function symmetryRotation(
  rotation: number,
  kind: SymmetryKind,
  count: 2 | 4,
  index: number
): number {
  if (kind === "rotate") return angle(rotation + index * (360 / count));
  if (count === 2) return index % 2 ? angle(-rotation) : angle(rotation);
  return [angle(rotation), angle(-rotation), angle(rotation + 180), angle(180 - rotation)][index % 4];
}

/** Undo a face transform so editing any copy recovers the face-zero pose. */
function canonicalPose(
  x: number,
  y: number,
  rotation: number,
  symmetry: Symmetry
): { x: number; y: number; rotation: number } {
  const { kind, count, index } = symmetry;
  if (kind === "rotate") {
    const inverse = (count - index) % count;
    const p = symmetryPoint(x, y, kind, count, inverse);
    return { ...p, rotation: angle(rotation - index * (360 / count)) };
  }
  // Reflections are their own inverse.
  const p = symmetryPoint(x, y, kind, count, index);
  return { ...p, rotation: symmetryRotation(rotation, kind, count, index) };
}

export function makeSymmetricAdds(
  spec: PropBag & { type: Entity["type"] },
  kind: SymmetryKind,
  count: 2 | 4,
  group = `sym_${Math.random().toString(36).slice(2, 10)}`
): Extract<Op, { op: "add_entity" }>[] {
  return Array.from({ length: count }, (_, index) => ({
    op: "add_entity" as const,
    spec: {
      ...spec,
      x: symmetryPoint(spec.x, spec.y, kind, count, index).x,
      y: symmetryPoint(spec.x, spec.y, kind, count, index).y,
      rotation: symmetryRotation(typeof spec.rotation === "number" ? spec.rotation : 0, kind, count, index),
      symmetry: { id: group, kind, count, index },
    },
  }));
}

/**
 * Mirror an entity update through its saved set. Pose properties transform;
 * ordinary inspector properties (colour, size, opacity, etc.) copy verbatim.
 */
export function symmetricUpdates(
  plan: Plan,
  op: Extract<Op, { op: "update_entity" }>,
  kind: SymmetryKind,
  count: 2 | 4,
  visible: Entity[] = plan.entities
): Extract<Op, { op: "update_entity" }>[] {
  const source = visible.find((e) => e.id === op.id);
  if (!source) return [op];
  const matched = matchSymmetryMembers(plan, source, kind, count, visible);
  if (!matched) return [op];
  const { members, sourceSymmetry } = matched;
  const current = { x: source.x, y: source.y, rotation: source.rotation, ...op.patch };
  const base = canonicalPose(current.x, current.y, current.rotation, sourceSymmetry);
  return members.map(({ member, symmetry }) => {
    const p = symmetryPoint(base.x, base.y, sourceSymmetry.kind, sourceSymmetry.count, symmetry.index);
    const patch: PropBag = { ...op.patch };
    if ("x" in op.patch || "y" in op.patch) Object.assign(patch, p);
    if ("rotation" in op.patch)
      patch.rotation = symmetryRotation(
        base.rotation,
        sourceSymmetry.kind,
        sourceSymmetry.count,
        symmetry.index
      );
    return { ...op, id: member.id, patch };
  });
}

/** All faces that should read as selected with this entity in the active mode. */
export function symmetryMemberIds(
  plan: Plan,
  sourceId: string,
  kind: SymmetryKind,
  count: 2 | 4,
  visible: Entity[] = plan.entities
): string[] {
  const source = visible.find((e) => e.id === sourceId);
  if (!source) return [sourceId];
  return matchSymmetryMembers(plan, source, kind, count, visible)?.members.map(({ member }) => member.id) ?? [sourceId];
}

/** Resolve both saved symmetry sets and older, loosely symmetric party layouts. */
function matchSymmetryMembers(
  plan: Plan,
  source: Entity,
  kind: SymmetryKind,
  count: 2 | 4,
  visible: Entity[]
): { members: MatchedMember[]; sourceSymmetry: Symmetry } | null {
  if (source.symmetry) {
    return {
      sourceSymmetry: source.symmetry,
      members: visible
        .filter((e) => e.symmetry?.id === source.symmetry!.id)
        .map((member) => ({ member, symmetry: member.symmetry! })),
    };
  }
  // Existing party layouts predate symmetry groups. Pair the selected player
  // with the nearest same-role player around every expected transformed pose.
  if (source.type !== "player") return null;
  const posed =
    visible.find(
      (e): e is Extract<Entity, { type: "player" }> => e.id === source.id && e.type === "player"
    ) ?? source;
  const role = looseSymmetryRole(posed, count);
  const tolerance = Math.max(posed.size * 2.5, Math.max(plan.arena.width, plan.arena.height) * 0.12);
  const sourceSymmetry: Symmetry = { id: "loose", kind, count, index: 0 };
  const used = new Set([source.id]);
  const members: MatchedMember[] = [{ member: source, symmetry: sourceSymmetry }];
  for (let index = 1; index < count; index++) {
    const expected = symmetryPoint(posed.x, posed.y, kind, count, index);
    const nearest = visible
      .filter((e): e is Extract<Entity, { type: "player" }> => {
        if (e.type !== "player" || used.has(e.id)) return false;
        const candidateRole = looseSymmetryRole(e, count);
        return candidateRole === role;
      })
      .map((e) => ({ e, distance: Math.hypot(e.x - expected.x, e.y - expected.y) }))
      .filter((hit) => hit.distance <= tolerance)
      .sort((a, b) => a.distance - b.distance)[0]?.e;
    if (nearest) {
      used.add(nearest.id);
      members.push({ member: nearest, symmetry: { ...sourceSymmetry, index } });
    }
  }
  return { members, sourceSymmetry };
}

export function symmetryIds(plan: { entities: Entity[] }, ids: string[]): string[] {
  const groups = new Set(
    plan.entities.filter((e) => ids.includes(e.id) && e.symmetry).map((e) => e.symmetry!.id)
  );
  return [...new Set([...ids, ...plan.entities.filter((e) => groups.has(e.symmetry?.id ?? "")).map((e) => e.id)])];
}
