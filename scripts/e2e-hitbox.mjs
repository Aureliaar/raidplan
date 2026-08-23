/**
 * A player's hitbox is a point, not the token art.
 *
 * The art is 72 units across, so a beam can overlap half a token and still miss
 * the player — the case you cannot judge by eye, and the one this pins down.
 *
 *   node scripts/e2e-hitbox.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
let bad = 0;
const fail = (m) => {
  console.error("FAIL:", m);
  bad++;
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=hitbox-e2e");
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
const ops = (id, list) => api("/api/plans/" + id + "/ops", { method: "POST", body: JSON.stringify({ ops: list }) });

const created = await api("/api/plans", { method: "POST", body: JSON.stringify({ name: "hitbox e2e" }) });
const id = (created.plan ?? created).id;

// A 160-wide beam pointing north from the centre: it spans x in [-80, 80].
// IN sits at x=70. OUT sits at x=110 — outside the beam, but its 72-wide art
// laps over the edge, so on screen the two look alike.
await ops(id, [
  { op: "add_entity", spec: { type: "player", name: "IN", job: "WAR", x: 70, y: -200 } },
  { op: "add_entity", spec: { type: "player", name: "OUT", job: "WHM", x: 110, y: -200 } },
  { op: "add_entity", spec: { type: "player", name: "EDGE", job: "BLM", x: 79, y: -300 } },
  { op: "add_entity", spec: { type: "zone", name: "Beam", shape: "rect", width: 160, length: 900, x: 0, y: -450, rotation: 0 } },
]);

const hits = await page.evaluate(
  async ([planId]) => {
    const doc = await (await fetch("/api/plans/" + planId)).json().then((p) => p.plan ?? p);
    const mod = await import("/src/shared/hits.ts");
    return mod.playersHit(doc, doc.steps[0].id, doc.entities.find((e) => e.name === "Beam").id).map((p) => p.name);
  },
  [id]
);
console.log("beam hits:", hits.join(", ") || "nobody");
if (!hits.includes("IN")) fail("a player inside the beam was not counted");
if (hits.includes("OUT")) fail("a player outside the beam was counted — art is being treated as a hitbox");
if (!hits.includes("EDGE")) fail("a player 1 unit inside the edge was not counted");

// The same claim, through the API a model reads.
const doc = await api("/api/plans/" + id).then((p) => p.plan ?? p);
const donutId = (
  await ops(id, [
    { op: "add_entity", spec: { type: "zone", name: "Donut", shape: "donut", innerRadius: 150, radius: 400, x: 0, y: 0 } },
  ])
).values[0].id;
const donutHits = await page.evaluate(
  async ([planId, zid]) => {
    const d = await (await fetch("/api/plans/" + planId)).json().then((p) => p.plan ?? p);
    const mod = await import("/src/shared/hits.ts");
    return mod.playersHit(d, d.steps[0].id, zid).map((p) => p.name);
  },
  [id, donutId]
);
// IN and OUT are ~212 units out: in the band. EDGE is ~310: also in the band.
console.log("donut hits:", donutHits.join(", ") || "nobody");
if (donutHits.length !== 3) fail("donut band should catch all three, got " + donutHits.join(", "));

// Move IN into the hole and it drops out, with no edit to the donut.
await ops(id, [{ op: "update_entity", id: doc.entities.find((e) => e.name === "IN").id, patch: { x: 0, y: -100 } }]);
const afterHits = await page.evaluate(
  async ([planId, zid]) => {
    const d = await (await fetch("/api/plans/" + planId)).json().then((p) => p.plan ?? p);
    const mod = await import("/src/shared/hits.ts");
    return mod.playersHit(d, d.steps[0].id, zid).map((p) => p.name);
  },
  [id, donutId]
);
if (afterHits.includes("IN")) fail("a player standing in the donut hole is still counted");
else console.log("donut hole drops IN as expected: " + afterHits.join(", "));

// And the canvas draws the point, so you can see which side of the edge you are on.
await page.goto(base + "/p/" + id);
await page.waitForSelector("canvas");
await page.waitForTimeout(800);
await page.screenshot({ path: process.argv[3] ?? "hitbox.png" });

console.log(bad ? "FAILED" : "OK - points, not art");
await browser.close();
