export type FFLogsActorRef = {
  id: number;
  name: string;
  type: string | null;
  subType: string | null;
};

export type FFLogsDebuff = {
  id: number;
  name: string;
  firstAppliedMs: number;
  firstApplied: string;
  firstAppliedReportMs: number;
  applications: number;
  firstSource: FFLogsActorRef | null;
  firstTarget: FFLogsActorRef | null;
  tooltip: string;
  icon: {
    id: number;
    path: string;
    url: string;
  } | null;
};

export type FFLogsDebuffDump = {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    url: string;
    reportCode: string;
    fightId: number;
    targetScope: "friendlies";
  };
  fight: {
    id: number;
    name: string;
    encounterId: number | null;
    startTime: number;
    endTime: number;
    durationMs: number;
    kill: boolean;
  };
  excludedStatuses: ["Weakness", "Brink of Death", "Damage Down"];
  debuffs: FFLogsDebuff[];
};

export type ParsedFFLogsUrl = {
  url: string;
  reportCode: string;
  fightId: number;
};

export function parseFFLogsUrl(input: string): ParsedFFLogsUrl {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a valid FF Logs report URL");
  }

  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (hostname !== "fflogs.com" && !hostname.endsWith(".fflogs.com"))) {
    throw new Error("The URL must be an https://fflogs.com report link");
  }

  const match = /^\/reports\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
  if (!match) throw new Error("The URL must point to /reports/{report-code}");

  const fightValue = url.searchParams.get("fight");
  const fightId = Number(fightValue);
  if (!fightValue || !Number.isSafeInteger(fightId) || fightId < 1) {
    throw new Error("Choose a numbered fight in FF Logs so the link contains ?fight=24");
  }

  url.hash = "";
  return { url: url.toString(), reportCode: match[1], fightId };
}

export function formatFightTimestamp(milliseconds: number): string {
  const value = Math.max(0, Math.round(milliseconds));
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  const millis = value % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
