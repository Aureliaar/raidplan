/**
 * The outline: Encounter → Mechanic → (Variant) → Steps.
 *
 * A mechanic is a section of the fight owning a run of steps, and it owns them
 * whichever way it goes: a variant does not own steps. What a reading owns is
 * the casts that only land that way and, quietly, where the party stands. The
 * section you are in is the section holding the step you selected: there is no
 * open/closed state to disagree with the canvas.
 *
 *   node scripts/e2e-mechanics.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=mechanics-e2e");
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
  body: JSON.stringify({ name: "mechanics e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);
const ops = (o) =>
  api("/api/plans/" + planId + "/ops", { method: "POST", body: JSON.stringify({ ops: [].concat(o) }) });

/** Where an entity is drawn in a step — what the canvas shows for that step. */
const drawnAt = (stepId, entityId) =>
  page.evaluate(
    async ([id, sid, eid]) => {
      const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
      const mod = await import("/src/shared/schema.ts");
      const e = mod.entitiesForStep(d, sid).find((x) => x.id === eid);
      return e ? { x: Math.round(e.x), y: Math.round(e.y) } : null;
    },
    [planId, stepId, entityId]
  );

/** Carry one row or heading onto another: where it sits is the whole of the edit. */
async function dragOnto(from, to) {
  const a = await page.getByRole("button", { name: from }).boundingBox();
  const b = await page.getByRole("button", { name: to }).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(800);
}

/** The step row the rail has selected, which is the step the canvas draws. */
const selectedRow = () =>
  page.locator('nav button[data-step][aria-current="step"]').first().innerText();
const stepsOf = (doc, mechanicId) => doc.steps.filter((s) => s.mechanic === mechanicId);

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

let doc = await load();
// A new plan opens on a section of its own: every step is in a mechanic.
if (doc.mechanics.length !== 1 || !doc.steps.every((s) => s.mechanic === doc.mechanics[0].id))
  fail("a new plan did not start with one mechanic holding its step");
else console.log("a new plan starts with one section holding its first step");
const firstStep = doc.steps[0].id;
// Named, so it is not confused with the first step of the next mechanic — rows
// are numbered within their section, so both would otherwise read "1.".
await ops({ op: "update_step", stepId: firstStep, patch: { name: "Pull" } });
await page.waitForTimeout(400);

/* --- a new section of the fight, and you are standing in it ---------------- */

await page.getByRole("button", { name: "New mechanic" }).click();
await page.waitForTimeout(700);
doc = await load();
if (doc.mechanics.length !== 2) fail("New mechanic made " + doc.mechanics.length + " mechanics");
const mechanicId = doc.mechanics[1].id;
if (stepsOf(doc, mechanicId).length !== 1) fail("a new mechanic should come with a step in it");
else if (!(await page.getByTitle("Delete this mechanic and its steps").isVisible()))
  fail("the new mechanic is not the open section, so nothing in it is selected");
else console.log("New mechanic added a second section and left us inside it");

// Unnamed, a section goes by its place in the fight. The heading renames where
// it sits, like every other name in the rail.
await page.getByRole("button", { name: "Mechanic 2" }).click();
await page.keyboard.press("F2");
const heading = page.getByTitle("Rename mechanic");
await heading.waitFor();
await heading.fill("Witch Hunt");
await heading.press("Enter");
await page.waitForTimeout(600);
doc = await load();
if (doc.mechanics[1].name !== "Witch Hunt") fail("F2 on the heading gave " + doc.mechanics[1].name);
else console.log('F2 on the heading renamed the mechanic: "Witch Hunt"');

/* --- steps added in a section belong to it -------------------------------- */

await page.getByRole("button", { name: "Add step after this one" }).click();
await page.waitForTimeout(700);
doc = await load();
const mine = stepsOf(doc, mechanicId);
if (mine.length !== 2) fail("adding a step in a section gave it " + mine.length + " steps");
else if (doc.steps[0].id !== firstStep) fail("the first section's step stopped being first");
else if (doc.steps.indexOf(mine[0]) + 1 !== doc.steps.indexOf(mine[1]))
  fail("the mechanic's steps are not contiguous in plan.steps");
else console.log("its steps are contiguous, after the section the plan started with");

/* --- a heading carries its whole block of steps ---------------------------- */

