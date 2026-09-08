/**
 * Bait anchors belong to Beats.
 *
 * An anchor is not a creature standing on the floor all fight: it is the place
 * a mechanic comes out of. So it is a Part like the shapes it throws — it
 * lives in the same Beat, is drawn for exactly that Beat's steps, and goes
 * when the Beat goes rather than being left behind as a reticle nobody owns.
 *
 *   npm run dev                        # in another terminal
 *   node scripts/e2e-anchors.mjs http://localhost:59577
 */
import { chromium } from "playwright";
import { viewScale } from "./view.mjs";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=anchor-e2e");
const api = (path, init = {}) =>
  page.evaluate(
    async ([p, i]) => {
      const r = await fetch(p, { ...i, headers: { "content-type": "application/json", ...(i.headers ?? {}) } });
      const t = await r.text();
      if (!r.ok) throw new Error(p + " -> " + r.status + " " + t.slice(0, 200));
      return t ? JSON.parse(t) : null;
    },
    [path, init]
  );

// A party and no enemy at all: every source on this floor is one we place.
const created = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "anchor e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);
const ops = (o) =>
  api("/api/plans/" + planId + "/ops", { method: "POST", body: JSON.stringify({ ops: [].concat(o) }) });

/** What the canvas would draw in a step, Beat timing and all. */
const drawn = (stepId) =>
  page.evaluate(
    async ([id, sid]) => {
      const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
      const mod = await import("/src/shared/schema.ts");
      return mod.entitiesForStep(d, sid).map((e) => ({ id: e.id, name: e.name, mech: e.mech }));
    },
    [planId, stepId]
  );

let doc = await load();
const cast = doc.steps[0].id;
await ops([
  { op: "update_step", stepId: cast, patch: { name: "Cast" } },
  { op: "duplicate_step", stepId: cast, name: "After" },
]);
doc = await load();
const after = doc.steps[1].id;

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

const canvas = page.locator("canvas").first();
const chip = (label) => page.locator("div", { hasText: new RegExp("^" + label + "$") }).last();
let box = await canvas.boundingBox();
let scale = viewScale(box.width);
const inCanvas = (x, y) => ({ x: box.width / 2 + x * scale, y: box.height / 2 + y * scale });
// A drop comes back selected and the inspector takes the palette's place, so
// every gesture starts by putting the selection down on bare floor. Each drop
// also grows the rail by a Beat lane: measure the floor again while we are here.
const clearSelection = async () => {
  box = await canvas.boundingBox();
  scale = viewScale(box.width);
  await page.mouse.click(box.x + 8, box.y + 8);
  await page.waitForTimeout(250);
};

/* --- an anchor arrives in a Beat of its own ------------------------------- */

await chip("Bait anchor").dragTo(canvas, { targetPosition: inCanvas(-200, -200) });
await page.waitForTimeout(600);
await clearSelection();

doc = await load();
const anchor = doc.entities.find((e) => e.type === "enemy" && e.role === "anchor");
if (!anchor) fail("dragging the bait anchor out placed nothing");
else if (!anchor.mech) fail("the anchor landed outside every Beat");
else if (!doc.mechs.some((m) => m.id === anchor.mech)) fail("the anchor names a Beat that does not exist");
else console.log("a dropped anchor lands in a Beat: " + anchor.mech);

/* --- and what is baited off it joins that same Beat ----------------------- */

await chip("Beam").dragTo(canvas, { targetPosition: inCanvas(anchor.x, anchor.y) });
await page.waitForTimeout(700);
await clearSelection();

doc = await load();
const beam = doc.entities.find((e) => e.type === "zone" && e.anchor);
if (!beam) fail("the beam dropped on the anchor was not added");
else if (beam.anchor.from !== anchor.id) fail("the beam fires from " + beam.anchor.from + ", not the anchor");
else if (beam.mech !== anchor.mech)
  fail("the beam is in Beat " + beam.mech + " while its source is in " + anchor.mech);
