/**
 * A Beat: one cast, written as two moments on the rail.
 *
 * You open it in the step the cast snapshots in and drop its shapes into it.
 * Its card's top edge is the step it snapshots in and its bottom edge the step
 * it goes off in, and both are dragged, not typed. Its shapes are on the floor
 * for exactly that span, aimed at where the party stood at the snapshot — the
 * steps between are people walking out of them — unless the Snap diamond keeps
 * the aim live a little longer. A Part dropped with nothing open gets a Beat of
 * its own, and one Beat carried onto another folds into it.
 */
import { chip, drag, drawn, fail, finish, floor, gotoStep, rowMid, session } from "./harness.mjs";

const s = await session("beats-e2e", { width: 1600 });
const { page } = s;
const plan = await s.createPlan({ name: "beats e2e", withParty: true });
let doc = await plan.load();
await plan.ops([
  { op: "update_step", stepId: doc.steps[0].id, patch: { name: "Cast" } },
  { op: "duplicate_step", stepId: doc.steps[0].id, name: "Run" },
]);
doc = await plan.load();
await plan.ops({ op: "duplicate_step", stepId: doc.steps[1].id, name: "Boom" });
await plan.ops({ op: "add_step", name: "After" });
doc = await plan.load();
if (doc.steps.map((st) => st.name).join() !== "Cast,Run,Boom,After")
  fail("the steps are " + doc.steps.map((st) => st.name).join());
const [cast, run, boom, after] = doc.steps.map((st) => st.id);

await s.openPlan(plan.id);
const f = await floor(page);
const filling = async () => (await page.locator("text=/Filling/").count()) > 0;
const at = async (stepId, id) => (await drawn(page, plan.id, stepId)).find((e) => e.id === id);
const inBeat = async (stepId, beat) => (await drawn(page, plan.id, stepId)).filter((e) => e.mech === beat).length;

/* --- a Beat opens in the step you are on, and what you drop joins it ------- */

await page.getByRole("button", { name: "New Beat here" }).click();
await page.waitForTimeout(500);
doc = await plan.load();
const beat = doc.mechs[0]?.id;
if (doc.mechs.length !== 1 || doc.mechs[0].snap !== cast || doc.mechs[0].boom !== cast)
  fail("New Beat here did not make one Beat in the step you were on");
const card = page.locator(`[data-mech="${beat}"]`);

// The card is also a drag handle, but a plain press must open it at once, not on release.
await card.click();
const c = await card.boundingBox();
await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
await page.mouse.down();
if (!(await filling())) fail("pressing a Beat did not open it until the pointer came up");
await page.mouse.up();
if (!(await filling())) fail("a Beat opened on press closed again on the same release");

await chip(page, "Donut").dragTo(chip(page, "Party"));
await page.waitForTimeout(900);
doc = await plan.load();
const donuts = doc.entities.filter((e) => e.shape === "donut");
if (donuts.length !== 8 || !donuts.every((d) => d.mech === beat))
  fail(`a donut on Party put ${donuts.length} shapes down, not eight in the open Beat`);
console.log("New Beat here opened a Beat in Cast, a press opens it, and a donut on Party put eight in it");

/* --- the card's bottom edge is when it goes off ----------------------------- */

/** Drag an edge of the card — 6px at the top for the cast, 7px at the bottom for the resolve — to a row. */
async function edge(which, row) {
  const b = await card.boundingBox();
  const to = await rowMid(page, row);
  const x = b.x + b.width / 2;
  await drag(page, { x, y: which === "top" ? b.y + 3 : b.y + b.height - 3 }, { x, y: to.y });
}
await edge("bottom", 3);
const span = [];
for (const st of [cast, run, boom, after]) span.push(await inBeat(st, beat));
if (span.join() !== "8,8,8,0") fail(`with its bottom edge on Boom it is on the floor ${span.join("/")} in Cast/Run/Boom/After`);
console.log("its bottom edge dragged to Boom: on the floor from Cast to Boom, gone in After");

