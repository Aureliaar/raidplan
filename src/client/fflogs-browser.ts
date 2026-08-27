import {
  formatFightTimestamp,
  parseFFLogsUrl,
  type FFLogsActorRef,
  type FFLogsDebuff,
  type FFLogsDebuffDump,
} from "../shared/fflogs";
import { loadXivApiStatusRows, type XivApiStatusRow } from "../shared/xivapi";
import { api } from "./api";

const TOKEN_KEY = "raidplan.fflogs.token";
const STATE_KEY = "raidplan.fflogs.state";
const PENDING_URL_KEY = "raidplan.fflogs.pending-url";
const EXCLUDED_STATUSES = new Set(["weakness", "brink of death", "damage down"]);

type FFLogsConfig = Awaited<ReturnType<typeof api.fflogsConfig>>;
type StoredToken = { accessToken: string; expiresAt: number };
type ReportFight = { id: number; name: string; encounterID?: number | null; startTime: number; endTime: number; kill: boolean };
type ReportAbility = { gameID: number; name: string };
type ReportActor = { id: number; name: string; type?: string | null; subType?: string | null };
type AuraEvent = {
  timestamp?: number;
  type?: string;
  abilityGameID?: number;
  ability?: { gameID?: number; guid?: number; id?: number; name?: string };
  sourceID?: number;
  targetID?: number;
};

const REPORT_QUERY = `
  query DebuffReport($code: String!, $fightIDs: [Int]) {
    reportData { report(code: $code) {
      fights(fightIDs: $fightIDs) { id name encounterID startTime endTime kill }
      masterData(translate: true) { abilities { gameID name } actors { id name type subType } }
      events(dataType: Debuffs, fightIDs: $fightIDs, hostilityType: Friendlies, limit: 10000,
        translate: true, useAbilityIDs: true, useActorIDs: true) { data nextPageTimestamp }
    } }
  }
`;

const EVENTS_QUERY = `
  query DebuffEvents($code: String!, $fightIDs: [Int], $startTime: Float) {
    reportData { report(code: $code) {
      events(dataType: Debuffs, fightIDs: $fightIDs, hostilityType: Friendlies, startTime: $startTime,
        limit: 10000, translate: true, useAbilityIDs: true, useActorIDs: true) { data nextPageTimestamp }
    } }
  }
`;

let callbackPromise: Promise<string | null> | null = null;
let lastGraphqlAt = 0;

function randomValue(bytes = 24): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function readToken(): StoredToken | null {
  try {
    const token = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? "null") as StoredToken | null;
    if (!token?.accessToken || token.expiresAt < Date.now() + 30_000) return null;
    return token;
  } catch {
    return null;
  }
}

export function hasFFLogsToken(): boolean {
  return !!readToken();
}

export function disconnectFFLogs(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export async function beginFFLogsAuthorization(pendingUrl?: string): Promise<never> {
  const config = await api.fflogsConfig();
  const state = randomValue();
  sessionStorage.setItem(STATE_KEY, state);
  if (pendingUrl) sessionStorage.setItem(PENDING_URL_KEY, pendingUrl);
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUrl,
    response_type: "code",
    state,
  });
  location.assign(`${config.authorizeUrl}?${params}`);
  return new Promise<never>(() => undefined);
}

export function completeFFLogsAuthorization(): Promise<string | null> {
  if (callbackPromise) return callbackPromise;
  callbackPromise = (async () => {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const error = params.get("error");
    if (!code && !error) return null;
    if (error) throw new Error(`FF Logs authorization failed: ${params.get("error_description") || error}`);
    const state = sessionStorage.getItem(STATE_KEY);
    if (!state || params.get("state") !== state) throw new Error("FF Logs authorization state did not match");
    const body = await api.fflogsExchange(code!);
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
      accessToken: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    } satisfies StoredToken));
    sessionStorage.removeItem(STATE_KEY);
    const pending = sessionStorage.getItem(PENDING_URL_KEY);
    sessionStorage.removeItem(PENDING_URL_KEY);
    history.replaceState({}, "", "/fflogs");
    return pending;
  })();
  return callbackPromise;
}

async function graphql<T>(config: FFLogsConfig, token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const delay = Math.max(0, lastGraphqlAt + 1100 - Date.now());
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  lastGraphqlAt = Date.now();
  const response = await fetch(config.userApiUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => ({})) as { data?: T; errors?: { message?: string }[]; error?: string };
  if (!response.ok) throw new Error(`FF Logs API: ${body.error || response.status}`);
  if (body.errors?.length) throw new Error(body.errors.map((item) => item.message || "GraphQL error").join("; "));
  if (!body.data) throw new Error("FF Logs API returned no data");
  return body.data;
}

