/**
 * Walking and reading the fight.
 *
 * W and S walk the steps, and never while you are typing. A step splits into
 * Variant boxes from the rail; the step and the box you are looking at live in
 * the address bar, so a reload or a pasted link lands on the same frame; and a
 * box is deleted from the rail, its sibling becoming Shared. The timeline has
 * three sizes: Normal, Expanded with a column for step notes, and Collapsed —
 * a strip under the arena, which is what a view-only link and a phone open in.
 */
import { fail, finish, floor, gotoStep, menuAt, planName, planNameField, rowMid, session, timelineMode } from "./harness.mjs";

const s = await session("timeline-e2e", { width: 1280, height: 720 });
const { page } = s;
const plan = await s.createPlan({ name: "timeline e2e", withParty: true, variantModel: "step" });
let doc = await plan.load();
await plan.ops([
  { op: "update_step", stepId: doc.steps[0].id, patch: { name: "One", notes: "Tanks north, healers south." } },
  ...["Two", "Three", "Four", "Five"].map((name) => ({ op: "add_step", name })),
]);
doc = await plan.load();
const steps = doc.steps.map((st) => st.id);
if (steps.length !== 5) fail(`expected five steps, got ${steps.length}`);
await plan.ops({ op: "add_mech", id: "mech_timeline", name: "Add cast", snap: steps[0], boom: steps[4] });
await s.openPlan(plan.id);
const f = await floor(page);
const param = (key) => new URL(page.url()).searchParams.get(key);
const rail = page.locator("nav");
const strip = page.locator("[data-timeline-strip]");

/* --- W and S walk the steps, and not while you type ------------------------ */

if ((await rail.count()) !== 1 || (await strip.count())) fail("an editable plan on a 1280px window did not open with the rail");
/** The step the rail says you are on: a row is its 1-based number. */
const on = async () => (await page.locator("nav [data-step][aria-current]").innerText()).trim();
const press = async (key, times) => {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(350);
  }
};
// The canvas has the focus, as it would after clicking about on the floor.
await f.deselect();
await press("s", 2);
if ((await on()) !== "3") fail(`S twice landed on step ${await on()}`);
await press("w", 4);
if ((await on()) !== "1") fail(`W past the first step went to ${await on()}`);
const field = await planNameField(page);
await field.click();
await field.fill("");
await field.type("swad");
await page.waitForTimeout(400);
if ((await on()) !== "1") fail(`typing in the plan name walked the rail to step ${await on()}`);
console.log(`S and W walk the steps and stop at the first; "${await planName(page)}" typed in a field walks nothing`);
await field.press("Enter");

/* --- a step splits into boxes, and the frame lives in the link -------------- */

await menuAt(page, await rowMid(page, 3), "Add Variant here");
doc = await plan.load();
const variants = doc.steps[2].variants ?? [];
if (variants.length !== 2) fail(`"Add Variant here" split step 3 into ${variants.length} boxes`);
const pick = variants[1].id;
await gotoStep(page, 3);
await page.locator(`[data-step-variant="${pick}"]`).click();
await page.waitForTimeout(400);
const link = page.url();
if (param("step") !== steps[2] || param("v") !== `${steps[2]}:${pick}`)
  fail("looking at the second box did not write it into the link: " + new URL(link).search);
const landsOnFrame = async (p) => {
  await p.waitForSelector("canvas");
  await p.waitForTimeout(1200);
  const onStep = await p.locator(`[data-step="${steps[2]}"][aria-current="step"]`).count();
  const pressed = await p.locator(`[data-step-variant="${pick}"] button`).first().getAttribute("aria-pressed");
  return onStep > 0 && pressed === "true";
};
await page.reload();
if (!(await landsOnFrame(page))) fail("F5 did not land back on step 3 with the second box on screen");
const tab = await s.context.newPage();
await tab.goto(link);
if (!(await landsOnFrame(tab))) fail("a fresh tab opening the link did not land on the same frame");
await tab.close();
console.log("the second box of step 3 is in the link: F5 and a fresh tab both land on it");

/* --- a box is deleted from the rail, and its sibling becomes Shared --------- */

const destination = page.locator("[data-edit-destination]");
await page.locator(`[data-step-variant="${pick}"]`).click();
await page.waitForTimeout(300);
const label = await page.locator(`[data-step-variant="${pick}"] [aria-pressed]`).getAttribute("aria-label");
if (!(await destination.textContent()).includes(label))
  fail("clicking a box did not make it the edit destination: " + (await destination.textContent()));
