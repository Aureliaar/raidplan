/**
 * Bait sources that are not the boss.
 *
 * A mechanic comes out of whatever spawned it — an add, an orb, a portal — so a
 * bait's source is any entity you can place and drag, and a plan with no enemy
 * at all still gets one rather than a dead button.
 *
 *   node scripts/e2e-source.mjs http://localhost:59577
 */
import { chromium } from "playwright";
import { viewScale } from "./view.mjs";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=source-e2e");
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

// A party and no enemy whatsoever: there is nothing here that could be a boss.
const created = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "source e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

const canvas = page.locator("canvas").first();
const chip = (label) => page.locator("div", { hasText: new RegExp("^" + label + "$") }).last();
let box = await canvas.boundingBox();
let scale = viewScale(box.width);
const inCanvas = (x, y) => ({ x: box.width / 2 + x * scale, y: box.height / 2 + y * scale });
const screen = (x, y) => ({ x: box.x + box.width / 2 + x * scale, y: box.y + box.height / 2 + y * scale });

// Two objects on the floor, neither of them a boss — this plan has no enemy.
// A drop comes back selected, and the inspector replaces the palette while
// anything is selected: click bare floor in the NW corner to get it back.
const clearSelection = async () => {
  // Every drop grows the rail by a Beat lane, so measure the floor afresh.
  box = await canvas.boundingBox();
  scale = viewScale(box.width);
  await page.mouse.click(box.x + 8, box.y + 8);
  await page.waitForTimeout(200);
};
await chip("Bait anchor").dragTo(canvas, { targetPosition: inCanvas(-260, -260) });
await page.waitForTimeout(500);
await clearSelection();
await chip("Bait anchor").dragTo(canvas, { targetPosition: inCanvas(260, -60) });
await page.waitForTimeout(500);
await clearSelection();

let doc = await load();
const first = doc.entities.find((e) => e.name === "anchor 1");
const second = doc.entities.find((e) => e.name === "anchor 2");
if (!first || !second) fail("dragging the bait anchor out twice did not place two");
else if (Math.hypot(second.x - first.x, second.y - first.y) < 60)
  fail("the second anchor landed on top of the first");
else console.log("two anchors placed, no boss anywhere: " + first.name + ", " + second.name);

// A beam dropped on the second one comes out of *that* one.
await chip("Beam").dragTo(canvas, { targetPosition: inCanvas(second.x, second.y) });
await page.waitForTimeout(600);
await clearSelection();
doc = await load();
const newest = doc.entities.filter((e) => e.anchor).at(-1);
if (!newest || newest.anchor.from !== second.id)
  fail("the beam fires from " + (newest && newest.anchor.from) + " instead of the anchor it was dropped on");
else console.log("a beam dropped on an anchor fires from it: " + newest.name);

// Every drop grew the rail by a Beat lane, so the floor is smaller than it
// was measured: take its measure again before aiming at anything on it.
box = await canvas.boundingBox();
scale = viewScale(box.width);
const at = screen(second.x, second.y);

// Drag the source: the beam it fires must swing from the new origin, live.
const node = (id) =>
  page.evaluate((eid) => {
    const n = window.Konva.stages[0].findOne("#" + eid);
    return n ? { x: Math.round(n.x()), y: Math.round(n.y()), rotation: Math.round(n.rotation()) } : null;
  }, id);

const before = await node(newest.id);
const dropAt = { x: -300, y: 320 };
const to = screen(dropAt.x, dropAt.y);
await page.mouse.move(at.x, at.y);
await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 20 });
await page.waitForTimeout(200);

const mid = await node(newest.id);
if (mid.rotation === before.rotation) fail("the beam did not re-aim while its source was being dragged");
await page.mouse.up();
await page.waitForTimeout(700);

doc = await load();
const moved = doc.entities.find((e) => e.id === second.id);
const pose = moved.overrides?.[doc.steps[0].id] ?? moved;
if (Math.hypot(pose.x - dropAt.x, pose.y - dropAt.y) > 25) fail("the source drag did not commit");

// The beam now starts at the source's new spot and points at the closest player.
const solved = await page.evaluate(
  async ([id, zid]) => {
    const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
    const mod = await import("/src/shared/schema.ts");
    const drawn = mod.entitiesForStep(d, d.steps[0].id);
    const beam = drawn.find((e) => e.id === zid);
    const src = drawn.find((e) => e.id === d.entities.find((x) => x.name === "anchor 2").id);
    const nearest = drawn
      .filter((e) => e.type === "player")
      .map((e) => ({ name: e.name, d: Math.hypot(e.x - src.x, e.y - src.y), x: e.x, y: e.y }))
      .sort((a, b) => a.d - b.d)[0];
    return { rotation: beam.rotation, src: { x: src.x, y: src.y }, nearest };
  },
  [planId, newest.id]
);
const want = (Math.atan2(solved.nearest.x - solved.src.x, -(solved.nearest.y - solved.src.y)) * 180) / Math.PI;
if (Math.abs(((solved.rotation - want + 540) % 360) - 180) > 6)
  fail("the beam is at " + solved.rotation + "deg, expected ~" + Math.round(want) + " (closest to the moved source)");
else console.log("after the drop the beam fires from the source at " + solved.nearest.name + ": " + Math.round(solved.rotation) + "deg");

console.log(process.exitCode ? "FAILED" : "OK - baits come out of whatever you place");
await browser.close();