else if (doc.mechs.length !== 1)
  fail("a beam dropped on an anchor made a second Beat: " + doc.mechs.length + " in all");
else console.log("a beam dropped on the anchor joins its Beat, not a new one");

// Unnamed, the lane goes by what is in it — and a Beat is never called after
// the point it fires from while there is a mechanic in it to name it.
const lane = await page.evaluate(
  async ([id, mid]) => {
    const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
    const mod = await import("/src/shared/schema.ts");
    return mod.mechLabel(d, d.mechs.find((m) => m.id === mid));
  },
  [planId, anchor.mech]
);
if (/anchor/i.test(lane)) fail('the Beat lane is called "' + lane + '", after its anchor');
else console.log('the Beat is called after its mechanic, not its anchor: "' + lane + '"');

/* --- the Beat's span is the anchor's span --------------------------------- */

const idsIn = async (sid) => (await drawn(sid)).map((e) => e.id);
if ((await idsIn(after)).includes(anchor.id))
  fail("the anchor is still on the floor in After, past the Beat that owns it");
else console.log("past its Beat the anchor is off the floor, like everything else in it");

// Drag the bottom edge of the Beat box down to After: source and shape are one
// mechanic, so they arrive in the new step together.
const beatBox = page.locator(`[data-mech="${anchor.mech}"]`);
const rect = await beatBox.boundingBox();
const row = await page.getByRole("button", { name: /2\. After/ }).boundingBox();
// The resolve edge is the bottom strip of the card; the body would carry the
// whole Beat instead of stretching it.
await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height - 3);
await page.mouse.down();
await page.mouse.move(rect.x + rect.width / 2, row.y + row.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(800);

const later = await idsIn(after);
if (!later.includes(anchor.id) || !later.includes(beam.id))
  fail("stretching the Beat to After left " + (later.includes(anchor.id) ? "the beam" : "the anchor") + " behind");
else console.log("stretching the Beat carries the anchor with the beam it fires");

/* --- and deleting the Beat takes its anchor with it ----------------------- */

const remove = page.getByTitle("Delete this Beat and everything in it");
// Pressing a Beat toggles it, and the edge drag may have left this one open.
if (!(await remove.count())) {
  await beatBox.click();
  await page.waitForTimeout(400);
}
await remove.click();
await page.waitForTimeout(700);

doc = await load();
if (doc.entities.some((e) => e.id === anchor.id))
  fail("deleting the Beat left its anchor behind on the floor");
else if (doc.mechs.length) fail("the Beat itself survived being deleted");
else console.log("deleting the Beat takes the anchor with it: no orphan reticle");

/* --- an anchor nobody placed, made for a bait, lands in the Beat too ------ */

await clearSelection();
await chip("Protean").dragTo(chip("Party"));
await page.waitForTimeout(1000);

doc = await load();
const made = doc.entities.find((e) => e.type === "enemy" && e.role === "anchor");
const proteans = doc.entities.filter((e) => e.type === "zone" && e.anchor);
if (!made) fail("a bait on the party with no enemy anywhere placed no source");
else if (!proteans.length) fail("the protean on the party added nothing");
else if (!proteans.every((s) => s.mech === made.mech))
  fail("the source is in Beat " + made.mech + " and its baits in " + proteans[0].mech);
else if (doc.mechs.length !== 1) fail("that one drop made " + doc.mechs.length + " Beats");
else console.log("a source invented for a bait lands in the bait's Beat: " + made.mech);

/* --- and the same holds for the model's own anchor ------------------------ */

const { token } = await api("/api/tokens", { method: "POST", body: JSON.stringify({ label: "anchor-e2e" }) });
let session;
async function mcp(method, params, notify = false) {
  const body = { jsonrpc: "2.0", method, params };
  if (!notify) body.id = Math.floor(Math.random() * 1e6);
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer " + token,
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify(body),
  });
  session ??= res.headers.get("mcp-session-id") ?? undefined;
  if (notify) return;
  const text = await res.text();
  const line = text.split("\n").filter((l) => l.startsWith("data: ")).pop();
  if (!line) throw new Error(method + " -> " + res.status + " " + text.slice(0, 300));
  const msg = JSON.parse(line.slice(6));
  if (msg.error) throw new Error(method + ": " + msg.error.message);
  return msg.result;
}
const call = async (name, args) => {
  const r = await mcp("tools/call", { name, arguments: args });
  const text = r.content.map((c) => c.text).join("");
  if (r.isError) throw new Error(name + ": " + text);
  return text;
};
await mcp("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "e2e-anchors", version: "0" },
});
await mcp("notifications/initialized", undefined, true);

