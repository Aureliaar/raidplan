import type { Arena, Plan } from "./schema";

export const DEFAULT_ARENA_WIDTH_YALMS = 40;

export interface KnownArenaCalibration {
  label: string;
  shape: Arena["shape"];
  widthYalms: number;
  heightYalms: number;
}

export interface ArenaCalibration extends KnownArenaCalibration {
  source: "manual" | "known" | "default";
}

/**
 * Public encounter data generally names arena bounds by their half-size. The
 * catalogue stores full wall-to-wall dimensions, which is what authors see.
 * Match the encounter title and bundled backdrop so imported/loosely named
 * plans can still pick up a known floor. Values are cross-checked against the
 * public BossMod encounter bounds: github.com/awgil/ffxiv_bossmod.
 */
export function knownArenaCalibration(plan: Plan): KnownArenaCalibration | undefined {
  const key = `${plan.encounter} ${plan.arena.image ?? ""}`.toLowerCase();
  const has = (...patterns: RegExp[]) => patterns.some((pattern) => pattern.test(key));

  // Phase-specific matches have to win over the encounter-wide M12S match.
  if (has(/\bm12s\b.*\b(p2|phase 2)\b/, /heavyweight m4.*\b(p2|phase 2)\b/, /arcadion12-p2/))
    return { label: "M12S phase 2", shape: "circle", widthYalms: 40, heightYalms: 40 };
  if (has(/\bm12s\b/, /heavyweight m4/, /arcadion12/))
    return { label: "M12S phase 1", shape: "rect", widthYalms: 40, heightYalms: 30 };
  if (has(/\bm11s\b/, /heavyweight m3/, /arcadion11/))
    return { label: "M11S", shape: "square", widthYalms: 40, heightYalms: 40 };
  if (has(/\bm10s\b/, /heavyweight m2/, /arcadion10/))
    return { label: "M10S", shape: "square", widthYalms: 40, heightYalms: 40 };
  if (has(/\bm9s\b/, /heavyweight m1/, /arcadion9/))
    return { label: "M9S", shape: "square", widthYalms: 40, heightYalms: 40 };

  if (has(/\bm8s\b.*\b(p2|phase 2)\b/, /arcadion8-(p2|sp2)/))
    return { label: "M8S phase 2", shape: plan.arena.shape, widthYalms: 24, heightYalms: 24 * (plan.arena.height / plan.arena.width) };
  if (has(/\bm8s\b/, /arcadion8/))
    return { label: "M8S phase 1", shape: "circle", widthYalms: 24, heightYalms: 24 };
  if (has(/\bm7s\b/, /arcadion7/))
    return { label: "M7S", shape: "square", widthYalms: 40, heightYalms: 40 };
  if (has(/\bm6s\b/, /arcadion6/))
    return { label: "M6S", shape: "square", widthYalms: 40, heightYalms: 40 };
  if (has(/\bm5s\b/))
    return { label: "M5S", shape: "square", widthYalms: 40, heightYalms: 40 };
  if (has(/\bm4s\b.*\b(p2|phase 2)\b/, /arcadion4-p2/))
    return { label: "M4S phase 2", shape: "rect", widthYalms: 40, heightYalms: 30 };
  if (has(/\bm4s\b/, /arcadion4/))
    return { label: "M4S phase 1", shape: "square", widthYalms: 40, heightYalms: 40 };
  if (has(/\bm3s\b/, /arcadion3/))
    return { label: "M3S", shape: "square", widthYalms: 30, heightYalms: 30 };
  if (has(/\bm2s\b/, /arcadion2/))
    return { label: "M2S", shape: "circle", widthYalms: 40, heightYalms: 40 };
  if (has(/\bm1s\b/))
    return { label: "M1S", shape: "square", widthYalms: 40, heightYalms: 40 };

  return undefined;
}

/** Manual calibration wins; otherwise use encounter knowledge, then 40 yalms. */
export function arenaCalibration(plan: Plan): ArenaCalibration {
  if (plan.arena.widthYalms !== undefined) {
    return {
      label: "manual override",
      source: "manual",
      shape: plan.arena.shape,
      widthYalms: plan.arena.widthYalms,
      heightYalms: plan.arena.widthYalms * (plan.arena.height / plan.arena.width),
    };
  }
  const known = knownArenaCalibration(plan);
  if (known) return { ...known, source: "known" };
  return {
    label: "default assumption",
    source: "default",
    shape: plan.arena.shape,
    widthYalms: DEFAULT_ARENA_WIDTH_YALMS,
    heightYalms: DEFAULT_ARENA_WIDTH_YALMS * (plan.arena.height / plan.arena.width),
  };
}

/** Does the authored floor have the known encounter's shape and proportions? */
export function arenaMatchesKnownGeometry(plan: Plan, known: KnownArenaCalibration): boolean {
  const authoredRatio = plan.arena.height / plan.arena.width;
  const knownRatio = known.heightYalms / known.widthYalms;
  return plan.arena.shape === known.shape && Math.abs(authoredRatio - knownRatio) < 1e-6;
}
