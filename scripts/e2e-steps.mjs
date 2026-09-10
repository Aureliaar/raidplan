/**
 * Steps, and the mechanics that own them.
 *
 * A step is a delta, not a snapshot: moving somebody in one step moves them in
 * every later step of the same mechanic that has not said otherwise, and a new
 * mechanic opens with everybody back at their base pose. Steps are added,
 * copied and deleted from a row's right-click menu; a mechanic is a section of
 * the rail, renamed where it sits, that takes its steps with it when it goes.
 */
import { drag, fail, finish, floor, gotoStep, konvaNode, rowMenu, session } from "./harness.mjs";

const s = await session("steps-e2e");
const { page } = s;
page.on("dialog", (dialog) => dialog.accept());
const plan = await s.createPlan({ name: "steps e2e", withParty: true });
await s.openPlan(plan.id);
const f = await floor(page);

/* --- a row's menu adds, copies and deletes steps --------------------------- */

await rowMenu(page, 1, "Add step after");
await rowMenu(page, 1, "Duplicate step");
await rowMenu(page, 3, "Add step after");
let doc = await plan.load();
if (doc.steps.length !== 4) fail(`adding, duplicating and adding again gave ${doc.steps.length} steps, not 4`);
await rowMenu(page, 4, "Delete step");
doc = await plan.load();
if (doc.steps.length !== 3) fail(`deleting the last step left ${doc.steps.length}, not 3`);
console.log("a row's menu added, duplicated and deleted steps: three left");
const steps = doc.steps.map((st) => st.id);

/* --- a move carries forward into the steps that say nothing ---------------- */

const mt = doc.entities.find((e) => e.name === "MT");
await gotoStep(page, 2);
await drag(page, await f.nodeAt(mt.id), f.screen(-120, 180));
doc = await plan.load();
const moved = doc.entities.find((e) => e.id === mt.id);
const said = moved.overrides?.[steps[1]];
if (!said) fail("dragging MT in step 2 declared nothing there");
if (moved.overrides?.[steps[2]]) fail("dragging MT in step 2 also wrote step 3");
await gotoStep(page, 3);
const here = await konvaNode(page, mt.id);
if (!here || Math.hypot(here.x - said.x, here.y - said.y) > 2)
  fail(`step 3 draws MT at ${JSON.stringify(here)} instead of inheriting step 2's ${JSON.stringify(said)}`);
console.log("MT dragged in step 2 is still there in step 3, which says nothing about them");

/* --- a mechanic is a section of the rail ----------------------------------- */

await page.getByRole("button", { name: "New mechanic" }).click();
await page.waitForTimeout(900);
doc = await plan.load();
if (doc.mechanics.length !== 2) fail(`New mechanic left ${doc.mechanics.length} mechanics`);
const section = doc.mechanics[1].id;
const across = await konvaNode(page, mt.id);
if (!across || Math.hypot(across.x - mt.x, across.y - mt.y) > 2)
  fail(`the new mechanic inherited MT across the boundary: ${JSON.stringify(across)}, not base ${mt.x},${mt.y}`);
console.log("New mechanic opened a second section, with MT back at their base pose");

await page.getByRole("button", { name: "Mechanic 2" }).click();
await page.keyboard.press("F2");
const heading = page.getByTitle("Rename mechanic");
await heading.waitFor();
await heading.fill("Witch Hunt");
await heading.press("Enter");
await page.waitForTimeout(600);
await rowMenu(page, "current", "Add step after");
doc = await plan.load();
if (doc.mechanics[1].name !== "Witch Hunt") fail(`F2 on the heading named it ${JSON.stringify(doc.mechanics[1].name)}`);
const inSection = doc.steps.filter((st) => st.mechanic === section);
if (inSection.length !== 2) fail(`adding a step inside Witch Hunt gave it ${inSection.length} steps`);
console.log('F2 on the heading renamed it "Witch Hunt", and its row menu adds steps inside it');

await page.getByTitle("Delete this mechanic and its steps").click();
await page.waitForTimeout(800);
doc = await plan.load();
if (doc.mechanics.length !== 1 || doc.steps.length !== 3)
  fail(`deleting Witch Hunt left ${doc.mechanics.length} mechanics and ${doc.steps.length} steps`);
console.log("deleting Witch Hunt took both of its steps with it");

await finish(s, "OK - " + plan.url);
