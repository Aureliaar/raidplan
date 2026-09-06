/**
 * Baited primitives, end to end: create a plan over the REST API, add baits with
 * the real `add_bait` MCP tool, then drag the baited player in the browser and
 * check the AoEs followed them on the canvas — including in a second step.
 *
 *   npm run dev                        # in another terminal
 *   node scripts/e2e-bait.mjs http://localhost:59577
 *
 * Needs DEV_AUTH=true (local sign-in) — same as the other e2e scripts.
 */
import { chromium } from "playwright";
import { viewScale } from "./view.mjs";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=bait-e2e");

const api = (path, init = {}) =>
  page.evaluate(
    async ([p, i]) => {
      const r = await fetch(p, {
        ...i,
        headers: { "content-type": "application/json", ...(i.headers ?? {}) },
      });
      const text = await r.text();
      if (!r.ok) throw new Error(p + " -> " + r.status + " " + text.slice(0, 300));
      return text ? JSON.parse(text) : null;
    },
    [path, init]
  );

const ops = (planId, list) =>
  api("/api/plans/" + planId + "/ops", { method: "POST", body: JSON.stringify({ ops: list }) });

const { token } = await api("/api/tokens", {
  method: "POST",
  body: JSON.stringify({ label: "bait-e2e" }),
});
const created = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "bait e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
await ops(planId, [{ op: "add_entity", spec: { type: "enemy", name: "boss", x: 0, y: 0, size: 140 } }]);

/* --- MCP: the streamable-HTTP handshake a model client does ---------------- */
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
  clientInfo: { name: "e2e-bait", version: "0" },
});
await mcp("notifications/initialized", undefined, true);

console.log(await call("add_bait", { plan_id: planId, kind: "beam", on: "MT, M1", from: "boss", name: "Beam" }));
console.log(await call("add_bait", { plan_id: planId, kind: "donut", on: "H1", name: "Donut" }));
console.log(await call("add_bait", { plan_id: planId, kind: "tether", on: "M1", from: "boss" }));
console.log(await call("add_bait", { plan_id: planId, kind: "puddle", on: "R1", name: "Desolation" }));

const described = await call("read_plan", { plan_id: planId });
if (!/"Beam MT" aimed from boss at MT, to the wall/.test(described)) fail("read_plan does not describe the beam:\n" + described);
if (!/"Donut H1" on H1/.test(described)) fail("read_plan does not describe the donut:\n" + described);

/* --- the point of it: move the bait on the canvas, the AoE follows --------- */
await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(800);

const pose = (name, stepIndex = 0) =>
  page.evaluate(
    async ([id, n, si]) => {
      const doc = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
      const mod = await import("/src/shared/schema.ts");
      const e = mod.entitiesForStep(doc, doc.steps[si].id).find((x) => x.name === n);
      if (!e) return null;
      return {
        x: Math.round(e.x),
        y: Math.round(e.y),
        rotation: Math.round(e.rotation),
        length: Math.round(e.length ?? 0),
      };
    },
    [planId, name, stepIndex]
  );

const bearing = (x, y) => (Math.atan2(x, -y) * 180) / Math.PI;
const off = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

const beamBefore = await pose("Beam MT");
const donutBefore = await pose("Donut H1");
if (!beamBefore) fail("no beam entity resolved");

const box = await page.locator("canvas").first().boundingBox();
const doc = await api("/api/plans/" + planId).then((p) => p.plan ?? p);
const mt = doc.entities.find((e) => e.name === "MT");
const scale = viewScale(box.width, doc.arena.width);
const screen = (x, y) => ({
  x: box.x + box.width / 2 + x * scale,
  y: box.y + box.height / 2 + y * scale,
});
const target = { x: -380, y: 300 };
const from = screen(mt.x, mt.y);
const to = screen(target.x, target.y);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 20 });
await page.mouse.up();
await page.waitForTimeout(700);

// A canvas drag lands as a per-step override, so read the resolved pose.
const moved = await pose("MT");
if (Math.hypot(moved.x - target.x, moved.y - target.y) > 30)
  fail("the drag did not move MT: it is at " + moved.x + "," + moved.y);

