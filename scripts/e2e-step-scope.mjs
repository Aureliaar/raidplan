/**
 * Every Part lives in a Beat. A drop with nothing open makes a Beat for it in
 * the step it was dropped in; a drop with a Beat open joins that Beat; and a
 * Beat carried onto another Beat's box folds into it.
 *
 *   node scripts/e2e-step-scope.mjs http://localhost:59577
 */
import { chromium } from "playwright";
import { viewScale } from "./view.mjs";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };

await page.goto(base + "/auth/dev?name=scope-e2e");
const api = (path, init = {}) =>
  page.evaluate(async ([p, i]) => {
    const r = await fetch(p, { ...i, headers: { "content-type": "application/json", ...(i.headers ?? {}) } });
    const t = await r.text();
    if (!r.ok) throw new Error(p + " -> " + r.status + " " + t.slice(0, 200));
    return t ? JSON.parse(t) : null;
  }, [path, init]);

const created = await api("/api/plans", { method: "POST", body: JSON.stringify({ name: "scope e2e", withParty: true }) });
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);
const canvas = page.locator("canvas").first();
const chip = (label) => page.locator("div", { hasText: new RegExp("^" + label + "$") }).last();
async function at(x, y) {
  const box = await canvas.boundingBox();
  const s = viewScale(box.width);
  return { x: box.width / 2 + x * s, y: box.height / 2 + y * s };
}
async function dropOnFloor(label, x, y) {
  await chip(label).dragTo(canvas, { targetPosition: await at(x, y) });
  await page.waitForTimeout(500);
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + 8, box.y + 8);
  await page.waitForTimeout(150);
}
const selectedCount = () => page.evaluate(() => window.Konva.stages[0].find(".selection").length);
const gotoStep = async (n) => {
  await page.getByRole("button", { name: new RegExp("^" + n + "\\. ") }).click();
  await page.waitForTimeout(300);
};

// Two steps, then back on step 1.
await page.getByRole("button", { name: "Add step after this one" }).click();
await page.waitForTimeout(500);
let doc = await load();
const [s1, s2] = doc.steps.map((s) => s.id);
await gotoStep(1);

/* --- a drop with nothing open makes a Beat in this step ------------------- */

await dropOnFloor("Circle", -150, 20);
doc = await load();
const first = doc.entities.find((e) => e.type === "zone");
const beatA = first && doc.mechs.find((m) => m.id === first.mech);
if (!first) fail("no circle was dropped");
else if (!beatA) fail("the dropped circle is in no Beat: " + JSON.stringify([first.mech, first.steps]));
else if (beatA.snap !== s1 || beatA.boom !== s1) fail("the new Beat does not span the drop step: " + JSON.stringify([beatA.snap, beatA.boom]));
else if (doc.mechs.length !== 1) fail("expected one Beat, got " + doc.mechs.length);
else if (beatA.name !== "Circle") fail("the new Beat is named " + JSON.stringify(beatA.name) + " instead of after the drop");
else console.log("a drop with nothing open made a Beat for itself in this step, named after the drop");

// The floor agrees: on it in step 1, gone in step 2.
await gotoStep(2);
await canvas.click({ position: await at(-150, 20) });
await page.waitForTimeout(200);
if (await selectedCount()) fail("the step-1 Part was selectable on step 2");
else console.log("the Part is not on the floor in step 2");
await gotoStep(1);
await canvas.click({ position: await at(-150, 20) });
await page.waitForTimeout(200);
if (!(await selectedCount())) fail("the Part was not selectable on step 1");
else console.log("the Part is on the floor in step 1");
const box = await canvas.boundingBox();
await page.mouse.click(box.x + 8, box.y + 8);
await page.waitForTimeout(150);

/* --- a drop with a Beat open joins it -------------------------------------- */

// The drop opened its Beat; open it again by its box and drop into it.
await page.locator(`[data-mech="${beatA.id}"]`).click();
await page.waitForTimeout(300);
await dropOnFloor("Circle", 150, 20);
doc = await load();
const zones = doc.entities.filter((e) => e.type === "zone");
if (zones.length !== 2) fail("expected two circles, got " + zones.length);
else if (!zones.every((z) => z.mech === beatA.id)) fail("the second drop did not join the open Beat: " + JSON.stringify(zones.map((z) => z.mech)));
else if (doc.mechs.length !== 1) fail("a drop into an open Beat made a Beat of its own");
else console.log("a drop with a Beat open joins that Beat");

/* --- a Beat carried onto another Beat folds into it ------------------------ */

// Close the open Beat by clicking its box, then a drop in step 2 makes Beat B.
await page.locator(`[data-mech="${beatA.id}"]`).click();
await page.waitForTimeout(300);
await gotoStep(2);
await dropOnFloor("Circle", 0, -150);
doc = await load();
const beatB = doc.mechs.find((m) => m.id !== beatA.id);
if (!beatB) fail("no second Beat was made in step 2");
else if (beatB.snap !== s2) fail("the second Beat is not in step 2");
else console.log("a drop in step 2 made a second Beat there");

if (beatB) {
  // Close B so the drag starts from a closed box, like a user reaching for it.
  await page.locator(`[data-mech="${beatB.id}"]`).click();
  await page.waitForTimeout(200);
  const from = await page.locator(`[data-mech="${beatB.id}"]`).boundingBox();
  const to = await page.locator(`[data-mech="${beatA.id}"]`).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 10, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(700);
  doc = await load();
  const merged = doc.mechs.find((m) => m.id === beatA.id);
  const all = doc.entities.filter((e) => e.type === "zone");
  if (doc.mechs.length !== 1 || !merged) fail("the Beats did not merge: " + JSON.stringify(doc.mechs.map((m) => [m.id, m.snap, m.boom])));
  else if (!all.every((z) => z.mech === beatA.id)) fail("a Part was left behind by the merge: " + JSON.stringify(all.map((z) => z.mech)));
  else if (merged.snap !== s1 || merged.boom !== s2) fail("the merged Beat does not cover both spans: " + JSON.stringify([merged.snap, merged.boom]));
  else console.log("a Beat dropped on another Beat folded into it and the span grew to cover both");

  // The merged Beat is on the floor in both steps: the step-2 circle now shows in step 1.
  await gotoStep(1);
  await canvas.click({ position: await at(0, -150) });
  await page.waitForTimeout(200);
  if (!(await selectedCount())) fail("the merged Part is not on the floor in step 1");
  else console.log("the merged Beat times every Part it holds");
}

await browser.close();
console.log(process.exitCode ? "FAILED" : "OK");
