import { z } from "zod";
import type { FFLogsDebuffDump } from "./fflogs";

const ActorRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    type: z.string().nullable(),
    subType: z.string().nullable(),
  })
  .nullable();

/**
 * The debuff library: one entry per fight, built out of the logs people run
 * through the FF Logs tool. A dump is a single pull and only sees the statuses
 * that pull happened to reach, so imports of the same fight merge rather than
 * replace — the library is everything the group has ever seen the fight do.
 */
export type FightLibraryEntry = {
  key: string;
  name: string;
  encounterId: number | null;
  /** How many distinct statuses the library holds for this fight. */
  debuffs: number;
  /** Encounter names ("p12s") that resolve to this fight. */
  aliases: string[];
  updatedAt: number;
  /** The most recent import, for "where did this come from". */
  source: FFLogsDebuffDump["source"];
};

/**
 * The fight a dump belongs to. Ranked fights carry an encounter id; anything
 * else (trash, unranked duty) falls back to its name, which is all FF Logs
 * gives such a pull to be identified by.
 */
export function fightKey(fight: FFLogsDebuffDump["fight"]): string {
  return fight.encounterId ? `e${fight.encounterId}` : `n:${encounterAlias(fight.name)}`;
}

/** "P12S — Athena" and "p12s — athena" name the same fight. */
export function encounterAlias(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Two pulls of one fight, folded together. A status is kept once, under the
 * earliest first application anyone has recorded — the timeline the picker
 * reads is "when this lands in the fight", not "when it landed in that pull".
 */
export function mergeDumps(existing: FFLogsDebuffDump, incoming: FFLogsDebuffDump): FFLogsDebuffDump {
  const debuffs = new Map(existing.debuffs.map((d) => [d.id, d]));
  for (const debuff of incoming.debuffs) {
    const held = debuffs.get(debuff.id);
    if (!held || debuff.firstAppliedMs < held.firstAppliedMs) debuffs.set(debuff.id, debuff);
  }
  return {
    ...incoming,
    debuffs: [...debuffs.values()].sort((a, b) => a.firstAppliedMs - b.firstAppliedMs || a.id - b.id),
  };
}

/**
 * Which library fight a plan is about. A name the user has already linked wins;
 * otherwise the fight's own name, either side of which may carry the extra
 * ("Athena" for a plan called "P12S — Athena"). No guess beyond that: an
 * unrecognised encounter is for the author to point at a fight themselves.
 */
export function fightForEncounter(
  entries: FightLibraryEntry[],
  encounter: string | undefined,
): FightLibraryEntry | null {
  const wanted = encounterAlias(encounter ?? "");
  if (!wanted) return null;
  const linked = entries.find((entry) => entry.aliases.includes(wanted));
  if (linked) return linked;
  return (
    entries.find((entry) => encounterAlias(entry.name) === wanted) ??
    entries.find((entry) => {
      const name = encounterAlias(entry.name);
      return name.length > 2 && (wanted.includes(name) || name.includes(wanted));
    }) ??
    null
  );
}

/**
 * A posted dump, checked before it joins shared storage. Everyone reads the
 * library, so an entry has to be a dump this app produced, not whatever JSON
 * was in the request.
 */
export const FFLogsDebuffDumpSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  source: z.object({
    url: z.string().url(),
    reportCode: z.string().min(1),
    fightId: z.number().int(),
    targetScope: z.literal("friendlies"),
  }),
  fight: z.object({
    id: z.number().int(),
    name: z.string().min(1),
    encounterId: z.number().int().nullable(),
    startTime: z.number(),
    endTime: z.number(),
    durationMs: z.number(),
    kill: z.boolean(),
  }),
  excludedStatuses: z.tuple([
    z.literal("Weakness"),
    z.literal("Brink of Death"),
    z.literal("Damage Down"),
  ]),
  debuffs: z.array(
    z.object({
      id: z.number().int(),
      name: z.string().min(1),
      firstAppliedMs: z.number(),
      firstApplied: z.string(),
      firstAppliedReportMs: z.number(),
      applications: z.number(),
      firstSource: ActorRefSchema,
      firstTarget: ActorRefSchema,
      tooltip: z.string(),
      icon: z
        .object({ id: z.number().int(), path: z.string(), url: z.string().url() })
        .nullable(),
    }),
  ).max(400),
});

/** The same check, as the parse a route does. Throws on anything else. */
export function parseDebuffDump(input: unknown): FFLogsDebuffDump {
  return FFLogsDebuffDumpSchema.parse(input);
}