function eventAbilityId(event: AuraEvent): number | null {
  const value = event.abilityGameID ?? event.ability?.gameID ?? event.ability?.guid ?? event.ability?.id;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function actorRef(id: number | undefined, actors: Map<number, ReportActor>): FFLogsActorRef | null {
  if (typeof id !== "number") return null;
  const actor = actors.get(id);
  return actor
    ? { id, name: actor.name, type: actor.type ?? null, subType: actor.subType ?? null }
    : { id, name: `Actor ${id}`, type: null, subType: null };
}

function iconFor(row: XivApiStatusRow | undefined): FFLogsDebuff["icon"] {
  const icon = row?.fields?.Icon;
  const path = icon?.path_hr1 || icon?.path;
  if (!icon?.id || !path) return null;
  const params = new URLSearchParams({ path, format: "png" });
  return { id: icon.id, path, url: `https://v2.xivapi.com/api/asset?${params}` };
}

export async function dumpFFLogsDebuffsInBrowser(input: string): Promise<FFLogsDebuffDump> {
  const stored = readToken();
  if (!stored) throw new Error("Connect FF Logs first");
  const parsed = parseFFLogsUrl(input);
  const config = await api.fflogsConfig();
  const variables = { code: parsed.reportCode, fightIDs: [parsed.fightId] };
  const initial = await graphql<{
    reportData?: { report?: {
      fights?: ReportFight[];
      masterData?: { abilities?: ReportAbility[]; actors?: ReportActor[] };
      events?: { data?: AuraEvent[]; nextPageTimestamp?: number | null };
    } | null };
  }>(config, stored.accessToken, REPORT_QUERY, variables);
  const report = initial.reportData?.report;
  if (!report) throw new Error("Report not found or not available to this FF Logs account");
  const fight = report.fights?.[0];
  if (!fight) throw new Error(`Fight ${parsed.fightId} was not found in this report`);

  const events = [...(report.events?.data ?? [])];
  let nextPageTimestamp = report.events?.nextPageTimestamp;
  let pages = 1;
  while (nextPageTimestamp && pages < 20) {
    const page = await graphql<{
      reportData?: { report?: { events?: { data?: AuraEvent[]; nextPageTimestamp?: number | null } } | null };
    }>(config, stored.accessToken, EVENTS_QUERY, { ...variables, startTime: nextPageTimestamp });
    const result = page.reportData?.report?.events;
    events.push(...(result?.data ?? []));
    if (result?.nextPageTimestamp === nextPageTimestamp) break;
    nextPageTimestamp = result?.nextPageTimestamp;
    pages += 1;
  }
  if (nextPageTimestamp) throw new Error("This fight has too many debuff events to export safely");

  const abilities = new Map((report.masterData?.abilities ?? []).map((ability) => [ability.gameID, ability.name]));
  const actors = new Map((report.masterData?.actors ?? []).map((actor) => [actor.id, actor]));
  const applications = new Map<number, { count: number; first: AuraEvent & { timestamp: number } }>();
  for (const event of events) {
    if (!event.type || !["applydebuff", "applydebuffstack", "refreshdebuff"].includes(event.type)) continue;
    if (typeof event.timestamp !== "number") continue;
    const id = eventAbilityId(event);
    if (!id) continue;
    const existing = applications.get(id);
    if (!existing) applications.set(id, { count: 1, first: event as AuraEvent & { timestamp: number } });
    else {
      existing.count += 1;
      if (event.timestamp < existing.first.timestamp) existing.first = event as AuraEvent & { timestamp: number };
    }
  }

  const includedIds = [...applications.keys()].filter((id) => !EXCLUDED_STATUSES.has((abilities.get(id) ?? "").trim().toLowerCase()));
  const statuses = await loadXivApiStatusRows(includedIds, abilities);
  const debuffs: FFLogsDebuff[] = includedIds.map((id) => {
    const application = applications.get(id)!;
    const row = statuses.get(id);
    const name = row?.fields?.Name || abilities.get(id) || application.first.ability?.name || `Status ${id}`;
    const firstAppliedMs = Math.max(0, application.first.timestamp >= fight.startTime
      ? application.first.timestamp - fight.startTime
      : application.first.timestamp);
    return {
      id,
      name,
      firstAppliedMs,
      firstApplied: formatFightTimestamp(firstAppliedMs),
      firstAppliedReportMs: application.first.timestamp,
      applications: application.count,
      firstSource: actorRef(application.first.sourceID, actors),
      firstTarget: actorRef(application.first.targetID, actors),
      tooltip: row?.fields?.Description ?? "",
      icon: iconFor(row),
    };
  }).filter((debuff) => !EXCLUDED_STATUSES.has(debuff.name.trim().toLowerCase()));
  debuffs.sort((a, b) => a.firstAppliedMs - b.firstAppliedMs || a.id - b.id);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: { url: parsed.url, reportCode: parsed.reportCode, fightId: parsed.fightId, targetScope: "friendlies" },
    fight: {
      id: fight.id,
      name: fight.name,
      encounterId: fight.encounterID ?? null,
      startTime: fight.startTime,
      endTime: fight.endTime,
      durationMs: fight.endTime - fight.startTime,
      kill: fight.kill,
    },
    excludedStatuses: ["Weakness", "Brink of Death", "Damage Down"],
    debuffs,
  };
}