const order = (d) => d.mechanics.map((m) => m.name || "unnamed").join(" | ");
const block = (d) => d.steps.map((s) => d.mechanics.findIndex((m) => m.id === s.mechanic)).join("");
await dragOnto("Witch Hunt", "Mechanic 1");
doc = await load();
if (order(doc) !== "Witch Hunt | unnamed") fail("dragging the heading up gave " + order(doc));
else if (block(doc) !== "001") fail("its steps did not travel with it: " + block(doc));
else console.log("dragging the heading up moved the section and its two steps: " + order(doc));

// The one it displaced is now "Mechanic 2": an unnamed section is named by where
// it is in the fight, so it answers to a different name once it has moved.
await dragOnto("Witch Hunt", "Mechanic 2");
doc = await load();
if (order(doc) !== "unnamed | Witch Hunt") fail("dragging it back down gave " + order(doc));
else if (block(doc) !== "011") fail("the blocks did not follow back: " + block(doc));
else console.log("and back down again, blocks and all");

/* --- a cast inside the section, so the variant has something to copy ------- */

await page.getByRole("button", { name: "1. Step 1" }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "New mech here" }).click();
await page.waitForTimeout(600);
await page
  .locator("div", { hasText: /^Donut$/ })
  .last()
  .dragTo(page.locator("div", { hasText: /^Party$/ }).last());
await page.waitForTimeout(1100);
if (!(await page.getByText("Donut ×8", { exact: true }).count()))
  fail("the open cast's Party set is missing from the group card");
await page.getByRole("button", { name: "done filling" }).click();
await page.waitForTimeout(300);
doc = await load();
const mechId = doc.mechs[0]?.id;
const donuts = doc.entities.filter((e) => e.mech === mechId);
if (donuts.length !== 8) fail("the cast in the section holds " + donuts.length + " shapes");
else console.log("a cast with eight donuts snapshots in the section's first step");
if (await page.getByText("Donut ×8", { exact: true }).count())
  fail("the closed cast's Party set leaked into the unscoped group card");
await page.locator(`[data-mech="${mechId}"]`).click();
await page.waitForTimeout(200);
if (!(await page.getByText("Donut ×8", { exact: true }).count()))
  fail("the Party set did not return when its cast was selected again");
else console.log("group-card sets follow the cast currently selected");
await page.getByRole("button", { name: "done filling" }).click();

/* --- another reading of the mechanic copies nothing ----------------------- */

const sharedBefore = stepsOf(doc, mechanicId).length;
await page.getByTitle(/Another way this mechanic goes/).click();
await page.waitForTimeout(900);
doc = await load();
const witchHunt = () => doc.mechanics.find((m) => m.id === mechanicId);
const variants = witchHunt().variants;
const [A, B] = variants.map((v) => v.id);
if (variants.length !== 2) fail("the first + gave " + variants.length + " readings, expected A and B");
else if (stepsOf(doc, mechanicId).length !== sharedBefore)
  fail("adding a reading copied steps: " + stepsOf(doc, mechanicId).length + " now");
else if (doc.mechs.length !== 1) fail("adding a reading copied the cast: " + doc.mechs.length + " casts");
else console.log("the first + gave the mechanic two readings, its two steps shared by both");

/* --- F2 on the pill renames the reading you are playing -------------------- */

await page.getByRole("button", { name: "B", exact: true }).click();
await page.waitForTimeout(500);
await page.keyboard.press("F2");
const vname = page.getByTitle("Rename variant");
await vname.waitFor();
await vname.fill("Far first");
await vname.press("Enter");
await page.waitForTimeout(700);
doc = await load();
if (witchHunt().variants.find((v) => v.id === B)?.name !== "Far first")
  fail("F2 on the pill did not rename the reading");
else console.log('F2 on the pill renamed the reading: "Far first"');

// Emptied, it goes back to being the second reading of the mechanic.
await page.getByRole("button", { name: "Far first", exact: true }).click();
await page.waitForTimeout(400);
await page.keyboard.press("F2");
await vname.waitFor();
await vname.fill("");
await vname.press("Enter");
await page.waitForTimeout(700);
doc = await load();
if (witchHunt().variants.find((v) => v.id === B)?.name) fail("clearing the name did not stick");
else if (!(await page.getByRole("button", { name: "B", exact: true }).count()))
  fail("a nameless second reading is not called B again");
else console.log("cleared, it is B again");

/* --- a cast still drags across its section's rows ------------------------- */