const beamAfter = await pose("Beam MT");
if (!beamAfter) fail("beam vanished after the drag");
else {
  const want = bearing(moved.x, moved.y);
  if (off(beamAfter.rotation, want) > 6)
    fail("beam did not swing with MT: " + beamAfter.rotation + "deg, expected ~" + Math.round(want));
  if (beamAfter.rotation === beamBefore.rotation) fail("beam rotation never changed");
  if (beamAfter.length < 400) fail("beam did not extend to the wall: length " + beamAfter.length);
  else console.log("beam " + beamBefore.rotation + "deg -> " + beamAfter.rotation + "deg (want ~" + Math.round(want) + "), length " + beamAfter.length);
}

const donutAfter = await pose("Donut H1");
if (donutAfter.x !== donutBefore.x || donutAfter.y !== donutBefore.y)
  fail("the donut on H1 moved when MT did");

/* --- a bait is draggable: the drop becomes an offset from its anchor ------- */
const h1 = await pose("H1");
const donutStart = await pose("Donut H1");
// Grab the donut on its annulus at a point nothing else covers: the canvas
// picks the smallest thing under the pointer, so over a player you get the
// player, 300 east of H1 sits inside the boss's grab disc, R1's puddle owns
// the north-west quadrant, and the MT beam sweeps the south-west corridor.
const grab = screen(donutStart.x - 110, donutStart.y - 140);
const drop = screen(donutStart.x - 110, donutStart.y + 20);
await page.mouse.move(grab.x, grab.y);
await page.mouse.down();
await page.mouse.move(drop.x, drop.y, { steps: 20 });
await page.mouse.up();
await page.waitForTimeout(700);

const donutMoved = await pose("Donut H1");
if (Math.abs(donutMoved.y - (donutStart.y + 160)) > 25 || Math.abs(donutMoved.x - donutStart.x) > 25)
  fail("dragging the donut did not move it: " + donutMoved.x + "," + donutMoved.y);
else console.log("dragged the donut to " + donutMoved.x + "," + donutMoved.y);

const stillBound = await api("/api/plans/" + planId)
  .then((p) => p.plan ?? p)
  .then((d) => d.entities.find((e) => e.name === "Donut H1"));
if (!stillBound.anchor) fail("dragging the donut unbound it from H1");

// H1 walks away; the donut must go with them, offset and all.
await ops(planId, [{ op: "update_entity", id: stillBound.anchor.to, patch: { x: -300, y: -200 } }]);
const donutFollowed = await pose("Donut H1");
const h1Now = await pose("H1");
if (Math.abs(h1Now.x - -300) > 3) fail("test setup: H1 did not move");
const keptX = donutFollowed.x - h1Now.x;
const keptY = donutFollowed.y - h1Now.y;
const wantX = donutMoved.x - h1.x;
const wantY = donutMoved.y - h1.y;
if (Math.abs(keptX - wantX) > 3 || Math.abs(keptY - wantY) > 3)
  fail("the donut lost its offset when H1 moved: kept " + keptX + "," + keptY + ", want " + wantX + "," + wantY);
else console.log("the dragged offset survived H1 moving: " + Math.round(keptX) + "," + Math.round(keptY));

/* --- autobaits: the target is a rule, not a name --------------------------- */
console.log(await call("add_bait", { plan_id: planId, kind: "beam", pick: "closest", count: 2, from: "boss", name: "Auto" }));

const step1 = doc.steps[0].id;
const idOfName = (name) => doc.entities.find((e) => e.name === name).id;
// Distinct distances and distinct directions, so "closest" has one answer and
// the beam's facing says which player it picked.
await ops(planId, [
  { op: "update_entity", id: idOfName("M2"), patch: { x: 60, y: 0 }, stepId: step1 },
  { op: "update_entity", id: idOfName("R2"), patch: { x: 0, y: -90 }, stepId: step1 },
]);

const auto1 = await pose("Auto 1");
const auto2 = await pose("Auto 2");
if (off(auto1.rotation, bearing(60, 0)) > 6)
  fail("autobait 1 is not on the closest player (M2 at 90deg): it is at " + auto1.rotation + "deg");
if (off(auto2.rotation, bearing(0, -90)) > 6)
  fail("autobait 2 is not on the second closest (R2 at 0deg): it is at " + auto2.rotation + "deg");
console.log("autobaits picked the two closest with nobody named: " + auto1.rotation + "deg, " + auto2.rotation + "deg");

