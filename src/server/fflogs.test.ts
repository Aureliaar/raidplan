import assert from "node:assert/strict";
import test from "node:test";
import { loadXivApiStatusRows } from "../shared/xivapi.ts";
import { exchangeFFLogsAuthorizationCode } from "./fflogs-oauth.ts";

test("resolves many status IDs by name with one bounded XIVAPI search", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return Response.json({
      results: [
        { row_id: 43, fields: { Name: "Known Debuff", Description: "Found by name.", Icon: { id: 1, path: "one.tex" } } },
        { row_id: 77, fields: { Name: "Synthetic Debuff", Description: "Also found by name.", Icon: { id: 2, path: "two.tex" } } },
      ],
    });
  };

  const rows = await loadXivApiStatusRows(
    [43, 999, 1000],
    new Map([[43, "Known Debuff"], [999, "Synthetic Debuff"], [1000, "Not In Game Data"]]),
    globalThis.fetch
  );

  assert.equal(rows.get(43)?.fields?.Description, "Found by name.");
  assert.equal(rows.get(999)?.fields?.Description, "Also found by name.");
  assert.equal(rows.has(1000), false);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).pathname, "/api/search");
});

test("exchanges an authorization code server-side with confidential client credentials", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let request: Request | null = null;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return Response.json({ access_token: "user-token", expires_in: 600 });
  };

  const result = await exchangeFFLogsAuthorizationCode(
    "authorization-code",
    "https://raidplan.example/fflogs",
    { FFLOGS_CLIENT_ID: "client", FFLOGS_CLIENT_SECRET: "secret" } as never
  );

  assert.deepEqual(result, { access_token: "user-token", expires_in: 600 });
  assert.equal(request!.headers.get("authorization"), `Basic ${btoa("client:secret")}`);
  assert.equal(await request!.text(), "redirect_uri=https%3A%2F%2Fraidplan.example%2Ffflogs&grant_type=authorization_code&code=authorization-code");
});