page.once("dialog", (dialog) => dialog.accept());
await page.keyboard.press("Delete");
await page.waitForFunction((id) => !document.querySelector(`[data-step-variant="${id}"]`), pick);
doc = await plan.load();
if ((doc.steps[2].variants ?? []).length) fail("Delete on a selected box did not end the split");
if (await page.locator("[data-step-variant]").count()) fail("the rail still shows a Variant box after the split ended");
console.log("Delete on a selected box, confirmed, ended the split: step 3 is one Shared step again");

/* --- Collapsed turns the rail into a strip under the arena ----------------- */

await timelineMode(page, "collapsed");
if (await rail.count()) fail("Collapsed left the rail on screen");
if ((await strip.count()) !== 1) fail("Collapsed put no strip under the arena");
if (await page.locator('[data-panel="palette"]').count()) fail("Collapsed left the Add palette up");
await page.locator(`[data-strip-step="${steps[1]}"]`).click();
await page.waitForTimeout(400);
if (param("step") !== steps[1]) fail(`tapping pill 2 left the view on step=${param("step")}`);
await page.locator('[data-strip-beat="mech_timeline"]').click();
await page.waitForTimeout(500);
if (param("mech") !== "mech_timeline" || param("step") !== steps[0])
  fail("tapping the Beat's bar did not open it on the step it casts in");
if (!(await page.locator("[data-strip-note]").innerText()).includes("Tanks north")) fail("the strip does not carry step 1's note");
console.log("Collapsed: a pill walks the fight, a bar opens its Beat, and the note reads under them");
await timelineMode(page, "normal");
if ((await rail.count()) !== 1 || (await strip.count())) fail("Normal did not put the rail back");

/* --- Expanded gives the rows room, and the notes a column ------------------ */

await page.setViewportSize({ width: 1600, height: 950 });
await page.waitForTimeout(400);
const rowHeight = async () => Math.round((await page.locator(`[data-row="${steps[0]}"]`).boundingBox()).height);
const clickRow = async (id) => {
  const r = await page.locator(`[data-row="${id}"]`).boundingBox();
  await page.mouse.click(r.x + 12, r.y + r.height / 2);
  await page.waitForTimeout(500);
};
if ((await rowHeight()) !== 28) fail(`Normal rows are ${await rowHeight()}px, not 28`);
await timelineMode(page, "expanded");
if ((await rowHeight()) !== 40) fail(`Expanded rows are ${await rowHeight()}px, not 40`);
await clickRow(steps[3]);
const cell = page.locator(`[data-note-cell="${steps[3]}"]`);
if (!(await cell.count())) fail("the selected row has no note cell to write in");
await cell.click();
await page.waitForTimeout(300);
await page.keyboard.type("Bait the ring on the outer edge.");
await clickRow(steps[0]);
await page.waitForTimeout(400);
if ((await plan.load()).steps[3].notes !== "Bait the ring on the outer edge.") fail("the note written in its cell did not save");
await timelineMode(page, "normal");
if ((await rowHeight()) !== 28) fail(`back in Normal rows are ${await rowHeight()}px`);
if (!(await page.locator(`[data-note-dot="${steps[3]}"]`).count())) fail("in Normal the step with a note shows no dot");
console.log("Expanded: 40px rows and a note cell that saves; back in Normal the note is a dot by its number");

/* --- a link you can only read opens collapsed, on a laptop and on a phone --- */

await s.api.post(`/api/plans/${plan.id}/public`, { isPublic: true });
const viewer = await session(null, { browser: s.browser, width: 1280, height: 720 });
await viewer.openPlan(plan.id, 1400);
if (await viewer.page.locator("nav").count()) fail("a view-only link opened with the rail up");
if (!(await viewer.page.locator("[data-timeline-strip]").count())) fail("a view-only link opened without the strip");
const phone = await session("timeline-e2e", { browser: s.browser, width: 390, height: 844 });
await phone.openPlan(plan.id, 1400);
if (await phone.page.locator("nav").count()) fail("a 390px window kept the rail");
if (!(await phone.page.locator("[data-timeline-strip]").count())) fail("a 390px window has no strip");
if (!(await phone.page.locator('[data-strip-walk="next"]').count())) fail("a 390px window has no prev/next under the strip");
console.log("a view-only link opens collapsed, and so does a phone, with prev/next under the strip");

await finish(s, "OK - " + plan.url);
