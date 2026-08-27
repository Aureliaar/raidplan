import {
  formatFightTimestamp,
  parseFFLogsUrl,
  type FFLogsActorRef,
  type FFLogsDebuff,
  type FFLogsDebuffDump,
} from "../shared/fflogs";
import { loadXivApiStatusRows, type XivApiStatusRow } from "../shared/xivapi";
import type { AppEnv } from "./env";

const FFLOGS_TOKEN_URL = "https://www.fflogs.com/oauth/token";
const FFLOGS_API_URL = "https://www.fflogs.com/api/v2/client";
const XIVAPI_ASSET_URL = "https://v2.xivapi.com/api/asset";
const EXCLUDED_STATUSES = new Set(["weakness", "brink of death", "damage down"]);
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const FFLOGS_REQUEST_INTERVAL_MS = 1_100;

// OAuth credentials are server configuration, not request/user state. Reuse the
// short-lived bearer token within an isolate and coalesce simultaneous refreshes.
let cachedToken: { value: string; expiresAt: number } | null = null;
let pendingToken: Promise<string> | null = null;
let lastFFLogsRequestAt = 0;
let fflogsRequestLane: Promise<void> = Promise.resolve();

type GraphQLError = { message?: string };
type GraphQLResponse<T> = { data?: T; errors?: GraphQLError[] };

type ReportFight = {
  id: number;
  name: string;
  encounterID?: number | null;
  startTime: number;
  endTime: number;
  kill: boolean;
};

type ReportAbility = { gameID: number; name: string };
type ReportActor = {
  id: number;
  name: string;
  type?: string | null;
  subType?: string | null;
};

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
    reportData {
      report(code: $code) {
        fights(fightIDs: $fightIDs) { id name encounterID startTime endTime kill }
        masterData(translate: true) {
          abilities { gameID name }
          actors { id name type subType }
        }
        events(
          dataType: Debuffs
          fightIDs: $fightIDs
          hostilityType: Friendlies
          limit: 10000
          translate: true
          useAbilityIDs: true
          useActorIDs: true
        ) { data nextPageTimestamp }
      }
    }
  }
`;

const EVENTS_QUERY = `
  query DebuffEvents($code: String!, $fightIDs: [Int], $startTime: Float) {
    reportData {
      report(code: $code) {
        events(
          dataType: Debuffs
          fightIDs: $fightIDs
          hostilityType: Friendlies
          startTime: $startTime
          limit: 10000
          translate: true
          useAbilityIDs: true
          useActorIDs: true
        ) { data nextPageTimestamp }
      }
    }
  }
`;

async function jsonResponse<T>(response: Response, service: string): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${service} returned an unreadable response (${response.status})`);
  }
  if (!response.ok) {
    const message = typeof body === "object" && body && "error" in body
      ? [String((body as { error: unknown }).error), "error_description" in body
          ? String((body as { error_description: unknown }).error_description)
          : ""].filter(Boolean).join(": ")
      : `${service} request failed (${response.status})`;
    throw new Error(`${service}: ${message}`);
  }
  return body as T;
}

async function requestAccessToken(env: AppEnv): Promise<string> {
  if (!env.FFLOGS_CLIENT_ID || !env.FFLOGS_CLIENT_SECRET) {
    throw new Error("FF Logs integration is not configured on this server");
  }
  const response = await fetch(FFLOGS_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${env.FFLOGS_CLIENT_ID}:${env.FFLOGS_CLIENT_SECRET}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  lastFFLogsRequestAt = Date.now();
  const body = await jsonResponse<{ access_token?: string; expires_in?: number }>(response, "FF Logs OAuth");
  if (!body.access_token) throw new Error("FF Logs OAuth did not return an access token");
  const lifetimeMs = Math.max(120_000, (body.expires_in ?? 3600) * 1000);
  cachedToken = { value: body.access_token, expiresAt: Date.now() + lifetimeMs };
  return body.access_token;
}

function pacedFFLogsFetch(init: RequestInit): Promise<Response> {
  const request = fflogsRequestLane.then(async () => {
    const delay = Math.max(0, lastFFLogsRequestAt + FFLOGS_REQUEST_INTERVAL_MS - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    lastFFLogsRequestAt = Date.now();
    return fetch(FFLOGS_API_URL, init);
  });
  fflogsRequestLane = request.then(() => undefined, () => undefined);
  return request;
}

async function accessToken(env: AppEnv): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
    return cachedToken.value;
  }
  if (pendingToken) return pendingToken;
  pendingToken = requestAccessToken(env).finally(() => { pendingToken = null; });
  return pendingToken;
}

async function graphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await pacedFFLogsFetch({
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await jsonResponse<GraphQLResponse<T>>(response, "FF Logs API");
  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message || "Unknown GraphQL error").join("; "));
  }
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

function fightRelativeTime(timestamp: number, fight: ReportFight): number {
  return Math.max(0, timestamp >= fight.startTime ? timestamp - fight.startTime : timestamp);
}

function iconFor(row: XivApiStatusRow | undefined): FFLogsDebuff["icon"] {
  const icon = row?.fields?.Icon;
  const path = icon?.path_hr1 || icon?.path;
  if (!icon?.id || !path) return null;
  const params = new URLSearchParams({ path, format: "png" });
  return { id: icon.id, path, url: `${XIVAPI_ASSET_URL}?${params}` };
}

export async function dumpFFLogsDebuffs(input: string, env: AppEnv): Promise<FFLogsDebuffDump> {
  const parsed = parseFFLogsUrl(input);
  const token = await accessToken(env);
  const variables = { code: parsed.reportCode, fightIDs: [parsed.fightId] };
  const initial = await graphql<{
    reportData?: { report?: {
      fights?: ReportFight[];
      masterData?: { abilities?: ReportAbility[]; actors?: ReportActor[] };
      events?: { data?: AuraEvent[]; nextPageTimestamp?: number | null };
    } | null };
  }>(token, REPORT_QUERY, variables);

  const report = initial.reportData?.report;
  if (!report) throw new Error("Report not found or not public");
  const fight = report.fights?.[0];
  if (!fight) throw new Error(`Fight ${parsed.fightId} was not found in this report`);

  const events = [...(report.events?.data ?? [])];
  let nextPageTimestamp = report.events?.nextPageTimestamp;
  let pages = 1;
  while (nextPageTimestamp && pages < 20) {
    const page = await graphql<{
      reportData?: { report?: { events?: { data?: AuraEvent[]; nextPageTimestamp?: number | null } } | null };
    }>(token, EVENTS_QUERY, { ...variables, startTime: nextPageTimestamp });
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

  const statuses = await loadXivApiStatusRows([...applications.keys()], abilities);
  const debuffs: FFLogsDebuff[] = [];
  for (const [id, application] of applications) {
    const row = statuses.get(id);
    const name = row?.fields?.Name || abilities.get(id) || application.first.ability?.name || `Status ${id}`;
    if (EXCLUDED_STATUSES.has(name.trim().toLowerCase())) continue;
    const firstAppliedMs = fightRelativeTime(application.first.timestamp, fight);
    debuffs.push({
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
    });
  }
  debuffs.sort((a, b) => a.firstAppliedMs - b.firstAppliedMs || a.id - b.id);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      url: parsed.url,
      reportCode: parsed.reportCode,
      fightId: parsed.fightId,
      targetScope: "friendlies",
    },
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