// Walk somebody else in closer: the bait must switch to them by itself.
await ops(planId, [{ op: "update_entity", id: idOfName("R1"), patch: { x: -20, y: 0 }, stepId: step1 }]);
const switched = await pose("Auto 1");
if (off(switched.rotation, bearing(-20, 0)) > 6)
  fail("autobait did not re-target to R1 (270deg): it is at " + switched.rotation + "deg");
else console.log("autobait re-targeted itself to the new closest player: " + switched.rotation + "deg");
const bumped = await pose("Auto 2");
if (off(bumped.rotation, bearing(60, 0)) > 6)
  fail("autobait 2 did not slide to the now-second-closest M2: " + bumped.rotation + "deg");

// The palette makes one of these: an anchor onto the floor, a beam onto it.
await page.reload();
await page.waitForSelector("canvas");
await page.waitForTimeout(700);
const beforeAdd = (await api("/api/plans/" + planId).then((p) => p.plan ?? p)).entities.length;
const canvas = page.locator("canvas").first();
const chip = (label) => page.locator("div", { hasText: new RegExp("^" + label + "$") }).last();
const cbox = await canvas.boundingBox();
// Arena units, not pixels: the floor is whatever the rail leaves it.
const spot = { x: cbox.width / 2 + 220 * (viewScale(cbox.width)), y: cbox.height / 2 - 220 * (viewScale(cbox.width)) };
await chip("Bait anchor").dragTo(canvas, { targetPosition: spot });
await page.waitForTimeout(500);
// The dropped anchor comes back selected, and the inspector replaces the
// palette while anything is selected. Click empty floor (the SE corner is
// clear of every bait and token this plan has) to bring the palette back.
await page.mouse.click(cbox.x + cbox.width / 2 + 420 * (viewScale(cbox.width)), cbox.y + cbox.height / 2 + 300 * (viewScale(cbox.width)));
await page.waitForTimeout(300);
await chip("Beam").dragTo(canvas, { targetPosition: spot });
await page.waitForTimeout(600);
const afterDoc = await api("/api/plans/" + planId).then((p) => p.plan ?? p);
const added = afterDoc.entities[afterDoc.entities.length - 1];
if (afterDoc.entities.length !== beforeAdd + 2 || added.anchor?.pick !== "closest")
  fail("dropping a beam on an anchor did not make an autobait: " + JSON.stringify(added.anchor));
else console.log("dragged out a bait -> " + added.name + " " + JSON.stringify(added.anchor));
if (!(await page.locator("text=bait target").count())) fail("no bait target editor for the new bait");
if (!(await page.locator("text=right now:").count())) fail("the bait editor does not say who it hits now");

/* --- and it holds per step, with no override bookkeeping ------------------- */
await ops(planId, [{ op: "add_step", name: "two" }]);
const doc2 = await api("/api/plans/" + planId).then((p) => p.plan ?? p);
const step2 = doc2.steps[1].id;
const mtId = doc2.entities.find((e) => e.name === "MT").id;
await ops(planId, [{ op: "update_entity", id: mtId, patch: { x: 400, y: -100 }, stepId: step2 }]);
// The beam lives in the Beat its add made, which spans step 1 only: stretch
// that Beat into step 2 so the bait is on the floor there to follow MT.
await ops(planId, [
  { op: "update_mech", mechId: doc2.entities.find((e) => e.name === "Beam MT").mech, patch: { boom: step2 } },
]);

// A Beat aims its Parts at its snapshot: MT walking off in step 2 does not
// swing a beam that already took its picture in step 1.
const step2Beam = await pose("Beam MT", 1);
const snapshot = bearing(moved.x, moved.y);
if (off(step2Beam.rotation, snapshot) > 6)
  fail("step 2 beam is at " + step2Beam.rotation + "deg, expected the snapshot ~" + Math.round(snapshot));
else console.log("step 2 beam holds the snapshot aim while MT walks away: " + step2Beam.rotation + "deg");

const step1Beam = await pose("Beam MT", 0);
if (off(step1Beam.rotation, bearing(moved.x, moved.y)) > 6)
  fail("step 1 beam changed when step 2 moved MT");

if (errors.length) fail("page errors: " + errors.slice(0, 3).join(" | "));
console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
await browser.close();
