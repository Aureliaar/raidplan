/**
 * The light parties are things you move, not eight people you move one at a
 * time. "G1 goes north" is one drag: carry the G1 card onto the floor and the
 * four of them stack tightly there — and it is a move in this step,
 * in this reading, exactly as dragging one of them by hand would be.
 *
 *   node scripts/e2e-groups.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=groups-e2e");
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

const created = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "groups e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);
const ops = (o) =>
  api("/api/plans/" + planId + "/ops", { method: "POST", body: JSON.stringify({ ops: [].concat(o) }) });

await ops({ op: "add_step", name: "Two" });
await page.goto(base + "/p/" + planId);
await page.waitForTimeout(1800);

/** Where everyone is drawn in the step on screen, by name. */
const where = async (stepId) =>
  page.evaluate(
    async ([id, sid]) => {
      const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
      const mod = await import("/src/shared/schema.ts");
      return Object.fromEntries(
        mod
          .entitiesForStep(d, sid)
          .filter((e) => e.type === "player")
          .map((e) => [e.name, { x: Math.round(e.x), y: Math.round(e.y) }])
      );
    },
    [planId, stepId]
  );

const doc = await load();
const [one, two] = doc.steps.map((s) => s.id);
const before = await where(one);

/* --- the card names the four of them --------------------------------------- */

const card = page.locator("div").filter({ hasText: /^G1\d+ players$/ }).last();
const g1Text = await card.innerText();
if (!/4 players/.test(g1Text)) fail("the G1 card counts " + g1Text.replace(/\n/g, " "));
else console.log("G1 is four people: " + g1Text.replace(/\n/g, " "));

/* --- and carrying it onto the floor moves all four -------------------------- */

const stage = page.locator("canvas").first();
const box = await stage.boundingBox();
// North-west of centre, well clear of where the party starts.
const to = { x: box.x + box.width * 0.28, y: box.y + box.height * 0.24 };
await card.dragTo(stage, { targetPosition: { x: box.width * 0.28, y: box.height * 0.24 } });
await page.waitForTimeout(1200);

const after = await where(one);
const G1 = ["MT", "H1", "M1", "R1"];
const G2 = ["OT", "H2", "M2", "R2"];
const moved = G1.map((n) => ({ x: after[n].x - before[n].x, y: after[n].y - before[n].y }));
const diameter = (names, poses) =>
  Math.max(...names.flatMap((a) => names.map((b) => Math.hypot(poses[a].x - poses[b].x, poses[a].y - poses[b].y))));

if (!moved.some((d) => Math.hypot(d.x, d.y) > 50)) fail("dragging the G1 card moved nobody");
else if (diameter(G1, after) > 41)
  fail("G1 did not stack tightly: " + JSON.stringify(G1.map((n) => after[n])));
else console.log("all four of G1 are stacked within " + Math.round(diameter(G1, after)) + " arena units");

if (G2.some((n) => after[n].x !== before[n].x || after[n].y !== before[n].y))
  fail("moving G1 also moved G2");
else console.log("and G2 stayed exactly where it was");

/* --- it is one declaration, and the steps after it follow ------------------- */

const stepTwo = await where(two);
if (!G1.every((n) => stepTwo[n].x === after[n].x && stepTwo[n].y === after[n].y))
  fail("step 2 did not follow the group: " + JSON.stringify(G1.map((n) => [stepTwo[n], after[n]])));
else console.log("step 2 says nothing about them, so the group is still where step 1 put it");

const settled = await load();
const alsoWritten = settled.entities.filter((e) => G1.includes(e.name) && e.overrides?.[two]);
if (alsoWritten.length)
  fail("moving G1 in step 1 also wrote step 2: " + alsoWritten.map((e) => e.name).join());
else console.log("and step 2 was not written to in order to make that happen");

/* --- and G2 answers to its own card ---------------------------------------- */

const card2 = page.locator("div").filter({ hasText: /^G2\d+ players$/ }).last();
await card2.dragTo(stage, { targetPosition: { x: box.width * 0.74, y: box.height * 0.76 } });
await page.waitForTimeout(1200);
const last = await where(one);
const shifted = G2.map((n) => ({ x: last[n].x - after[n].x, y: last[n].y - after[n].y }));
if (!shifted.some((d) => Math.hypot(d.x, d.y) > 50)) fail("dragging the G2 card moved nobody");
else if (diameter(G2, last) > 41)
  fail("G2 did not stack tightly: " + JSON.stringify(G2.map((n) => last[n])));
else if (G1.some((n) => last[n].x !== after[n].x || last[n].y !== after[n].y))
  fail("moving G2 dragged G1 along with it");
else console.log("G2 goes its own way and stacks within " + Math.round(diameter(G2, last)) + " arena units");

/* --- healer group drags make an even tighter pair ------------------------- */

const healers = page.locator("div").filter({ hasText: /^Healers\d+ players$/ }).last();
await healers.dragTo(stage, { targetPosition: { x: box.width * 0.5, y: box.height * 0.5 } });
await page.waitForTimeout(1200);
const healed = await where(one);
if (diameter(["H1", "H2"], healed) > 29)
  fail("the healers did not stack tightly: " + JSON.stringify([healed.H1, healed.H2]));
else console.log("the healers stack within " + Math.round(diameter(["H1", "H2"], healed)) + " arena units");

/* --- and clicking a card selects those people ------------------------------ */

// Clicking is the other half of the card: it hands you the same people the
// drag would carry, so the next thing you do lands on all of them at once.
await healers.click();
await page.waitForTimeout(400);
await page.keyboard.press("Delete");
await page.waitForTimeout(900);

const afterDelete = await where(one);
if (afterDelete.H1 || afterDelete.H2)
  fail("clicking Healers then Delete left " + Object.keys(afterDelete).join());
else if (Object.keys(afterDelete).length !== Object.keys(healed).length - 2)
  fail("the Healers click took people who are not healers: " + Object.keys(afterDelete).join());
else console.log("clicking Healers selected exactly H1 and H2");

await page.keyboard.press("Control+z");
await page.waitForTimeout(900);
const restored = await where(one);
if (!restored.H1 || !restored.H2) fail("undo did not bring the healers back");
else console.log("and undo brings them back");

await browser.close();
console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
