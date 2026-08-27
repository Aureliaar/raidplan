const XIVAPI_SEARCH_URL = "https://v2.xivapi.com/api/search";

export type XivApiStatusRow = {
  row_id: number;
  fields?: {
    Name?: string;
    Description?: string;
    Icon?: { id?: number; path?: string; path_hr1?: string };
  };
};

async function statusJson<T>(response: Response, service: string): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${service} returned an unreadable response (${response.status})`);
  }
  if (!response.ok) throw new Error(`${service} request failed (${response.status})`);
  return body as T;
}

async function searchStatuses(names: string[], fetcher: typeof fetch): Promise<XivApiStatusRow[]> {
  const params = new URLSearchParams({
    sheets: "Status",
    fields: "Name,Description,Icon",
    // Whitespace-separated clauses are ORs in XIVAPI's search language.
    query: names.map((name) => `Name=${JSON.stringify(name)}`).join(" "),
    limit: "100",
    language: "en",
  });
  const response = await fetcher(`${XIVAPI_SEARCH_URL}?${params}`);
  const body = await statusJson<{ results?: XivApiStatusRow[] }>(response, "XIVAPI status search");
  return body.results ?? [];
}

export async function loadXivApiStatusRows(
  ids: number[],
  names = new Map<number, string>(),
  fetcher: typeof fetch = fetch
): Promise<Map<number, XivApiStatusRow>> {
  const rows = new Map<number, XivApiStatusRow>();
  const idsByName = new Map<string, number[]>();
  for (const id of ids) {
    const name = names.get(id);
    if (!name) continue;
    const key = name.trim().toLowerCase();
    idsByName.set(key, [...(idsByName.get(key) ?? []), id]);
  }
  const uniqueNames = [...idsByName.keys()];
  // At most one call per 40 names. An absent result no longer fails the batch.
  for (let offset = 0; offset < uniqueNames.length; offset += 40) {
    const keys = uniqueNames.slice(offset, offset + 40);
    const requestedNames = keys.map((key) => names.get(idsByName.get(key)![0])!);
    for (const row of await searchStatuses(requestedNames, fetcher)) {
      const key = row.fields?.Name?.trim().toLowerCase();
      if (!key) continue;
      for (const id of idsByName.get(key) ?? []) rows.set(id, row);
    }
  }
  return rows;
}
