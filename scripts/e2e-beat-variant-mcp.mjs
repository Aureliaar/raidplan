/** Beat Variant MCP parity: authoring, COW domains, conflicts, Routes and conversion. */
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:5173").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
let failures = 0;
const check = (condition, label, detail = "") => {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"} ${label.padEnd(50)} ${detail}`);
};

await page.goto(`${base}/auth/dev?name=beat-variant-mcp`);
const api = (path, init = {}) => page.evaluate(async ([url, options]) => {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}, [path, init]);
const token = (await api("/api/tokens", {
  method: "POST",
  body: JSON.stringify({ label: "beat-variant-mcp-e2e" }),
})).body.token;

let session;
async function rpc(method, params, notify = false) {
  const body = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  if (!notify) body.id = Math.floor(Math.random() * 1e6);
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify(body),
  });
  session ??= response.headers.get("mcp-session-id") ?? undefined;
  if (notify) return;
  const text = await response.text();
  const line = text.split("\n").filter((candidate) => candidate.startsWith("data: ")).at(-1);
  if (!line) throw new Error(`${method}: HTTP ${response.status} ${text.slice(0, 400)}`);
  const message = JSON.parse(line.slice(6));
  if (message.error) throw new Error(`${method}: ${message.error.message}`);
  return message.result;
}
async function tool(name, args, allowError = false) {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = result.content?.map((part) => part.text ?? "").join("") ?? "";
  if (result.isError && !allowError) throw new Error(`${name}: ${text}`);
  return { text, isError: !!result.isError };
}

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "beat-variant-mcp-e2e", version: "1" },
});
await rpc("notifications/initialized", undefined, true);
const listed = await rpc("tools/list");
const names = new Set(listed.tools.map((entry) => entry.name));
for (const name of [
  "list_beats",
  "add_beat_variant",
  "duplicate_beat_variant",
  "collapse_beat_variants",
  "reset_beat_variant_step",
  "save_beat_variant_route",
  "inspect_legacy_variant_conversion",
  "convert_legacy_variants_to_copy",
]) check(names.has(name), `MCP advertises ${name}`);

const createdText = (await tool("create_plan", { name: "MCP Beat Variants", with_party: true })).text;
const planId = createdText.match(/plan_[A-Za-z0-9_-]+/)?.[0];
check(!!planId, "MCP created plan returns an id", createdText);
const load = async (id = planId) => (await api(`/api/plans/${id}`)).body.plan;
let plan = await load();
check(plan.variantModel === "beat", "MCP new plans default to Beat model");
const step = plan.steps[0];
const mt = plan.entities.find((entity) => entity.name === "MT");

const beatOneText = (await tool("add_mech", {
  plan_id: planId,
  name: "Explosion",
  snapshot_in: step.id,
  goes_off_in: step.id,
})).text;
const beatOne = beatOneText.match(/mech_[A-Za-z0-9_-]+/)?.[0];
await tool("add_beat_variant", { plan_id: planId, beat: beatOne });
plan = await load();
const [oneA, oneB] = plan.mechs.find((beat) => beat.id === beatOne).variants.map((variant) => variant.id);
await api(`/api/plans/${planId}/ops`, {
  method: "POST",
  body: JSON.stringify({ ops: { op: "add_entity", spec: { id: "mcp_shared_part", type: "zone", shape: "circle", mech: beatOne, x: 10, y: 20 } } }),
});

await tool("move_entity", {
  plan_id: planId,
  entity: mt.id,
  step: step.id,
  beat: beatOne,
  variant: oneA,
  x: 321,
  y: 123,
});
plan = await load();
check(!!plan.steps[0].beatVariantMovement?.[oneA]?.[mt.id], "MCP actor move writes sparse Beat movement");
check(!plan.steps[0].beatVariantContent?.[oneA], "MCP actor move does not detach Beat content");

await tool("update_entity", {
  plan_id: planId,
  entity: "mcp_shared_part",
  step: step.id,
  beat: beatOne,
  variant: oneA,
  patch: { x: 444 },
});
plan = await load();
check(plan.steps[0].beatVariantContent[oneA].parts.length === 1, "MCP Part edit snapshots only owning Beat");
check(plan.steps[0].beatVariantMovement[oneA][mt.id].x === 321, "MCP Part edit preserves movement domain");

const beatTwoText = (await tool("add_mech", {
  plan_id: planId,
  name: "Orbs",
  snapshot_in: step.id,
  goes_off_in: step.id,
})).text;
const beatTwo = beatTwoText.match(/mech_[A-Za-z0-9_-]+/)?.[0];
await tool("add_beat_variant", { plan_id: planId, beat: beatTwo });
plan = await load();
const [twoA] = plan.mechs.find((beat) => beat.id === beatTwo).variants.map((variant) => variant.id);
const ambiguous = await tool("move_entity", {
  plan_id: planId,
  entity: mt.id,
  step: step.id,
  variant: oneB,
  x: 10,
  y: 10,
}, true);
check(ambiguous.isError && /More than one varying Beat/.test(ambiguous.text), "MCP refuses ambiguous Beat edit destination");

await tool("move_entity", {
  plan_id: planId,
  entity: mt.id,
  step: step.id,
  beat: beatTwo,
  variant: twoA,
  x: -321,
  y: -123,
});
const conflictingRoute = await tool("save_beat_variant_route", {
  plan_id: planId,
  name: "Unsafe",
  selections: { [beatOne]: oneA, [beatTwo]: twoA },
}, true);
check(conflictingRoute.isError && /Movement conflict/.test(conflictingRoute.text), "MCP cannot save conflicting Route");

await tool("reset_beat_variant_step", {
  plan_id: planId,
  beat: beatTwo,
  variant: twoA,
  step: step.id,
  domain: "movement",
});
const saved = await tool("save_beat_variant_route", {
  plan_id: planId,
  name: "Safe",
  selections: { [beatOne]: oneA, [beatTwo]: twoA },
  make_default: true,
});
check(/document default/.test(saved.text), "MCP saves a conflict-free document default Route");
plan = await load();
check(plan.defaultVariantRoute === plan.variantRoutes[0].id, "MCP Route persists in document");
const read = await tool("read_plan", {
  plan_id: planId,
  step: step.id,
  beat: beatOne,
  variant: oneA,
});
check(read.text.includes("321") || read.text.includes("444"), "MCP read resolves selected Beat Variant");

const legacyMade = (await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "MCP conversion source", withParty: false }),
})).body.id;
const fixture = JSON.parse(await readFile(new URL("./fixtures/dark-light-legacy-rev3018.json", import.meta.url), "utf8"));
await api(`/api/plans/${legacyMade}/import`, {
  method: "POST",
  body: JSON.stringify({ plan: fixture }),
});
const inspection = JSON.parse((await tool("inspect_legacy_variant_conversion", { plan_id: legacyMade })).text);
check(inspection.report.convertible && inspection.report.mismatches.length === 0, "MCP dry-run reports frozen fixture equivalent");
const converted = await tool("convert_legacy_variants_to_copy", {
  plan_id: legacyMade,
  expected_rev: inspection.report.sourceRev,
  expected_checksum: inspection.checksum,
});
const convertedId = converted.text.match(/plan_[A-Za-z0-9_-]+/)?.[0];
check(converted.text.includes("source unchanged") && !!convertedId, "MCP converts legacy plan to a fresh copy");
check((await load(convertedId)).variantModel === "beat", "MCP converted copy uses Beat model");

await browser.close();
if (failures) {
  console.error(`\n${failures} MCP check(s) failed`);
  process.exit(1);
}
console.log("\nBeat Variant MCP checks passed.");
