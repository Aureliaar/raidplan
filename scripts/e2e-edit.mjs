/**
 * Editing with the keyboard, and taking it back.
 *
 * Copy and paste make an offset twin that keeps everything authored on it,
 * and copying a source brings the bait it throws; Delete removes what is
 * selected; none of it fires while you are typing in a field. Every edit lands
 * on a persistent history: Undo and Redo paint the snapshot they already know
 * before the server answers, Ctrl+Z and Ctrl+Y drive the same stack, and the
 * History drawer names who made the edits.
 */
import { fail, finish, floor, planName, planNameField, session } from "./harness.mjs";

const s = await session("edit-e2e");
const { page } = s;
const plan = await s.createPlan({ name: "edit e2e" });
const puddle = (
  await plan.ops({ op: "add_entity", spec: { type: "zone", shape: "circle", radius: 120, name: "puddle", x: -250, y: 0 } })
).values[0].id;
let doc = await plan.load();
await plan.ops({
  op: "update_entity",
  id: puddle,
  stepId: doc.steps[0].id,
  patch: { radius: 150, rotation: 23, scale: 1.25, opacity: 0.7, notes: "retain me" },
});
await s.openPlan(plan.id);
const f = await floor(page);
const copyPaste = async () => {
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(700);
};

/* --- copy and paste make a twin that keeps what was authored on it -------- */

await f.click(-250, 0);
// Hex entry is a step-scoped edit: copying the raw base entity would lose it.
const hex = page.getByLabel("Hex colour");
await hex.fill("0af");
await hex.press("Enter");
await page.waitForTimeout(600);
await copyPaste();
doc = await plan.load();
const twins = doc.entities.filter((e) => e.name === "puddle");
if (twins.length !== 2) fail(`Ctrl+V made ${twins.length - 1} copies`);
const pasted = twins[1];
if (Math.hypot(pasted.x + 190, pasted.y - 60) > 2) fail(`the paste landed at ${pasted.x},${pasted.y}, not 60 units off`);
if (pasted.color !== "#00aaff") fail("the paste lost its colour, becoming " + pasted.color);
if (
  pasted.radius !== 150 ||
  pasted.rotation !== 23 ||
  pasted.scale !== 1.25 ||
  pasted.opacity !== 0.7 ||
  pasted.notes !== "retain me"
)
  fail("the paste lost authored properties: " + JSON.stringify(pasted));
// Paste selects the twin, so Delete takes it and only it.
await page.keyboard.press("Delete");
await page.waitForTimeout(600);
doc = await plan.load();
if (doc.entities.filter((e) => e.name === "puddle").map((e) => e.id).join() !== puddle)
  fail("Delete did not remove exactly the pasted twin");
console.log("Ctrl+C, Ctrl+V: a twin 60 units off in #00aaff with every authored field, and Delete took just it");

/* --- copying a source brings the bait it throws ---------------------------- */

const boss = (
  await plan.ops({
    op: "add_entity",
    // Clear of every party token: R2 stands at (247, -247).
    spec: { type: "enemy", name: "clipboard boss", x: 150, y: -100, size: 70, color: "#cc3355" },
  })
).values[0].id;
await plan.ops({
  op: "add_entity",
  spec: {
    type: "zone",
    shape: "rect",
    name: "clipboard beam",
    width: 70,
    length: 400,
    color: "#cc3355",
    anchor: { from: boss, to: puddle },
  },
});
await page.waitForTimeout(650);
await f.click(150, -100);
await copyPaste();
doc = await plan.load();
const copiedBoss = doc.entities.find((e) => e.name === "clipboard boss" && e.id !== boss);
const copiedBeam = doc.entities.find((e) => e.name === "clipboard beam" && e.anchor?.from !== boss);
if (!copiedBoss || !copiedBeam) fail("copying the boss did not bring the beam it throws");
if (copiedBoss.x !== 210 || copiedBoss.y !== -40) fail(`the copied boss landed at ${copiedBoss.x},${copiedBoss.y}`);
if (copiedBeam.anchor.from !== copiedBoss.id || copiedBeam.anchor.to !== puddle)
  fail("the copied beam is not thrown from the copied boss: " + JSON.stringify(copiedBeam.anchor));
console.log("copying a boss copied the beam it throws, re-aimed from the copy");

/* --- and none of it fires while you type ----------------------------------- */

const count = doc.entities.length;
const name = await planNameField(page);
await name.click();
await name.press("Backspace");
await page.waitForTimeout(400);
if ((await plan.load()).entities.length !== count) fail("Backspace in the plan name deleted an entity");
console.log("Backspace in the plan name is a letter, not a delete");

/* --- every edit can be taken back, and is painted before the server answers */

await name.press("Escape");
await f.deselect();
const was = (await plan.load()).name;
const rename = await planNameField(page);
await rename.fill("instant revision");
await rename.press("Tab");
await page
  .waitForFunction(
    async (id) => (await fetch(`/api/plans/${id}`).then((r) => r.json())).plan.name === "instant revision",
    plan.id,
    { timeout: 5000 }
  )
  .catch(() => fail("renaming the plan in its header did not save"));

/** Hold the next undo or redo request for half a second; `settled` resolves when it lands. */
const slow = async (verb) => {
  await page.route(
    `**/api/plans/${plan.id}/history/${verb}`,
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    },
    { times: 1 }
  );
  return { settled: page.waitForResponse((r) => r.url().endsWith(`/api/plans/${plan.id}/history/${verb}`)) };
};
let held = await slow("undo");
await page.getByTitle("Undo (Ctrl+Z)").click();
await page.waitForTimeout(50);
if ((await planName(page)) !== was) fail(`Undo waited for the server before painting: ${await planName(page)}`);
await held.settled;
held = await slow("redo");
await page.getByTitle("Redo (Ctrl+Y or Ctrl+Shift+Z)").click();
await page.waitForTimeout(50);
if ((await planName(page)) !== "instant revision") fail(`Redo waited for the server before painting: ${await planName(page)}`);
await held.settled;
console.log("Undo and Redo paint the snapshot they know before the server round trip");

await f.deselect();
await page.keyboard.press("Control+z");
await page.waitForTimeout(500);
if ((await plan.load()).name !== was) fail("Ctrl+Z did not undo the rename");
await page.keyboard.press("Control+y");
await page.waitForTimeout(500);
if ((await plan.load()).name !== "instant revision") fail("Ctrl+Y did not redo the rename");
await page.getByRole("button", { name: "History" }).click();
await page.getByText("Revision history").waitFor();
if (!(await page.locator("aside").getByText("edit-e2e", { exact: true }).first().isVisible()))
  fail("the History drawer does not name who made the edits");
console.log("Ctrl+Z and Ctrl+Y drive the same stack, and the History drawer names the session");

await finish(s, "OK - " + plan.url);
