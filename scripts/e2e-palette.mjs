/**
 * The palette: things you drag, whose meaning depends on where you let go.
 * Bare floor makes a shape of your own, in a Beat of its own; a beam dropped
 * on a bait anchor is thrown at whoever stands nearest it; a group chip gives
 * everybody in the group one, thrown from a source even on a plan with no
 * enemy; a tether dropped on one thing is finished by picking another; a Boss
 * is an ordinary enemy mechanics can come out of; and a group's row carries
 * the whole group.
 */
import { chip, drawn, fail, finish, floor, session } from "./harness.mjs";

const s = await session("palette-e2e");
const { page } = s;
// A party and no enemy at all: every source on this floor is one we place.
const plan = await s.createPlan({ name: "palette e2e", withParty: true });
await s.openPlan(plan.id);
const f = await floor(page);
let doc = await plan.load();
const step = doc.steps[0].id;
const ids = Object.fromEntries(doc.entities.filter((e) => e.name).map((e) => [e.name, e.id]));
const nameOf = (id) => doc.entities.find((e) => e.id === id)?.name;

/* --- bare floor: a shape you own, in a Beat named after it ----------------- */

await f.drop("Circle", -300, 300);
doc = await plan.load();
const free = doc.entities.find((e) => e.type === "zone" && e.shape === "circle");
const own = free && doc.mechs.find((m) => m.id === free.mech);
if (!free || free.anchor || Math.hypot(free.x + 300, free.y - 300) > 25)
  fail("a circle dropped on bare floor did not land there, unbound: " + JSON.stringify(free));
if (!own) fail("the dropped circle is in no Beat");
if (own.snap !== step || own.boom !== step) fail("the circle's Beat does not span the step it was dropped in");
if (own.name !== "Circle") fail(`the new Beat is named ${JSON.stringify(own.name)} instead of after the drop`);
console.log("a circle on bare floor lands where it was dropped, in a Beat of its own called Circle");

/* --- a beam on a bait anchor is thrown at whoever stands nearest ----------- */

await f.drop("Bait anchor", 200, -150);
doc = await plan.load();
const anchor = doc.entities.find((e) => e.role === "anchor");
if (!anchor || Math.hypot(anchor.x - 200, anchor.y + 150) > 25)
  fail("dragging the bait anchor out did not place it at 200,-150: " + JSON.stringify(anchor));
// Somebody has to be nearest: M1 beside the anchor, everyone else well away.
await plan.ops([
  { op: "update_entity", id: ids.M1, patch: { x: 300, y: -150 } },
  { op: "update_entity", id: ids.M2, patch: { x: 320, y: 400 } },
  { op: "update_entity", id: ids.MT, patch: { x: -400, y: 400 } },
]);
await page.waitForTimeout(400);
await f.drop("Beam", 200, -150);
doc = await plan.load();
let beams = doc.entities.filter((e) => e.shape === "rect" && e.anchor?.from === anchor.id);
if (beams.length !== 1) fail(`a beam dropped on the anchor made ${beams.length} baits off it`);
if (beams[0].anchor.pick !== "closest" || beams[0].anchor.rank !== 1)
  fail("the beam is not aimed at the closest player: " + JSON.stringify(beams[0].anchor));
if (beams[0].mech !== anchor.mech) fail("the beam went into a Beat of its own instead of its anchor's");

// A second beam on the same anchor widens it: one mechanic covering two people.
await f.drop("Beam", 200, -150);
doc = await plan.load();
beams = doc.entities.filter((e) => e.shape === "rect" && e.anchor?.from === anchor.id);
if (beams.length !== 1 || beams[0].anchor.count !== 2)
  fail(`a second beam on the anchor should widen the first: ${beams.length} baits, count ${beams[0]?.anchor.count}`);

