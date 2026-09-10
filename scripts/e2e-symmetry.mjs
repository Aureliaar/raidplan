/**
 * Authoring in symmetry.
 *
 * 1, 2 and 3 pick Off, two-way and four-way; Q swaps Mirror for Rotate. With
 * symmetry on, dragging a party member moves its counterparts live, found by
 * encounter slot (R1 pairs with R2 whatever their jobs) even though a party
 * made by hand carries no symmetry metadata. A palette drop previews every
 * face before mouseup, follows the keys pressed mid-drag, and hands the
 * preview straight to persistent copies. Moving any face of that set moves the
 * rest; Off edits one face alone; Delete on one face takes the whole set.
 *
 * Symmetry sits between the pointer and every op the editor sends, so almost
 * any change to dragging, dropping or selection can quietly break it.
 */
import { drag, fail, finish, floor, posed, session } from "./harness.mjs";

const s = await session("symmetry-e2e", { width: 1900, height: 1000 });
const { page } = s;
const plan = await s.createPlan({ name: "symmetry e2e", withParty: false });
await plan.ops([
  { op: "add_entity", spec: { type: "player", job: "WAR", name: "MT", x: -220, y: -120 } },
  { op: "add_entity", spec: { type: "player", job: "PLD", name: "OT", x: 220, y: 120 } },
]);
await s.openPlan(plan.id, 1000);
let f = await floor(page);
let doc = await plan.load();
const step = doc.steps[0].id;
const near = (p, [x, y], tolerance = 8) => p && Math.hypot(p.x - x, p.y - y) <= tolerance;
/** Every listed name stands at its expected point in the first step. */
const standing = (d, expected) =>
  Object.entries(expected).filter(([name, point]) => !near(posed(d, name, step), point)).map(([name]) => name);
const nodes = (ids) =>
  page.evaluate(
    (list) =>
      list.map((id) => {
        const n = window.Konva.stages[0].findOne("#" + id);
        return n && { x: Math.round(n.x()), y: Math.round(n.y()) };
      }),
    ids
  );

/* --- two-way rotation carries a hand-made counterpart, live ---------------- */

const [mt, ot] = ["MT", "OT"].map((n) => posed(doc, n, step));
await f.deselect();
await page.keyboard.press("2");
await page.keyboard.press("q");
if ((await page.getByRole("button", { name: "Rotate" }).getAttribute("aria-pressed")) !== "true")
  fail("Q did not switch the toolbar to Rotate");
const from = f.screen(mt.x, mt.y);
const to = f.screen(120, -220);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 12 });
await page.waitForTimeout(200);
const [otLive] = await nodes([ot.id]);
if (!near(otLive, [-120, 220], 12)) fail(`OT waited for the drop instead of orbiting live: ${JSON.stringify(otLive)}`);
const rings = await page.evaluate(() =>
  window.Konva.stages[0].find(".selection").map((ring) => ring.getParent()?.id()).filter(Boolean)
);
if (!rings.includes(mt.id) || !rings.includes(ot.id)) fail(`MT and OT are not both ringed as selected: ${rings.join(", ")}`);
await page.mouse.up();
await page.waitForTimeout(700);
doc = await plan.load();
const off = standing(doc, { MT: [120, -220], OT: [-120, 220] });
if (off.length) fail(`after a two-way rotate drag ${off.join(" and ")} stood wrong`);
console.log("2 + Q: dragging MT orbits OT with it, live and ringed, though neither carries symmetry metadata");

/* --- party slots pair across jobs, and four-way spans each half ------------ */

await plan.ops([
  { op: "update_entity", id: mt.id, patch: { x: -140, y: -140 }, stepId: step },
  { op: "update_entity", id: ot.id, patch: { x: 140, y: 140 }, stepId: step },
  { op: "add_entity", spec: { type: "player", job: "WHM", name: "H1", x: 140, y: -140 } },
  { op: "add_entity", spec: { type: "player", job: "SCH", name: "H2", x: -140, y: 140 } },
  { op: "add_entity", spec: { type: "player", job: "BRD", name: "R1", x: -270, y: -270 } },
  { op: "add_entity", spec: { type: "player", job: "BLM", name: "R2", x: 270, y: -270 } },
  { op: "add_entity", spec: { type: "player", job: "SAM", name: "M1", x: 270, y: 270 } },
  { op: "add_entity", spec: { type: "player", job: "DRG", name: "M2", x: -270, y: 270 } },
]);
// A reload puts symmetry back to Off and Mirror.
await s.openPlan(plan.id, 700);
f = await floor(page);
const nudge = async (name) => {
  const id = posed(await plan.load(), name, step).id;
  const p = await f.nodeAt(id);
  await drag(page, p, { x: p.x + 20 * f.scale, y: p.y + 20 * f.scale }, { steps: 10, settle: 600 });
};

await f.deselect();
await page.keyboard.press("2");
await nudge("R1");
let wrong = standing(await plan.load(), { R1: [-250, -250], R2: [250, -250] });
if (wrong.length) fail(`two-way mirror did not pair bard R1 with black mage R2: ${wrong.join(", ")} off`);
console.log("2: nudging R1 mirrors R2 across the north-south line — a bard and a black mage are one pair");

await page.getByRole("button", { name: "3: 4-way" }).click();
await nudge("R1");
wrong = standing(await plan.load(), { R1: [-230, -230], R2: [230, -230], M1: [230, 230], M2: [-230, 230] });
if (wrong.length) fail(`four-way mirror left ${wrong.join(", ")} behind when R1 moved`);
await nudge("MT");
wrong = standing(await plan.load(), { MT: [-120, -120], H1: [120, -120], OT: [120, 120], H2: [-120, 120] });
if (wrong.length) fail(`four-way mirror left ${wrong.join(", ")} behind when MT moved`);
console.log("3: four-way moves all four damage dealers from R1, and all four supports from MT");