const before = (await load()).mechs.length;
await call("add_enemy", { plan_id: planId, name: "orb", anchor: true, x: 300, y: -300, step: "1" });
doc = await load();
const orb = doc.entities.find((e) => e.name === "orb");
if (!orb) fail("add_enemy with anchor added nothing");
else if (orb.role !== "anchor") fail("add_enemy made a creature, not an anchor: " + JSON.stringify(orb.role));
else if (!orb.mech || !doc.mechs.some((m) => m.id === orb.mech))
  fail("the model's anchor landed outside every Beat");
else if (doc.mechs.length !== before + 1) fail("add_enemy made " + (doc.mechs.length - before) + " Beats");
else console.log("add_enemy anchor:true puts one in a Beat of its own: " + orb.mech);

// A boss is still the cast: plan-wide, in no Beat at all.
await call("add_enemy", { plan_id: planId, name: "the boss", size: 140, step: "1" });
doc = await load();
const boss = doc.entities.find((e) => e.name === "the boss");
if (!boss) fail("add_enemy added no boss");
else if (boss.role === "anchor" || boss.mech) fail("a boss joined a Beat: " + boss.mech);
else console.log("a boss is still plan-wide, in no Beat");

/* --- a plan written before all this still opens with its anchors owned ---- */

// Exactly the shape an older document has: an anchor sitting outside every
// Beat, with the beam it fires living inside one.
const legacy = (await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "legacy anchor e2e", withParty: true }),
}).then((c) => c.plan ?? c)).id;
const legacyOps = (o) =>
  api("/api/plans/" + legacy + "/ops", { method: "POST", body: JSON.stringify({ ops: [].concat(o) }) });
const oldDoc = await api("/api/plans/" + legacy).then((p) => p.plan ?? p);
const oldStep = oldDoc.steps[0].id;
const oldAnchor = (await legacyOps({
  op: "add_entity",
  spec: { type: "enemy", role: "anchor", name: "orb", x: 0, y: -300, size: 60 },
})).values[0].id;
const oldBeat = (await legacyOps({ op: "add_mech", name: "Orb beam", snap: oldStep, plain: true })).values[0].id;
await legacyOps({
  op: "add_entity",
  spec: {
    type: "zone",
    shape: "rect",
    name: "Beam",
    width: 160,
    mech: oldBeat,
    declaredIn: oldStep,
    anchor: { pick: "closest", from: oldAnchor, extend: true },
  },
});

await page.goto(base + "/p/" + legacy);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);
const adopted = await page.evaluate(
  async ([id, aid]) => {
    const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
    const mod = await import("/src/shared/schema.ts");
    return mod.hydratePlan(d).entities.find((e) => e.id === aid).mech ?? null;
  },
  [legacy, oldAnchor]
);
if (adopted !== oldBeat)
  fail("opening an older plan left its anchor in " + adopted + " instead of " + oldBeat);
else console.log("an older plan's loose anchor is adopted by the Beat it fires: " + adopted);

if (errors.length) fail("page errors: " + errors.join(" | "));
console.log(process.exitCode ? "FAILED" : "OK - anchors live in the Beat they fire");
await browser.close();
