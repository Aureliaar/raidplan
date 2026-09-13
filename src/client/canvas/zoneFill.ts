import type Konva from "konva";
import type { Arena, ZoneEntity } from "../../shared/schema";

/**
 * How a zone's inside is painted. The telegraph is faint at the heart and dense
 * at the rim; the others are for things it reads wrong on.
 */

export const ZONE_DEFAULT = "#ff7043";

export function rgbaOf(color: string, alpha: number): string | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!m) return undefined;
  const digits = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const n = parseInt(digits, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** The telegraph's three stops, heart to rim; `blast` floods them as it goes off. */
export function telegraphStops(color: string, blast: number) {
  const core = rgbaOf(color, 0.62 * blast);
  const mid = rgbaOf(color, 0.1 + 0.55 * blast);
  const rim = rgbaOf(color, 0.32 + 0.45 * blast);
  return core && mid && rim ? { core, mid, rim } : undefined;
}

/** Shapes whose fade runs from a centre line out to their sides rather than from a point. */
export const BAR_SHAPES = new Set<ZoneEntity["shape"]>(["rect", "line", "knockback", "linestack", "cross"]);

type Pt = { x: number; y: number };
export type Box = { x0: number; x1: number; y0: number; y1: number };

function insideArena(arena: Arena, p: Pt): boolean {
  const w = arena.width / 2;
  if (arena.shape === "circle") return Math.hypot(p.x, p.y) <= w;
  const h = (arena.shape === "rect" ? arena.height : arena.width) / 2;
  return Math.abs(p.x) <= w && Math.abs(p.y) <= h;
}

/** Local (as drawn inside the zone's group) to arena coordinates. */
function toArena(zone: ZoneEntity, p: Pt): Pt {
  const a = (zone.rotation * Math.PI) / 180;
  const s = zone.scale;
  return {
    x: zone.x + s * (p.x * Math.cos(a) - p.y * Math.sin(a)),
    y: zone.y + s * (p.x * Math.sin(a) + p.y * Math.cos(a)),
  };
}

function insideTriangle(p: Pt, r: number): boolean {
  // RegularPolygon with three sides points up: vertices at -90°, 30°, 150°.
  const v = [-90, 30, 150].map((d) => ({ x: r * Math.cos((d * Math.PI) / 180), y: r * Math.sin((d * Math.PI) / 180) }));
  const side = (a: Pt, b: Pt) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const s = [side(v[0], v[1]), side(v[1], v[2]), side(v[2], v[0])];
  return s.every((x) => x >= 0) || s.every((x) => x <= 0);
}

/** Whether a local point is inside the shape's fill. */
function insideShape(zone: ZoneEntity, p: Pt): boolean {
  const d = Math.hypot(p.x, p.y);
  switch (zone.shape) {
    case "donut":
      return d <= zone.radius && d >= zone.innerRadius;
    case "cone": {
      if (d > zone.radius) return false;
      // Straddles north: angle measured from -y.
      const off = Math.abs((Math.atan2(p.x, -p.y) * 180) / Math.PI);
      return off <= zone.angle / 2;
    }
    case "triangle":
      return insideTriangle(p, zone.radius);
    case "eye":
      return (p.x / zone.radius) ** 2 + (p.y / (zone.radius * 0.6)) ** 2 <= 1;
    default:
      return d <= zone.radius;
  }
}

function localBounds(zone: ZoneEntity): Box {
  const r = zone.radius;
  return { x0: -r, x1: r, y0: -r, y1: r };
}

const SAMPLES = 32;

/** Past this share of the arena's width a zone's fade is fitted to it; below, it is the plain telegraph. */
const BIG = 0.4;
export const isBig = (size: number, arena: Arena) => size > BIG * arena.width;

type Seen = { box: Box; points: Pt[]; clipped: boolean };

/** The sampled points of `box` (filtered by `keep`) that lie on the floor, and their local bounding box. */
function visible(zone: ZoneEntity, arena: Arena, box: Box, keep: (p: Pt) => boolean): Seen | null {
  let out: Box | null = null;
  const points: Pt[] = [];
  let clipped = false;
  for (let i = 0; i <= SAMPLES; i++)
    for (let j = 0; j <= SAMPLES; j++) {
      const p = { x: box.x0 + ((box.x1 - box.x0) * i) / SAMPLES, y: box.y0 + ((box.y1 - box.y0) * j) / SAMPLES };
      if (!keep(p)) continue;
      if (!insideArena(arena, toArena(zone, p))) {
        clipped = true;
        continue;
      }
      points.push(p);
      out = out
        ? { x0: Math.min(out.x0, p.x), x1: Math.max(out.x1, p.x), y0: Math.min(out.y0, p.y), y1: Math.max(out.y1, p.y) }
        : { x0: p.x, x1: p.x, y0: p.y, y1: p.y };
    }
  return out ? { box: out, points, clipped } : null;
}

/**
 * Where a round shape's telegraph is centred and how far it reaches: fitted to
 * the part of the shape on the floor, so a huge circle running out through a
 * wall still has its rim where people can see it. Unclipped, it is the shape's
 * own centre and radius, which is what the game draws.
 */
export function radialFit(zone: ZoneEntity, arena: Arena): { cx: number; cy: number; r: number } {
  const whole = { cx: 0, cy: 0, r: zone.radius };
  if (!isBig(2 * zone.radius * zone.scale, arena)) return whole;
  const seen = visible(zone, arena, localBounds(zone), (p) => insideShape(zone, p));
  if (!seen || !seen.clipped) return whole;
  const cx = (seen.box.x0 + seen.box.x1) / 2;
  const cy = (seen.box.y0 + seen.box.y1) / 2;
  const r = Math.max(...seen.points.map((p) => Math.hypot(p.x - cx, p.y - cy)));
  return { cx, cy, r: Math.max(r, 1) };
}

/** A bar and the axes its fade runs along. */
export type Bar = { box: Box; whole: Box; x: boolean; y: boolean };

/**
 * The bars whose fade is fitted, or null for a shape small enough to keep the
 * plain telegraph. A bar's fade runs only along an axis that is big, trimmed to
 * the part of it on the floor; an axis that is not stays even across.
 */
export function barPlan(zone: ZoneEntity, arena: Arena): Bar[] | null {
  const w = zone.width / 2;
  const l = zone.length / 2;
  const big = (half: number) => isBig(2 * half * zone.scale, arena);
  const bars =
    zone.shape === "cross"
      ? [
          { whole: { x0: -w, x1: w, y0: -l, y1: l }, x: big(w), y: big(l) },
          { whole: { x0: -l, x1: l, y0: -w, y1: w }, x: big(l), y: big(w) },
        ]
      : [{ whole: { x0: -w, x1: w, y0: -l, y1: l }, x: big(w), y: big(l) }];
  if (!bars.some((bar) => bar.x || bar.y)) return null;
  return bars.map((bar) => {
    const seen = visible(zone, arena, bar.whole, () => true)?.box;
    const box = { ...bar.whole };
    if (seen && bar.x) Object.assign(box, { x0: seen.x0, x1: seen.x1 });
    if (seen && bar.y) Object.assign(box, { y0: seen.y0, y1: seen.y1 });
    return { ...bar, box };
  });
}

type Stops = { core: string; mid: string; rim: string };

function addStops(g: CanvasGradient, s: Stops, mirrored = false) {
  if (mirrored) {
    g.addColorStop(0, s.rim);
    g.addColorStop(0.125, s.mid);
    g.addColorStop(0.5, s.core);
    g.addColorStop(0.875, s.mid);
    g.addColorStop(1, s.rim);
  } else {
    g.addColorStop(0, s.core);
    g.addColorStop(0.75, s.mid);
    g.addColorStop(1, s.rim);
  }
}

function tri(c: CanvasRenderingContext2D, a: Pt, b: Pt, d: Pt, fill: CanvasGradient | string) {
  c.beginPath();
  c.moveTo(a.x, a.y);
  c.lineTo(b.x, b.y);
  c.lineTo(d.x, d.y);
  c.closePath();
  c.fillStyle = fill;
  c.fill();
}

/**
 * A telegraph over a rectangle: the fade runs from the middle to every edge at
 * once, so a long thin beam is clear down its spine and dense along both sides,
 * the way a small circle is. Four triangles meeting at the centre, one per edge.
 */
function pyramid(c: CanvasRenderingContext2D, b: Box, s: Stops) {
  const m = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  const corners = [
    { x: b.x0, y: b.y0 },
    { x: b.x1, y: b.y0 },
    { x: b.x1, y: b.y1 },
    { x: b.x0, y: b.y1 },
  ];
  const edges: Pt[] = [
    { x: m.x, y: b.y0 },
    { x: b.x1, y: m.y },
    { x: m.x, y: b.y1 },
    { x: b.x0, y: m.y },
  ];
  for (let i = 0; i < 4; i++) {
    const g = c.createLinearGradient(m.x, m.y, edges[i].x, edges[i].y);
    addStops(g, s);
    tri(c, m, corners[i], corners[(i + 1) % 4], g);
  }
}

/** The part of `outer` not covered by `inner` gets the rim: it is off the floor, and the wall is its edge. */
function rimOutside(c: CanvasRenderingContext2D, outer: Box, inner: Box, rim: string) {
  c.beginPath();
  c.rect(outer.x0, outer.y0, outer.x1 - outer.x0, outer.y1 - outer.y0);
  c.rect(inner.x0, inner.y0, inner.x1 - inner.x0, inner.y1 - inner.y0);
  c.fillStyle = rim;
  c.fill("evenodd");
}

/** One bar's fade: every edge when both axes are big, otherwise straight across the big one. */
function barFade(c: CanvasRenderingContext2D, bar: Bar, s: Stops) {
  const { box } = bar;
  rimOutside(c, bar.whole, box, s.rim);
  if (bar.x && bar.y) return pyramid(c, box, s);
  const g = bar.x ? c.createLinearGradient(box.x0, 0, box.x1, 0) : c.createLinearGradient(0, box.y0, 0, box.y1);
  addStops(g, s, true);
  c.fillStyle = g;
  c.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
}

/** Draws a bar-shaped zone's fitted telegraph. Hands back a Konva sceneFunc. */
export function barTelegraph(zone: ZoneEntity, bars: Bar[], s: Stops) {
  const w = zone.width / 2;
  return (ctx: Konva.Context) => {
    const c = (ctx as unknown as { _context: CanvasRenderingContext2D })._context;
    if (bars.length === 1) return barFade(c, bars[0], s);
    // A cross is one shape, so the middle is painted once: by the first bar,
    // with the second clipped out of it.
    barFade(c, bars[0], s);
    const { whole } = bars[1];
    c.save();
    c.beginPath();
    c.rect(whole.x0, whole.y0, whole.x1 - whole.x0, whole.y1 - whole.y0);
    c.rect(-w, -w, 2 * w, 2 * w);
    c.clip("evenodd");
    barFade(c, bars[1], s);
    c.restore();
  };
}

const hatchCache = new Map<string, HTMLCanvasElement>();

/** A seamless 45° stripe tile, in arena units, for the hazard look. */
export function hazardTile(color: string, blast: number): HTMLCanvasElement | undefined {
  const step = Math.round(blast * 4) / 4;
  const key = `${color}|${step}`;
  const hit = hatchCache.get(key);
  if (hit) return hit;
  const ground = rgbaOf(color, 0.14 + 0.4 * step);
  const stripe = rgbaOf(color, 0.45 + 0.35 * step);
  if (!ground || !stripe || typeof document === "undefined") return undefined;
  const size = 44;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext("2d");
  if (!c) return undefined;
  c.fillStyle = ground;
  c.fillRect(0, 0, size, size);
  c.strokeStyle = stripe;
  c.lineWidth = 10;
  for (const o of [-size, 0, size]) {
    c.beginPath();
    c.moveTo(o, size);
    c.lineTo(o + size, 0);
    c.stroke();
  }
  hatchCache.set(key, canvas);
  return canvas;
}
