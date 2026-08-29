/**
 * Everything derived redraws *during* a drag, not when you let go.
 *
 * A bait follows its target and an autobait re-picks who it hits while the
 * mouse is still down, so what you see mid-drag is what you commit. This holds
 * the button down, asserts the canvas has already moved while the server has
 * not, then releases and checks the commit landed.
 *
 *   node scripts/e2e-livedrag.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=livedrag-e2e");
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

const created = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "live drag e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const boss = (await ops(planId, [{ op: "add_entity", spec: { type: "enemy", name: "boss", x: 0, y: 0, size: 140 } }]))
  .values[0].id;
let doc = await api("/api/plans/" + planId).then((p) => p.plan ?? p);
const idOf = (name) => doc.entities.find((e) => e.name === name).id;

const made = await ops(planId, [
  { op: "add_entity", spec: { type: "zone", name: "Donut", shape: "donut", innerRadius: 120, radius: 380, anchor: { to: idOf("H1") } } },
  { op: "add_entity", spec: { type: "zone", name: "Auto", shape: "rect", width: 160, anchor: { pick: "closest", from: boss, extend: true } } },
  { op: "add_entity", spec: { type: "tether", from: boss, to: idOf("H1") } },
]);
const donutId = made.values[0].id;
const autoId = made.values[1].id;

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

const node = (id) =>
  page.evaluate(
    (eid) => {
      const n = window.Konva.stages[0].findOne("#" + eid);
      return n ? { x: Math.round(n.x()), y: Math.round(n.y()), rotation: Math.round(n.rotation()) } : null;
    },
    id
  );

const box = await page.locator("canvas").first().boundingBox();
doc = await api("/api/plans/" + planId).then((p) => p.plan ?? p);
const h1 = doc.entities.find((e) => e.name === "H1");
const scale = box.width / doc.arena.width;
const screen = (x, y) => ({ x: box.x + box.width / 2 + x * scale, y: box.y + box.height / 2 + y * scale });

const donutBefore = await node(donutId);
const autoBefore = await node(autoId);

// Press on H1 and walk them in close to the boss — closer than anyone else, so
// the autobait must hand its beam over — and stop there, button still down.
const dropAt = { x: 30, y: -40 };
const from = screen(h1.x, h1.y);
const to = screen(dropAt.x, dropAt.y);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 25 });
await page.waitForTimeout(250);

const donutMid = await node(donutId);
const autoMid = await node(autoId);
const midDoc = await api("/api/plans/" + planId).then((p) => p.plan ?? p);
const h1Mid = midDoc.entities.find((e) => e.name === "H1");

if (Math.abs(h1Mid.x - h1.x) > 1 || Math.abs(h1Mid.y - h1.y) > 1)
  fail("the drag committed before the mouse came up — this test proves nothing");
if (Math.hypot(donutMid.x - dropAt.x, donutMid.y - dropAt.y) > 20)
  fail("the donut did not follow H1 mid-drag: it is at " + donutMid.x + "," + donutMid.y);
else console.log("mid-drag: donut is already at " + donutMid.x + "," + donutMid.y + ", server still has H1 at " + Math.round(h1Mid.x) + "," + Math.round(h1Mid.y));

// H1 is now the farthest player, so the autobait must have handed its beam on.
const wantBearing = Math.round((Math.atan2(dropAt.x, -dropAt.y) * 180) / Math.PI);
if (Math.abs(((autoMid.rotation - wantBearing + 540) % 360) - 180) > 6)
  fail("the autobait did not re-target to the player being dragged in: " + autoMid.rotation + "deg, want ~" + wantBearing);
else console.log("mid-drag: autobait swung " + autoBefore.rotation + "deg -> " + autoMid.rotation + "deg (H1 is now closest)");

const tetherEnds = await page.evaluate(() =>
  window.Konva.stages[0].find(".tether-guide").flatMap((line) => {
    const points = line.points();
    const transform = line.getParent().getTransform();
    return [
      transform.point({ x: points[0], y: points[1] }),
      transform.point({ x: points.at(-2), y: points.at(-1) }),
    ];
  })
);
if (!tetherEnds.some((p) => Math.hypot(p.x - dropAt.x, p.y - dropAt.y) < 20))
  fail("no tether endpoint followed H1 mid-drag");
else console.log("mid-drag: the tether endpoint moved with H1 too");

await page.mouse.up();
await page.waitForTimeout(700);

const finalDoc = await api("/api/plans/" + planId).then((p) => p.plan ?? p);
const h1Final = finalDoc.entities.find((e) => e.name === "H1");
const pose = h1Final.overrides?.[finalDoc.steps[0].id] ?? h1Final;
if (Math.hypot(pose.x - dropAt.x, pose.y - dropAt.y) > 25)
  fail("the drop did not commit: H1 is at " + pose.x + "," + pose.y);
const donutAfter = await node(donutId);
if (Math.hypot(donutAfter.x - donutMid.x, donutAfter.y - donutMid.y) > 5)
  fail("the donut jumped between the drop and the commit: " + JSON.stringify(donutMid) + " -> " + JSON.stringify(donutAfter));

console.log(process.exitCode ? "FAILED" : "OK - the canvas re-solves while you drag, and does not flinch on drop");
await browser.close();