await page.getByRole("button", { name: "A", exact: true }).click();
await page.waitForTimeout(500);
const box = page.getByTitle(/snapshots in step 1, goes off in step 1/);
if (!(await box.count())) fail("no cast box beside the open section's rows");
else {
  const b = await box.boundingBox();
  const target = await page.getByRole("button", { name: "2. Step 2" }).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.75);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  doc = await load();
  const cast = doc.mechs.find((m) => m.id === mechId);
  const rows = stepsOf(doc, mechanicId);
  if (cast.snap !== rows[0].id) fail("dragging the box moved the snapshot too");
  else if (cast.boom !== rows[1].id)
    fail("dragging down inside the section did not carry the explosion to its second step");
  else console.log("dragging the box down the section's rows stretched the cast to step 2");
}

/* --- filling follows the cast's inclusive span, then closes --------------- */

await page.locator(`[data-mech="${mechId}"]`).click();
await page.waitForTimeout(200);
if (!(await page.getByRole("button", { name: "done filling" }).count()))
  fail("selecting the cast did not open it for filling");

await page.getByRole("button", { name: "2. Step 2" }).click();
await page.waitForTimeout(200);
if (!(await page.getByRole("button", { name: "done filling" }).count()))
  fail("the cast was unselected on its explosion boundary step");

await page.getByRole("button", { name: "1. Step 1" }).click();
await page.waitForTimeout(200);
if (!(await page.getByRole("button", { name: "done filling" }).count()))
  fail("the cast was unselected on its snapshot boundary step");

await page.keyboard.press("w");
await page.waitForTimeout(200);
if (!(await selectedRow()).includes("Pull"))
  fail("W did not navigate to the preceding step outside the cast's span");
else if (await page.getByRole("button", { name: "done filling" }).count())
  fail("the cast stayed selected after navigating outside its span");
else console.log("filling stays open on both boundary steps and closes outside the cast's span");

// Return to the cast's section for the remaining reading and timing checks.
await page.keyboard.press("s");
await page.waitForTimeout(200);
if (await page.getByRole("button", { name: "done filling" }).count())
  fail("the cast became selected again after returning to its span");

/* --- a cast is what a reading owns ---------------------------------------- */

/** Carry a cast box onto one of the reading pills, or onto "both". */
async function carryOnto(label) {
  const box = await page.locator(`nav [data-mech="${mechId}"]`).boundingBox();
  // The A pill is always there, so it is where the drag aims first; "both" only
  // appears once a cast is in the hand.
  const anchor = await page.locator("nav [data-variant]").first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2, { steps: 10 });
  const to = await page.getByRole("button", { name: label, exact: true }).boundingBox();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(900);
}

await page.getByRole("button", { name: "A", exact: true }).click();
await page.waitForTimeout(400);
await carryOnto("B");
doc = await load();
if (doc.mechs.find((m) => m.id === mechId)?.variant !== B)
  fail("carrying the cast onto B gave it " + doc.mechs.find((m) => m.id === mechId)?.variant);
else console.log("carrying a cast box onto a reading: it only goes off that way");

/* --- and the rail says so by where the box now sits ------------------------ */

/** The rail's areas, left to right: what happens either way, then each reading. */
const areas = async () =>
  Promise.all(
    (await page.locator("nav [data-area]").all()).map(async (el) => ({
      variant: await el.getAttribute("data-area"),
      name: (await el.innerText()).trim(),
      box: await el.boundingBox(),
    }))
  );

/** Which area a cast's box is standing in, by where it is on screen. */
const areaOf = async (id) => {
  const box = await page.locator(`nav [data-mech="${id}"]`).boundingBox();
  const mid = box.x + box.width / 2;
  return (await areas()).find((a) => mid >= a.box.x - 1 && mid <= a.box.x + a.box.width + 1);
};

const three = await areas();
if (three.map((a) => a.name).join("|") !== "SHARED|A|B")
  fail("the rail's areas are " + three.map((a) => a.name).join("|") + ", expected SHARED|A|B");
else console.log("the rail is three areas: shared, then one per reading");

if ((await areaOf(mechId))?.variant !== B)
  fail("the cast is B's but its box is not in B's area");
else console.log("the box moved into B's area: where it sits is who it is for");

/** How much of the cast is on the floor in a step, in one reading. */
const shapesIn = (stepId, variantId) =>
  page.evaluate(
    async ([id, sid, mid, vid]) => {
      const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
      const mod = await import("/src/shared/schema.ts");
      return mod
        .entitiesForStep(d, sid, undefined, { [mid]: vid })
        .filter((e) => e.shape === "donut").length;
    },
    [planId, stepId, mechanicId, variantId]
  );

