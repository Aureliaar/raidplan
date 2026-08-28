import type { Entity, Plan, ZoneEntity } from "./schema";
import { entitiesForStep } from "./schema";

/**
 * Who a zone actually catches.
 *
 * A player's hitbox in FFXIV is a point: the token art is 3 yalms of picture
 * around a position that is either inside the AoE or is not. So every test here
 * is point-in-shape, and a token whose art overlaps a beam by half its width is
 * not hit — which is exactly the call you cannot make by eye, and the reason
 * this exists rather than "looks close enough".
 */

/** Put a point into a zone's local frame: rotation undone, scale divided out. */
function toLocal(zone: ZoneEntity, px: number, py: number): { x: number; y: number } {
  const dx = px - zone.x;
  const dy = py - zone.y;
  const t = (zone.rotation * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const s = zone.scale || 1;
  return { x: (dx * cos + dy * sin) / s, y: (-dx * sin + dy * cos) / s };
}

/** Is (px, py) inside this zone, treating the point as the whole hitbox? */
export function zoneCovers(zone: ZoneEntity, px: number, py: number): boolean {
  const p = toLocal(zone, px, py);
  const d = Math.hypot(p.x, p.y);

  switch (zone.shape) {
    case "circle":
    case "stack":
    case "flare":
    case "spread":
    case "tower":
    case "proximity":
    case "meteor":
      return d <= zone.radius;

    case "donut":
      return d <= zone.radius && d >= zone.innerRadius;

    case "cone": {
      if (d > zone.radius) return false;
      // Local north is the cone's centre line; it opens `angle` degrees wide.
      const bearing = (Math.atan2(p.x, -p.y) * 180) / Math.PI;
      return Math.abs(bearing) <= zone.angle / 2;
    }

    case "rect":
    case "line":
    case "knockback":
    case "linestack":
      return Math.abs(p.x) <= zone.width / 2 && Math.abs(p.y) <= zone.length / 2;

    case "triangle": {
      // A Konva RegularPolygon with 3 sides, point up: vertices every 120°.
      const vs = [0, 1, 2].map((i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
        return { x: Math.cos(a) * zone.radius, y: Math.sin(a) * zone.radius };
      });
      const side = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      const s0 = side(vs[0], vs[1]);
      const s1 = side(vs[1], vs[2]);
      const s2 = side(vs[2], vs[0]);
      return (s0 >= 0 && s1 >= 0 && s2 >= 0) || (s0 <= 0 && s1 <= 0 && s2 <= 0);
    }

    case "eye": {
      const rx = zone.radius;
      const ry = zone.radius * 0.6;
      return (p.x / rx) ** 2 + (p.y / ry) ** 2 <= 1;
    }

    case "exaflare":
      // Each puff of the trail, marching along local north.
      return Array.from({ length: zone.count }, (_, i) => i).some(
        (i) => Math.hypot(p.x, p.y + i * zone.radius * 2.1) <= zone.radius
      );

    case "arrow":
      // An arrow annotates a movement; it does not hit anybody.
      return false;
  }
}

/** The players a zone catches in this step, in party order. */
export function playersHit(
  plan: Plan,
  stepId: string | undefined,
  zoneId: string,
  shown?: Record<string, string>
): Entity[] {
  const drawn = entitiesForStep(plan, stepId, undefined, shown);
  const zone = drawn.find((e) => e.id === zoneId);
  if (!zone || zone.type !== "zone") return [];
  return drawn.filter((e) => e.type === "player" && zoneCovers(zone, e.x, e.y));
}