/* --- it is aimed at the snapshot, not at wherever people went --------------- */

const donut = donuts[0];
const target = donut.anchor.to;
const home = await at(cast, donut.id);
// The one it is aimed at runs to the north-west wall in Run, and stays there.
await plan.ops([run, boom].map((st) => ({ op: "update_entity", id: target, patch: { x: -430, y: -430 }, stepId: st })));
await page.waitForTimeout(400);
const held = await at(boom, donut.id);
const wall = await at(boom, target);
if (Math.hypot(held.x - home.x, held.y - home.y) > 1) fail("the donut followed its target instead of holding its snapshot");
if (Math.hypot(wall.x - held.x, wall.y - held.y) < 100) fail("the target never moved away from it");
if (!(home.opacity < held.opacity)) fail(`the telegraph (${home.opacity}) is not fainter than the hit (${held.opacity})`);
console.log("the donut holds its snapshot while its target runs; faint in the air, full when it goes off");

/* --- the top edge is when it snapshots, and moving it re-aims the cast ------ */

await edge("top", 2);
const reaimed = await at(boom, donut.id);
if (Math.hypot(reaimed.x - wall.x, reaimed.y - wall.y) > 60)
  fail("snapshotting in Run did not re-aim the donut at the wall: " + JSON.stringify([reaimed.x, reaimed.y]));
if (await inBeat(cast, beat)) fail("the Beat is still on the floor in Cast, before its snapshot");
console.log("its top edge dragged to Run: it re-aims at the wall and leaves Cast empty");

/* --- the Snap diamond keeps the aim live a little longer ------------------- */

// Stretched to After it spans three steps, and a Beat of three or more carries a diamond.
await edge("bottom", 4);
doc = await plan.load();
const stretched = doc.mechs.find((m) => m.id === beat);
if (stretched.snap !== run || stretched.boom !== after) fail("stretching the bottom edge to After moved the snapshot");
const diamond = page.locator(`[data-freeze="${beat}"]`);
if (!(await diamond.count())) fail("a Beat spanning three steps has no Snap diamond");
// The target walks on in Boom and again in After: frozen in Boom, the donut
// follows them there and then stays where they stood.
await plan.ops([
  { op: "update_entity", id: target, patch: { x: 430, y: -430 }, stepId: boom },
  { op: "update_entity", id: target, patch: { x: 0, y: 430 }, stepId: after },
]);
const d = await diamond.boundingBox();
const row3 = await rowMid(page, 3);
await drag(page, { x: d.x + d.width / 2, y: d.y + d.height / 2 }, { x: d.x + d.width / 2, y: row3.y });
doc = await plan.load();
if (doc.mechs.find((m) => m.id === beat).freeze !== boom) fail("dragging the diamond to Boom's row did not freeze it there");
const frozen = await at(after, donut.id);
if (Math.hypot(frozen.x - 430, frozen.y + 430) > 30)
  fail("frozen in Boom, the donut is not drawn in After where its target stood in Boom: " + JSON.stringify([frozen.x, frozen.y]));
console.log("the diamond dragged to Boom: the donut follows its target there and holds that spot through After");

/* --- a drop with nothing open gets a Beat; carried onto another Beat it folds in */

if (await filling()) await card.click();
await gotoStep(page, 1);
await f.drop("Circle", 150, 250);
doc = await plan.load();
const loose = doc.mechs.find((m) => m.id !== beat);
if (!loose || loose.snap !== cast || loose.boom !== cast)
  fail("a circle dropped in Cast with nothing open did not get a Beat of its own there");