const snapStep = doc.mechs.find((m) => m.id === mechId).snap;
const [inA, inB] = [await shapesIn(snapStep, A), await shapesIn(snapStep, B)];
if (inB !== 8) fail("the cast's donuts are not on the floor in B: " + inB);
else if (inA !== 0) fail("the cast still lands in A: " + inA + " donuts");
else console.log("eight donuts in B, none in A, in the very same step");

// And the steps are untouched by any of it: a reading does not own them.
if (stepsOf(doc, mechanicId).length !== 2)
  fail("putting a cast in a reading changed the steps: " + stepsOf(doc, mechanicId).length);
else console.log("the mechanic still has its two steps, both played either way");

await carryOnto("both");
doc = await load();
if (doc.mechs.find((m) => m.id === mechId)?.variant)
  fail("carrying it onto 'both' did not put it back in both readings");
else console.log("carried onto 'both', it goes off whichever way the mechanic goes");

if ((await areaOf(mechId))?.variant !== "")
  fail("back in both readings, the box did not return to the shared area");
else console.log("and its box is back in the shared area");

/** Carry a cast box sideways into an area, holding the row it is already on. */
async function carryInto(variant) {
  const box = await page.locator(`nav [data-mech="${mechId}"]`).boundingBox();
  const to = (await areas()).find((a) => a.variant === (variant ?? ""));
  const y = box.y + box.height - 6;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(to.box.x + to.box.width / 2, y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(900);
}

const spanBefore = (({ snap, boom }) => ({ snap, boom }))(doc.mechs.find((m) => m.id === mechId));
await carryInto(A);
doc = await load();
const moved = doc.mechs.find((m) => m.id === mechId);
if (moved?.variant !== A) fail("dragging the box into A's area gave it " + moved?.variant);
else if (moved.snap !== spanBefore.snap || moved.boom !== spanBefore.boom)
  fail("dragging sideways also re-timed the cast");
else if ((await areaOf(mechId))?.variant !== A) fail("the box did not stay in A's area");
else console.log("dragged sideways into A's area: the cast is A's, timed as it was");

await carryInto(undefined);
doc = await load();
if (doc.mechs.find((m) => m.id === mechId)?.variant)
  fail("dragging it back into the shared area did not put it in both readings");
else console.log("and dragged back into the shared area, it happens either way again");

/* --- a crowded shared area still reaches the far, empty reading ------------ */

// Two casts in the same rows make the shared area two lanes wide. What used to
// go wrong here: the box leaving shared shrank it, every area slid a lane left,
// and the reading you were aiming at was no longer under the pointer.
const rows2 = stepsOf(doc, mechanicId);
await ops({ op: "add_mech", name: "Crowd", snap: rows2[0].id, boom: rows2[1].id });
await page.waitForTimeout(900);
doc = await load();
const second = doc.mechs.find((m) => m.id !== mechId)?.id;
if (!second) fail("the second cast was never added");
await carryInto(B);
doc = await load();
if (doc.mechs.find((m) => m.id === mechId)?.variant !== B)
  fail("with two casts sharing the rows, the box never reached B's area");
else console.log("out of a two-lane shared area and into B, the far empty one");

await ops({ op: "delete_mech", mechId: second });
await ops({ op: "gate_mech", mechId: mechId });
await page.waitForTimeout(900);
doc = await load();

/* --- and where the party stands is the reading's too, quietly ------------- */

const mt = doc.entities.find((e) => e.name === "MT");
const first = stepsOf(doc, mechanicId)[0];
/** Where an entity is drawn in a step, in one reading of its mechanic. */
const drawnIn = (stepId, entityId, variantId) =>
  page.evaluate(
    async ([id, sid, eid, mid, vid]) => {
      const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
      const mod = await import("/src/shared/schema.ts");
      const e = mod.entitiesForStep(d, sid, undefined, { [mid]: vid }).find((x) => x.id === eid);
      return e ? { x: Math.round(e.x), y: Math.round(e.y) } : null;
    },
    [planId, stepId, entityId, mechanicId, variantId]
  );

await page.getByRole("button", { name: "A", exact: true }).click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: "1. Step 1" }).click();
await page.waitForTimeout(500);

const home = await drawnIn(first.id, mt.id, A);
const canvas = page.locator("canvas").first();
const cbox = await canvas.boundingBox();
const scale = cbox.width / 1000;
const onScreen = (p) => ({
  x: cbox.x + cbox.width / 2 + p.x * scale,
  y: cbox.y + cbox.height / 2 + p.y * scale,
});
const from = onScreen(home);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(from.x - 160, from.y - 120, { steps: 14 });
await page.mouse.up();
await page.waitForTimeout(900);

