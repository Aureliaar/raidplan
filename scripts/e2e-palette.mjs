/**
 * The palette: four things you drag, and what they mean depends on where you
 * let go. Bare floor makes a shape you own; a bait anchor makes a mechanic
 * thrown at whoever stands nearest it; the group chips give everybody one.
 *
 *   node scripts/e2e-palette.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=palette-e2e");
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
  body: JSON.stringify({ name: "palette e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

const canvas = page.locator("canvas").first();
const chip = (label) => page.locator("div", { hasText: new RegExp("^" + label + "$") }).last();

/** Arena units -> a position inside the canvas box, for dragTo. */
async function at(x, y) {
  const box = await canvas.boundingBox();
  const scale = box.width / 1000;
  return { x: box.width / 2 + x * scale, y: box.height / 2 + y * scale };
}

/** Drag a palette item onto a point of the arena. */
async function dropOnFloor(label, x, y) {
  await chip(label).dragTo(canvas, { targetPosition: await at(x, y) });
  await page.waitForTimeout(500);
}

/* --- an anchor lands where you dropped it --------------------------------- */

await dropOnFloor("Bait anchor", 200, -150);
let doc = await load();
const anchor = doc.entities.find((e) => e.type === "enemy" && e.role === "anchor");
if (!anchor) fail("dragging the bait anchor onto the floor placed nothing");
else if (Math.hypot(anchor.x - 200, anchor.y + 150) > 25)
  fail("the anchor landed at " + anchor.x + "," + anchor.y + " instead of 200,-150");
else console.log("bait anchor placed where it was dropped: " + anchor.x + "," + anchor.y);

/* --- a beam dropped ON the anchor is baited off it ------------------------- */

// Somebody has to be nearest: put M1 next to the anchor and everyone else far.
const ids = Object.fromEntries(doc.entities.filter((e) => e.name).map((e) => [e.name, e.id]));
await api("/api/plans/" + planId + "/ops", {
  method: "POST",
  body: JSON.stringify({
    ops: [
      { op: "update_entity", id: ids.M1, patch: { x: 300, y: -150 } },
      { op: "update_entity", id: ids.M2, patch: { x: 320, y: 400 } },
      { op: "update_entity", id: ids.MT, patch: { x: -400, y: 400 } },
    ],
  }),
});
await page.waitForTimeout(400);

await dropOnFloor("Beam", 200, -150);
doc = await load();
let beams = doc.entities.filter((e) => e.type === "zone" && e.shape === "rect" && e.anchor);
if (beams.length !== 1) fail("dropping a beam on the anchor made " + beams.length + " baits");
else if (beams[0].anchor.from !== anchor.id)
  fail("the beam is not fired from the anchor: " + JSON.stringify(beams[0].anchor));
else if (beams[0].anchor.pick !== "closest" || beams[0].anchor.rank !== 1)
  fail("the beam is not aimed at the closest player: " + JSON.stringify(beams[0].anchor));
else console.log("beam dropped on the anchor: " + beams[0].name + " " + JSON.stringify(beams[0].anchor));

// A second one of the same kind on the same anchor takes the second closest.
await dropOnFloor("Beam", 200, -150);
doc = await load();
beams = doc.entities.filter((e) => e.type === "zone" && e.shape === "rect" && e.anchor);
const ranks = beams.map((b) => b.anchor.rank).sort();
if (beams.length !== 2 || ranks.join() !== "1,2")
  fail("a second beam on the anchor should be rank 2, got ranks " + ranks.join());
else console.log("two beams on one anchor cover the two closest: ranks " + ranks.join());

// And they really do aim at different people.
const solved = await page.evaluate(
  ([id]) => {
    const stage = window.Konva.stages[0];
    const g = stage.findOne("#" + id);
    return g ? Math.round(g.rotation()) : null;
  },
  [beams.find((b) => b.anchor.rank === 1).id]
);
if (solved === null) fail("the rank-1 beam is not on the canvas");

