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

/** How many set rows the Groups popover shows for a label right now. */
const groupSets = async (text) => {
  // The sets a group carries live in the Groups popover on the Add panel, and
  // the Add panel is only up when nothing is selected — so put the selection
  // down first, exactly as a person would before going to look.
  const cb = await page.locator("canvas").first().boundingBox();
  await page.mouse.click(cb.x + 8, cb.y + 8);
  await page.waitForTimeout(250);
  await page.getByRole("button", { name: "Groups" }).click();
  await page.waitForTimeout(250);
  const seen = await page.getByText(text, { exact: true }).count();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  return seen;
};

/**
 * The step the rail has selected, which is the step the canvas draws. Rows
 * carry only their number now, so the row is asked for its step's id.
 */
const selectedRow = () =>
  page.locator('nav button[data-step][aria-current="step"]').first().getAttribute("data-step");
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
/** The rail's row menu: right-click the row you are on and take an item. */
const onCurrentRow = async (item) => {
  const r = await page.locator('[data-current="true"]').boundingBox();
  await page.mouse.click(r.x + 12, r.y + r.height / 2, { button: "right" });
  await page.locator("[data-context-menu]").first().waitFor({ state: "visible", timeout: 3000 });
  await page.locator(`[data-menu-item="${item}"]`).click();
};

await onCurrentRow("Add step after");
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

await page.getByRole("button", { name: "Step 1", exact: true }).click({ position: { x: 12, y: 14 } });
await page.waitForTimeout(300);
await page.getByRole("button", { name: "New Beat here" }).click();
await page.waitForTimeout(600);
await page
  .locator("div", { hasText: /^Donut$/ })
  .last()
  .dragTo(page.locator("div", { hasText: /^Party$/ }).last());
await page.waitForTimeout(1100);
if (!(await groupSets("Donut ×8")))
  fail("the open cast's Party set is missing from the Groups popover");
await page.getByRole("button", { name: "done editing Beat" }).click();
await page.waitForTimeout(300);
doc = await load();
const mechId = doc.mechs[0]?.id;
const donuts = doc.entities.filter((e) => e.mech === mechId);
if (donuts.length !== 8) fail("the cast in the section holds " + donuts.length + " shapes");
else console.log("a cast with eight donuts snapshots in the section's first step");
if (await groupSets("Donut ×8"))
  fail("the closed cast's Party set leaked into the unscoped Groups popover");
await page.locator(`[data-mech="${mechId}"]`).click();
await page.waitForTimeout(200);
if (!(await groupSets("Donut ×8")))
  fail("the Party set did not return when its cast was selected again");
else console.log("group sets follow the cast currently selected");
await page.getByRole("button", { name: "done editing Beat" }).click();

/* --- a cast still drags across its section's rows ------------------------- */

const box = page.getByTitle(/casts in step 1, resolves in step 1/);
if (!(await box.count())) fail("no cast box beside the open section's rows");
else {
  const b = await box.boundingBox();
  const target = await page.getByRole("button", { name: "Step 2", exact: true }).boundingBox();
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

// Pressing on the box opened it, and the drag left it open; a click on an
// open Beat closes it, so only reach for it when it is closed.
if (!(await page.getByRole("button", { name: "done editing Beat" }).count())) {
  await page.locator(`[data-mech="${mechId}"]`).click();
  await page.waitForTimeout(200);
}
if (!(await page.getByRole("button", { name: "done editing Beat" }).count()))
  fail("selecting the cast did not open it for filling");

await page.getByRole("button", { name: "Step 2", exact: true }).click({ position: { x: 12, y: 14 } });
await page.waitForTimeout(200);
if (!(await page.getByRole("button", { name: "done editing Beat" }).count()))
  fail("the cast was unselected on its explosion boundary step");

await page.getByRole("button", { name: "Step 1", exact: true }).click({ position: { x: 12, y: 14 } });
await page.waitForTimeout(200);
if (!(await page.getByRole("button", { name: "done editing Beat" }).count()))
  fail("the cast was unselected on its snapshot boundary step");

await page.keyboard.press("w");
await page.waitForTimeout(200);
if ((await selectedRow()) !== doc.steps.find((s) => s.name === "Pull")?.id)
  fail("W did not navigate to the preceding step outside the cast's span");
else if (await page.getByRole("button", { name: "done editing Beat" }).count())
  fail("the cast stayed selected after navigating outside its span");
else console.log("filling stays open on both boundary steps and closes outside the cast's span");

// Return to the cast's section for the remaining checks.
await page.keyboard.press("s");
await page.waitForTimeout(200);
if (await page.getByRole("button", { name: "done editing Beat" }).count())
  fail("the cast became selected again after returning to its span");

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
await api("/api/plans/" + oldId + "/import", {
  method: "POST",
  body: JSON.stringify({ plan: oldDoc }),
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
else if (!(await page.getByRole("button", { name: "Step 1", exact: true }).isVisible()))
  fail("the old plan's steps are not listed inside the section");
else if (!(await page.getByRole("button", { name: "Step 2", exact: true }).isVisible()))
  fail("only the first of the old plan's steps is there");
else if (!(await page.getByTitle(/casts in step 1, resolves in step 2/).count()))
  fail("the old plan's cast box is not beside the section's rows");
else console.log("its steps and its cast box are inside that one section");

console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
await browser.close();
