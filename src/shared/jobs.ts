/**
 * FFXIV job / role vocabulary shared by the canvas, the API and the MCP tools.
 */

export const ROLES = ["tank", "healer", "melee", "ranged", "caster", "dps", "any"] as const;
export type Role = (typeof ROLES)[number];

export interface JobInfo {
  id: string;
  name: string;
  role: Role;
  /** Party-slot shorthand people actually type: "MT", "OT", "H1"... handled separately. */
  abbr: string;
}

const J = (id: string, name: string, role: Role): JobInfo => ({ id, name, role, abbr: id });

export const JOBS: JobInfo[] = [
  // Tanks
  J("PLD", "Paladin", "tank"),
  J("WAR", "Warrior", "tank"),
  J("DRK", "Dark Knight", "tank"),
  J("GNB", "Gunbreaker", "tank"),
  // Healers
  J("WHM", "White Mage", "healer"),
  J("SCH", "Scholar", "healer"),
  J("AST", "Astrologian", "healer"),
  J("SGE", "Sage", "healer"),
  // Melee
  J("MNK", "Monk", "melee"),
  J("DRG", "Dragoon", "melee"),
  J("NIN", "Ninja", "melee"),
  J("SAM", "Samurai", "melee"),
  J("RPR", "Reaper", "melee"),
  J("VPR", "Viper", "melee"),
  // Physical ranged
  J("BRD", "Bard", "ranged"),
  J("MCH", "Machinist", "ranged"),
  J("DNC", "Dancer", "ranged"),
  // Casters
  J("BLM", "Black Mage", "caster"),
  J("SMN", "Summoner", "caster"),
  J("RDM", "Red Mage", "caster"),
  J("PCT", "Pictomancer", "caster"),
  J("BLU", "Blue Mage", "caster"),
];

export const JOB_IDS = JOBS.map((j) => j.id);

/** Anything acceptable in `player.job`: a job id, a bare role, or a party slot. */
export const PARTY_SLOTS = ["MT", "OT", "T1", "T2", "H1", "H2", "D1", "D2", "D3", "D4"] as const;

export const ROLE_COLORS: Record<Role, string> = {
  tank: "#3f6ac4",
  healer: "#29a655",
  melee: "#b5432b",
  ranged: "#b58c2b",
  caster: "#8c4fc4",
  dps: "#b52626",
  any: "#8a8f98",
};

const BY_ID = new Map(JOBS.map((j) => [j.id, j]));

/** Resolve a job id, role name or party slot to a role (used for colouring). */
export function roleOf(job: string): Role {
  const key = job.toUpperCase();
  const info = BY_ID.get(key);
  if (info) return info.role;
  const lower = job.toLowerCase();
  if ((ROLES as readonly string[]).includes(lower)) return lower as Role;
  if (key.startsWith("MT") || key.startsWith("OT") || /^T\d$/.test(key)) return "tank";
  if (/^H\d$/.test(key)) return "healer";
  if (/^D\d$/.test(key)) return "dps";
  return "any";
}

export function jobColor(job: string): string {
  return ROLE_COLORS[roleOf(job)];
}

export function jobLabel(job: string): string {
  const info = BY_ID.get(job.toUpperCase());
  return info ? info.id : job.toUpperCase();
}

/** A standard 8-player light-party-x2 composition, used by `add_party` / new plans. */
export const DEFAULT_PARTY: { job: string; name: string }[] = [
  { job: "PLD", name: "MT" },
  { job: "WAR", name: "OT" },
  { job: "WHM", name: "H1" },
  { job: "SCH", name: "H2" },
  { job: "SAM", name: "D1" },
  { job: "DRG", name: "D2" },
  { job: "BRD", name: "D3" },
  { job: "BLM", name: "D4" },
];