/* --- a drop previews every face, and the keys reshape it mid-drag ----------- */

const inspector = page.locator('[data-panel="inspector"]');
if (await inspector.count()) {
  await inspector.locator("button", { hasText: "✕" }).click();
  await page.locator('[data-panel="palette"]').waitFor();
}
await f.measure();
const circleChip = page.getByText("Circle", { exact: true });
const chipBox = await circleChip.boundingBox();
const target = f.screen(-190, -140);
await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
await page.mouse.down();
await page.mouse.move(target.x, target.y, { steps: 12 });
await page.waitForTimeout(200);
const previews = () =>
  page.evaluate(() =>
    window.Konva.stages[0].find(".drop-preview").map((n) => ({ x: Math.round(n.x()), y: Math.round(n.y()) }))
  );
const shows = async (expected, what) => {
  const seen = await previews();
  if (seen.length !== expected.length || expected.some((point) => !seen.some((p) => near(p, point))))
    fail(`${what}: the drop previewed ${JSON.stringify(seen)}`);
};
await shows([[-190, -140], [190, -140], [190, 140], [-190, 140]], "four-way mirror, before mouseup");
await page.keyboard.press("2");
await page.waitForTimeout(100);
await shows([[-190, -140], [190, -140]], "2 pressed mid-drag");
await page.keyboard.press("q");
await page.waitForTimeout(100);
await shows([[-190, -140], [190, 140]], "Q pressed mid-drag");
await page.keyboard.press("3");
await page.waitForTimeout(100);
const rotated = [[-190, -140], [140, -190], [190, 140], [-140, 190]];
await shows(rotated, "3 pressed mid-drag, in Rotate");
if ((await plan.load()).entities.some((e) => e.type === "zone")) fail("the circles were committed before mouseup");
console.log("a held Circle previews every face, and 2, Q and 3 pressed mid-drag reshape the preview");

// Hold the write so the first paint after mouseup is the client's alone.
let answer;
await page.route(
  `**/api/plans/${plan.id}/ops`,
  async (route) => {
    await new Promise((resolve) => (answer = resolve));
    await route.continue();
  },
  { times: 1 }
);
await page.mouse.up();
await page.waitForTimeout(50);
const handoff = await page.evaluate(() => ({
  previews: window.Konva.stages[0].find(".drop-preview").length,
  circles: window.Konva.stages[0].find(".entity").filter((n) => n.id().startsWith("zone_")).length,
}));
if (!answer) fail("the drop sent nothing to the server");
if (handoff.previews || handoff.circles !== 4) fail(`mouseup did not hand the preview to four circles: ${JSON.stringify(handoff)}`);
answer();
await page.waitForTimeout(800);
doc = await plan.load();
let circles = doc.entities.filter((e) => e.type === "zone" && e.shape === "circle");
if (circles.length !== 4 || rotated.some((point) => !circles.some((c) => near(c, point))))
  fail(`the drop committed ${JSON.stringify(circles.map((c) => [c.x, c.y]))}, not the four it previewed`);
if (new Set(circles.map((c) => c.symmetry?.id)).size !== 1 || !circles[0].symmetry)
  fail("the four circles were not saved as one symmetry set");
console.log("mouseup turned the preview straight into four circles, saved as one set, with no blank frame");

/* --- a set moves as one; Off edits one face; Delete takes them all ---------- */

await f.deselect();
const northWest = circles.find((c) => c.x < 0 && c.y < 0);
const grab = f.screen(northWest.x, northWest.y);
const drop = f.screen(-250, -200);
const before = doc.rev;
await page.mouse.move(grab.x, grab.y);
await page.mouse.down();
await page.mouse.move(drop.x, drop.y, { steps: 12 });
await page.waitForTimeout(200);
const moved = [[-250, -200], [200, -250], [250, 200], [-200, 250]];
const live = await nodes(circles.map((c) => c.id));
if (moved.some((point) => !live.some((p) => near(p, point))))
  fail(`the other faces waited for the drop: ${JSON.stringify(live)}`);
if ((await plan.load()).rev !== before) fail("dragging a face committed before mouseup");
await page.mouse.up();
await page.waitForTimeout(700);
circles = (await plan.load()).entities.filter((e) => e.type === "zone");
if (moved.some((point) => !circles.some((c) => near(c, point)))) fail("what the faces previewed is not what committed");
console.log("dragging one circle moves all four live, and exactly that commits");

// Each face now sits beside a damage dealer, and the smallest thing under the
// pointer wins, so take the circles by their open ground rather than their centres.
await f.deselect();
await page.keyboard.press("1");
await drag(page, f.screen(-330, -150), f.screen(-380, -150));
circles = (await plan.load()).entities.filter((e) => e.type === "zone");
if (!circles.some((c) => near(c, [-300, -200])) || moved.slice(1).some((point) => !circles.some((c) => near(c, point))))
  fail(`with symmetry Off the drag did not move just the one face: ${JSON.stringify(circles.map((c) => [c.x, c.y]))}`);
await page.keyboard.press("3");
await f.click(300, -300);
await page.keyboard.press("Delete");
await page.waitForTimeout(700);
const left = (await plan.load()).entities.filter((e) => e.type === "zone").length;
if (left) fail(`Delete on one face in four-way left ${left} of the set behind`);
console.log("1: a drag moves one face alone; 3 + Delete on one face takes the whole set");

await finish(s, "OK - " + plan.url);