const other = page.locator(`[data-mech="${loose.id}"]`);
if (await filling()) await other.click();
const from = await other.boundingBox();
const into = await card.boundingBox();
await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
await page.mouse.down();
await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 10, { steps: 4 });
await page.mouse.move(into.x + into.width / 2, into.y + into.height / 2, { steps: 12 });
await page.waitForTimeout(150);
await page.mouse.up();
await page.waitForTimeout(700);
doc = await plan.load();
const merged = doc.mechs.find((m) => m.id === beat);
if (doc.mechs.length !== 1 || !merged)
  fail("carrying one Beat onto another did not fold them: " + JSON.stringify(doc.mechs.map((m) => m.id)));
if (!doc.entities.filter((e) => e.type === "zone").every((z) => z.mech === beat)) fail("a Part was left behind by the merge");
if (merged.snap !== cast || merged.boom !== after) fail("the merged Beat does not cover both spans");
console.log("a circle dropped in Cast got a Beat of its own; carried onto the first, it folded in and the span grew");

/* --- clicking the card points at everything in the Beat --------------------- */

// Opening a Beat is how you fill it, so the palette has to survive the click —
// and the Parts it holds come up selected, ready to be moved or styled as one.
await page.locator("canvas").first().click({ position: { x: 8, y: 8 } });
await page.waitForTimeout(300);
if (await page.locator('[data-side-tab="details"]').isDisabled().then((d) => !d))
  fail("clicking bare floor left something selected");
await card.click();
await page.waitForTimeout(500);
if (await page.locator('[data-side-tab="details"]').isDisabled())
  fail("clicking the Beat card selected nothing");
if (!(await page.locator('[data-panel="palette"]').count()))
  fail("clicking the Beat card took the palette away, so it cannot be filled");
console.log("clicking the Beat card selects the Parts in it and keeps the palette up");

/* --- a locked Beat is looked straight through, and let go by right-click --- */

await gotoStep(page, 1);
const circle = (await plan.load()).entities.find((e) => e.shape === "circle");
// Inside the circle, clear of the party standing around it.
const spot = { x: circle.x - 50, y: circle.y - 100 };
const inspecting = async (id) => (await page.locator("aside").innerText()).includes(id);
await card.click({ button: "right" });
await page.locator('[data-menu-item="Lock Beat"]').click();
await page.waitForTimeout(600);
if (!(await plan.load()).mechs[0]?.locked) fail("Lock Beat on the card's menu did not lock the Beat");
await f.deselect();
await f.click(spot.x, spot.y);
if (await inspecting(circle.id)) fail("a click on a Part of a locked Beat still selected it");
await f.deselect();
const onCircle = f.screen(spot.x, spot.y);
await page.mouse.click(onCircle.x, onCircle.y, { button: "right" });
await page.locator('[data-menu-item="Unlock Beat"]').click();
await page.waitForTimeout(600);
if ((await plan.load()).mechs[0]?.locked) fail("Unlock Beat on its Part's menu left the Beat locked");
await f.deselect();
await f.click(spot.x, spot.y);
if (!(await inspecting(circle.id))) fail("a click on the circle did not select it once its Beat was unlocked");
console.log("Lock Beat made its circle unclickable, and Unlock Beat on the circle's own menu freed it");

/* --- a Beat is one thing: named where it sits, deleted with all it holds ---- */

await gotoStep(page, 2);
if (!(await filling())) await card.click();
await page.keyboard.press("F2");
const nameField = page.getByTitle("Rename Beat");
await nameField.waitFor();
await nameField.fill("Ice Missile");
await nameField.press("Enter");
await page.waitForTimeout(600);
if ((await plan.load()).mechs[0]?.name !== "Ice Missile") fail("renaming the Beat did not stick");
await page.getByTitle("Delete this Beat and everything in it").click();
await page.waitForTimeout(700);
doc = await plan.load();
if (doc.mechs.length || doc.entities.some((e) => e.type === "zone")) fail("deleting the Beat left it, or its shapes, behind");
console.log("F2 renamed it Ice Missile, and its delete button took all nine shapes with it");

await finish(s, "OK - " + plan.url);