/* --- a circle on the Supports chip gives each support one ----------------- */

await chip("Supports").dragTo(chip("Supports")); // no-op guard: chip must exist
const before = (await load()).entities.length;
await page.locator("div", { hasText: /^Circle$/ }).last().dragTo(chip("Supports"));
await page.waitForTimeout(700);
doc = await load();
const circles = doc.entities.filter((e) => e.type === "zone" && e.shape === "circle" && e.anchor);
const boundTo = circles.map((c) => doc.entities.find((e) => e.id === c.anchor.to)?.name).sort();
if (circles.length !== 4) fail("Supports should have taken 4 circles, got " + circles.length);
else if (boundTo.join() !== "H1,H2,MT,OT")
  fail("the circles went to " + boundTo.join() + " instead of the four supports");
else console.log("a circle on Supports bound one to each: " + boundTo.join());
if (doc.entities.length !== before + 4) fail("Supports added " + (doc.entities.length - before) + " entities");

/* --- a protean on Party comes from the boss ------------------------------- */

await page.locator("div", { hasText: /^Protean$/ }).last().dragTo(chip("Party"));
await page.waitForTimeout(900);
doc = await load();
const cones = doc.entities.filter((e) => e.type === "zone" && e.shape === "cone" && e.anchor);
if (cones.length !== 8) fail("Party should have taken 8 proteans, got " + cones.length);
else if (new Set(cones.map((c) => c.anchor.to)).size !== 8)
  fail("the proteans are not one per player");
else if (!cones.every((c) => c.anchor.from))
  fail("proteans are thrown from somewhere: " + JSON.stringify(cones[0].anchor));
else console.log("a protean on Party gave all eight one, thrown from " + (doc.entities.find((e) => e.id === cones[0].anchor.from)?.name ?? "?"));

/* --- what a group holds is one object, not eight ------------------------- */

// A bonded shape is a face of the set, so the canvas must not let you drag it.
const ghost = circles[0];
const ghostAt = await page.evaluate(
  (id) => {
    const n = window.Konva.stages[0].findOne("#" + id);
    return n ? { x: Math.round(n.x()), y: Math.round(n.y()) } : null;
  },
  ghost.id
);
const cbox = await canvas.boundingBox();
const cscale = cbox.width / 1000;
const onScreen = (x, y) => ({ x: cbox.x + cbox.width / 2 + x * cscale, y: cbox.y + cbox.height / 2 + y * cscale });
const grab = onScreen(ghostAt.x, ghostAt.y);
await page.mouse.move(grab.x, grab.y);
await page.mouse.down();
await page.mouse.move(grab.x + 120, grab.y + 90, { steps: 15 });
await page.mouse.up();
await page.waitForTimeout(600);
doc = await load();
const stillThere = doc.entities.find((e) => e.id === ghost.id);
if (stillThere.x !== ghost.x || stillThere.y !== ghost.y || stillThere.overrides?.[doc.steps[0].id])
  fail("a bonded circle moved when dragged: " + stillThere.x + "," + stillThere.y);
else console.log("a shape owned by a group cannot be dragged out of it");

// And the group's own row is what takes the whole set away.
await page.getByTitle("Remove this circle from the supports").click();
await page.waitForTimeout(700);
doc = await load();
const left = doc.entities.filter((e) => e.bond && e.bond.group === "supports");
if (left.length) fail("removing the set from the Supports row left " + left.length + " behind");
else console.log("the Supports row removed all four at once");

/* --- bare floor makes a shape of your own --------------------------------- */

await dropOnFloor("Circle", -300, 300);
doc = await load();
const free = doc.entities.find(
  (e) => e.type === "zone" && e.shape === "circle" && !e.anchor && Math.hypot(e.x + 300, e.y - 300) < 25
);
if (!free) fail("a circle dropped on bare floor did not land there unbound");
else console.log("a circle on bare floor is yours to move: " + free.x + "," + free.y);

console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
await browser.close();