const movedInA = await drawnIn(first.id, mt.id, A);
const stillInB = await drawnIn(first.id, mt.id, B);
doc = await load();
const keys = Object.keys(doc.entities.find((e) => e.id === mt.id).overrides ?? {});
if (Math.hypot(movedInA.x - home.x, movedInA.y - home.y) < 50)
  fail("dragging MT while A was playing did not move it: " + JSON.stringify(movedInA));
else if (stillInB.x !== home.x || stillInB.y !== home.y)
  fail("the move leaked into B: " + JSON.stringify(stillInB) + " vs " + JSON.stringify(home));
else if (!keys.includes(first.id + "@" + A)) fail("the pose is not filed under A: " + keys.join(","));
else
  console.log(
    "MT moved to " + JSON.stringify(movedInA) + " in A and stayed at " +
      JSON.stringify(stillInB) + " in B, same step, nothing asked"
  );

/* --- deleting a reading takes the casts only it had ----------------------- */

// One cast that is B's alone, to watch go.
await carryOnto("B");
doc = await load();
const donutCount = () => doc.entities.filter((e) => e.mech === mechId).length;
if (doc.mechs.find((m) => m.id === mechId)?.variant !== B) fail("the cast is not B's again");

await page.getByRole("button", { name: "B", exact: true }).click();
await page.waitForTimeout(500);
await page.getByTitle("Delete this reading and the casts only it has").click();
await page.waitForTimeout(900);
doc = await load();
const left = stepsOf(doc, mechanicId);
if (witchHunt().variants.length)
  fail("deleting the last-but-one reading left " + witchHunt().variants.length + " behind");
else if (left.length !== 2) fail("deleting B took steps with it: " + left.length + " left");
else if (doc.mechs.length || donutCount())
  fail("deleting B left the cast that was only its: " + doc.mechs.length + " casts");
else console.log("deleting B took the cast that was only B's, and left both steps alone");

/* --- and a mechanic is its steps ------------------------------------------ */

await page.getByTitle("Delete this mechanic and its steps").click();
await page.waitForTimeout(800);
doc = await load();
if (doc.mechanics.length !== 1) fail("the mechanic survived its own delete button");
else if (doc.steps.length !== 1 || doc.steps[0].id !== firstStep)
  fail("deleting the mechanic left " + doc.steps.length + " steps");
else if (doc.mechs.length || doc.entities.some((e) => e.shape === "donut"))
  fail("deleting the mechanic left its cast behind");
else console.log("deleting Witch Hunt took its steps, its cast and its donuts");

/* --- a plan written before any of this loads into one section ------------- */

const old = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "before mechanics", withParty: true }),
});
const oldId = (old.plan ?? old).id;
const oldDoc = await api("/api/plans/" + oldId).then((p) => p.plan ?? p);
// The document as it was stored before the field existed: steps, a cast across
// them, and no `mechanics` at all.
delete oldDoc.mechanics;
oldDoc.steps = [
  { id: oldDoc.steps[0].id, name: "Snapshot", notes: "" },
  { id: "step_legacy2", name: "Resolve", notes: "" },
];
oldDoc.mechs = [
  { id: "mech_legacy", name: "Sunrise", snap: oldDoc.steps[0].id, boom: "step_legacy2" },
];
await api("/api/plans/" + oldId + "/ops", {
  method: "POST",
  body: JSON.stringify({ ops: [{ op: "replace_plan", plan: oldDoc }] }),
});

const hydrated = await api("/api/plans/" + oldId).then((p) => p.plan ?? p);
if (hydrated.mechanics.length !== 1)
  fail("an old plan hydrated into " + hydrated.mechanics.length + " mechanics");
else if (!hydrated.steps.every((s) => s.mechanic === hydrated.mechanics[0].id))
  fail("not every step of the old plan landed in that one mechanic");
else console.log("an old plan hydrates into one section holding the whole fight");

await page.goto(base + "/p/" + oldId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);
if (!(await page.getByTitle("Delete this mechanic and its steps").isVisible()))
  fail("the old plan's section is not open, so its steps are nowhere");
else if (!(await page.getByRole("button", { name: "1. Snapshot" }).isVisible()))
  fail("the old plan's steps are not listed inside the section");
else if (!(await page.getByRole("button", { name: "2. Resolve" }).isVisible()))
  fail("only the first of the old plan's steps is there");
else if (!(await page.getByTitle(/snapshots in step 1, goes off in step 2/).count()))
  fail("the old plan's cast box is not beside the section's rows");
else console.log("its steps and its cast box are inside that one section");

console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
await browser.close();
