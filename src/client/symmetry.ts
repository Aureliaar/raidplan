import type { Entity, Plan, PropBag } from "../shared/schema";
import type { Op } from "../shared/apply";
import { roleOf } from "../shared/jobs";

export type SymmetryKind = "mirror" | "rotate";
export type SymmetryCount = 1 | 2 | 4;

type Symmetry = NonNullable<Entity["symmetry"]>;

const round = (n: number) => Math.round(n * 1000) / 1000;
const angle = (n: number) => ((round(n) % 360) + 360) % 360;

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
): Op[] {
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
): Op[] {
  const source = plan.entities.find((e) => e.id === op.id);
  if (!source) return [op];
  let members: Entity[];
  let sourceSymmetry: Symmetry;
  if (source.symmetry) {
    sourceSymmetry = source.symmetry;
    members = plan.entities.filter((e) => e.symmetry?.id === source.symmetry!.id);
  } else {
    // Existing party layouts predate symmetry groups. While moving a player,
    // pair it with the nearest player of the same role around each expected
    // transformed position. The generous radius tolerates hand-drawn layouts
    // without accidentally pairing a tank with a healer or DPS.
    if (source.type !== "player" || !("x" in op.patch || "y" in op.patch)) return [op];
    const posed =
      visible.find(
        (e): e is Extract<Entity, { type: "player" }> => e.id === source.id && e.type === "player"
      ) ?? source;
    const role = roleOf(posed.job) === "any" ? roleOf(posed.name ?? "") : roleOf(posed.job);
    const tolerance = Math.max(posed.size * 2.5, Math.max(plan.arena.width, plan.arena.height) * 0.12);
    const used = new Set([source.id]);
    const matches: { member: Entity; index: number }[] = [{ member: source, index: 0 }];
    for (let index = 1; index < count; index++) {
      const expected = symmetryPoint(posed.x, posed.y, kind, count, index);
      const nearest = visible
        .filter((e): e is Extract<Entity, { type: "player" }> => {
          if (e.type !== "player" || used.has(e.id)) return false;
          const candidateRole = roleOf(e.job) === "any" ? roleOf(e.name ?? "") : roleOf(e.job);
          return candidateRole === role;
        })
        .map((e) => ({ e, distance: Math.hypot(e.x - expected.x, e.y - expected.y) }))
        .filter((hit) => hit.distance <= tolerance)
        .sort((a, b) => a.distance - b.distance)[0]?.e;
      if (nearest) {
        used.add(nearest.id);
        matches.push({ member: nearest, index });
      }
    }
    sourceSymmetry = { id: "loose", kind, count, index: 0 };
    members = matches.map(({ member, index }) => ({
      ...member,
      symmetry: { ...sourceSymmetry, index },
    })) as Entity[];
  }
  const current = { x: source.x, y: source.y, rotation: source.rotation, ...op.patch };
  const base = canonicalPose(current.x, current.y, current.rotation, sourceSymmetry);
  return members.map((member) => {
    const p = symmetryPoint(base.x, base.y, sourceSymmetry.kind, sourceSymmetry.count, member.symmetry!.index);
    const patch: PropBag = { ...op.patch };
    if ("x" in op.patch || "y" in op.patch) Object.assign(patch, p);
    if ("rotation" in op.patch)
      patch.rotation = symmetryRotation(
        base.rotation,
        sourceSymmetry.kind,
        sourceSymmetry.count,
        member.symmetry!.index
      );
    return { ...op, id: member.id, patch };
  });
}

export function symmetryIds(plan: { entities: Entity[] }, ids: string[]): string[] {
  const groups = new Set(
    plan.entities.filter((e) => ids.includes(e.id) && e.symmetry).map((e) => e.symmetry!.id)
  );
  return [...new Set([...ids, ...plan.entities.filter((e) => groups.has(e.symmetry?.id ?? "")).map((e) => e.id)])];
}