// Two shapes on the floor, one bait: clicking the second selects it, and its
// editor says who it is hitting.
const second = await page.evaluate((id) => {
  const box = window.Konva.stages[0].findOne("#" + id)?.getClientRect();
  return box && { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}, beams[0].id + "~2");
if (!second) fail("the widened beam drew only one shape");
await f.measure();
await page.mouse.click(f.box.x + second.x, f.box.y + second.y);
await page.waitForTimeout(400);
if (!(await page.locator("text=bait target").count())) fail("clicking the second shape did not select the bait");
if (!(await page.locator("text=right now:").count())) fail("the bait editor does not say who it hits right now");
console.log("a beam on the anchor aims at the closest player; a second one widens it to two, one bait");
await f.deselect();

/* --- a group chip gives everybody in the group one -------------------------- */

await chip(page, "Circle").dragTo(chip(page, "Supports"));
await page.waitForTimeout(700);
doc = await plan.load();
const bound = doc.entities.filter((e) => e.type === "zone" && e.shape === "circle" && e.anchor);
const supports = bound.map((c) => nameOf(c.anchor.to)).sort().join();
if (supports !== "H1,H2,MT,OT") fail(`a circle on Supports went to ${supports} instead of the four supports`);

await chip(page, "Protean").dragTo(chip(page, "Party"));
await page.waitForTimeout(900);
doc = await plan.load();
const cones = doc.entities.filter((e) => e.type === "zone" && e.shape === "cone" && e.anchor);
if (cones.length !== 8 || new Set(cones.map((c) => c.anchor.to)).size !== 8)
  fail(`a protean on Party made ${cones.length} cones, not one each`);
if (!cones.every((c) => doc.entities.some((e) => e.id === c.anchor.from)))
  fail("the proteans are thrown from nothing: " + JSON.stringify(cones[0].anchor));
console.log(`a circle on Supports bound one each to ${supports}; a protean on Party gave all eight one`);

/* --- a tether dropped on one thing is finished by picking another ---------- */

const m2 = await f.nodeAt(ids.M2);
const h1 = await f.nodeAt(ids.H1);
await chip(page, "Together tether").dragTo(f.canvas, { targetPosition: { x: m2.x - f.box.x, y: m2.y - f.box.y } });
await page.getByText(/Pick any other object for the other end/).waitFor();
await page.mouse.click(h1.x, h1.y);
await page.waitForTimeout(700);
doc = await plan.load();
if (!doc.entities.some((e) => e.type === "tether" && e.from === ids.M2 && e.to === ids.H1))
  fail("dropping a tether on M2 and clicking H1 did not tie M2 to H1");
console.log("a tether dropped on M2 was tied to H1 by the next click");
await f.deselect();

/* --- a Boss is an ordinary enemy, and a mechanic dropped on it comes out of it */

await f.drop("Boss", 300, 300);
doc = await plan.load();
const boss = doc.entities.find((e) => e.name === "boss 1");
if (!boss || boss.type !== "enemy" || boss.role === "anchor")
  fail("the Boss chip did not make an ordinary enemy: " + JSON.stringify(boss));
await f.drop("Beam", 300, 300);
doc = await plan.load();
if (!doc.entities.some((e) => e.shape === "rect" && e.anchor?.from === boss.id))
  fail("a beam dropped on the boss is not thrown from it");
console.log("the Boss chip makes an ordinary enemy, and a beam dropped on it comes out of it");

/* --- a group's row carries the whole group ---------------------------------- */

const where = async () =>
  Object.fromEntries(
    (await drawn(page, plan.id))
      .filter((e) => e.type === "player")
      .map((e) => [e.name, { x: Math.round(e.x), y: Math.round(e.y) }])
  );
const before = await where();
await page.getByRole("button", { name: "Groups" }).click();
await page.locator("[data-group-row=g1]").waitFor();
await f.measure();
await page
  .locator("[data-group-row=g1]")
  .dragTo(f.canvas, { targetPosition: { x: f.box.width * 0.28, y: f.box.height * 0.24 } });
await page.waitForTimeout(1200);
const after = await where();
const G1 = ["MT", "H1", "M1", "R1"];
const G2 = ["OT", "H2", "M2", "R2"];
const spread = Math.max(
  ...G1.flatMap((a) => G1.map((b) => Math.hypot(after[a].x - after[b].x, after[a].y - after[b].y)))
);
if (!G1.some((n) => Math.hypot(after[n].x - before[n].x, after[n].y - before[n].y) > 50))
  fail("dragging the G1 row moved nobody");
if (spread > 41) fail("G1 did not stack tightly: " + JSON.stringify(G1.map((n) => after[n])));
if (G2.some((n) => after[n].x !== before[n].x || after[n].y !== before[n].y)) fail("moving G1 moved G2 as well");
console.log(`the G1 row carried all four of G1, stacked within ${Math.round(spread)} units; G2 stayed put`);

/* --- a chip's own menu places it without the hand --------------------------- */

const chipMenu = async (kind, item) => {
  await page.locator('[data-side-tab="add"]').click();
  const box = await page.locator(`[data-palette-chip="${kind}"]`).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await page.locator("[data-context-menu]").first().waitFor({ state: "visible", timeout: 3000 });
  for (const row of [].concat(item)) {
    await page.locator(`[data-menu-item="${row}"]`).click();
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(500);
};

const freeCircles = async () =>
  (await plan.load()).entities.filter(
    (e) => e.type === "zone" && e.shape === "circle" && !e.anchor && e.x === 0 && e.y === 0
  );
const hadMiddle = (await freeCircles()).length;
await chipMenu("circle", "Add at the centre");
const gotMiddle = (await freeCircles()).length;
if (gotMiddle !== hadMiddle + 1)
  fail(`"Add at the centre" left ${gotMiddle} free circles on the origin, not ${hadMiddle + 1}`);
// The second row follows the floor selection, and says who it means: the
// Groups row is the steadiest way to pick two people on a crowded floor.
await page.locator('[data-side-tab="add"]').click();
await page.getByRole("button", { name: "Groups" }).click();
await page.locator("[data-group-row=healers]").click();
await page.waitForTimeout(400);
await chipMenu("donut", "Add on 2 selected");
doc = await plan.load();
const onHealers = doc.entities.filter((e) => e.type === "zone" && e.shape === "donut" && e.anchor);
if (onHealers.length !== 2) fail(`"Add on 2 selected" made ${onHealers.length} donuts, not one each`);
if (onHealers.some((e) => e.bond)) fail("baits put on a selection were bonded into a group set");
console.log("the Circle chip's menu drops one in the middle, and the Donut chip binds one to each selected healer");

await finish(s, "OK - " + plan.url);
