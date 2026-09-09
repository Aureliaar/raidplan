/**
 * A step is a delta, not a snapshot.
 *
 * Moving somebody in one step moves them in every step after it that has not
 * said otherwise, until the mechanic ends. And what a step may say is only
 * where an actor stands and what they are drawn as: a person's size and a
 * Part's geometry belong to the person and to the Beat, so editing either in
 * step scope edits the thing itself rather than filing a per-step exception.
 *
 *   node scripts/e2e-inheritance.mjs http://localhost:59577
 */
import { chromium } from "playwright";
import { viewScale } from "./view.mjs";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=inherit-e2e");
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
  body: JSON.stringify({ name: "inheritance e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

const canvas = page.locator("canvas").first();
const chip = (label) => page.locator("div", { hasText: new RegExp("^" + label + "$") }).last();
let box = await canvas.boundingBox();
let scale = viewScale(box.width);
const remeasure = async () => {
  box = await canvas.boundingBox();
  scale = viewScale(box.width);
};
const screen = (x, y) => ({ x: box.x + box.width / 2 + x * scale, y: box.y + box.height / 2 + y * scale });
const inCanvas = (x, y) => ({ x: box.width / 2 + x * scale, y: box.height / 2 + y * scale });
const gotoStep = async (n) => {
  // The gutter, not the middle: a row spans the lanes, and a Beat card sits on top of it.
  await page.getByRole("button", { name: `Step ${n}`, exact: true }).click({ position: { x: 12, y: 14 } });
  await page.waitForTimeout(350);
};
/** Where the canvas actually draws something, in arena units. */
const drawnAt = (id) =>
  page.evaluate((entityId) => {
    const node = window.Konva.stages[0].findOne("#" + entityId);
    return node ? { x: node.x(), y: node.y() } : null;
  }, id);
/** The rail's row menu: right-click the row you are on and take an item. */
const onCurrentRow = async (item) => {
  const r = await page.locator('[data-current="true"]').boundingBox();
  await page.mouse.click(r.x + 12, r.y + r.height / 2, { button: "right" });
  await page.locator("[data-context-menu]").first().waitFor({ state: "visible", timeout: 3000 });
  await page.locator(`[data-menu-item="${item}"]`).click();
};

// Spread the party so every token is its own target.
await page.getByRole("button", { name: "PF positions" }).click();
await page.waitForTimeout(600);
for (const _ of [1, 2]) {
  await onCurrentRow("Add step after");
  await page.waitForTimeout(500);
}
await remeasure();

let doc = await load();
const steps = doc.steps.map((s) => s.id);
if (steps.length !== 3) fail("expected three steps, got " + steps.length);
const mt = doc.entities.find((e) => e.name === "MT");
const start = mt.overrides?.[steps[0]] ?? mt;

/* --- a move carries forward into the steps that say nothing --------------- */

await gotoStep(2);
await remeasure();
const from = screen(start.x, start.y);
const to = screen(-120, 180);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(700);

doc = await load();
const moved = doc.entities.find((e) => e.id === mt.id);
const said = moved.overrides?.[steps[1]];
if (!said) fail("dragging MT in step 2 declared nothing there");
else if (moved.overrides?.[steps[2]]) fail("dragging MT in step 2 also wrote step 3");
else console.log("the drag is one declaration, in the step it happened in");

await gotoStep(3);
await page.waitForTimeout(400);
const here = await drawnAt(mt.id);
if (!here) fail("MT is not drawn in step 3 at all");
else if (Math.hypot(here.x - said.x, here.y - said.y) > 2)
  fail("step 3 draws MT at " + JSON.stringify(here) + " instead of inheriting " + JSON.stringify(said));
else console.log("step 3 says nothing, so MT is still where step 2 left them");

/* --- the wheel sizes the whole party, and sizes the person, not the step --- */

await gotoStep(2);
await remeasure();
doc = await load();
const sizeBefore = doc.entities.find((e) => e.type === "player").size;
const dps = doc.entities.find((e) => e.name === "M1");
const pose = await drawnAt(dps.id);
if (!pose) fail("M1 is not on the floor in step 2");
await page.mouse.move(...Object.values(screen(pose.x, pose.y)));
await page.mouse.wheel(0, -120);
await page.waitForTimeout(700);

doc = await load();
const party = doc.entities.filter((e) => e.type === "player");
const want = Math.round(sizeBefore * 1.08);
if (!party.every((p) => Math.abs(p.size - want) <= 1))
  fail("the wheel over one DPS left the party at " + party.map((p) => p.name + ":" + p.size).join(" "));
else if (party.some((p) => steps.some((s) => "size" in (p.overrides?.[s] ?? {}))))
  fail("sizing somebody wrote a per-step size");
else
  console.log(
    "one notch over a DPS sized the whole party, on the people rather than the step: " +
      sizeBefore + " -> " + party[0].size
  );

/* --- a Part's geometry belongs to its Beat, not to the step it was typed in */

// Nothing selected: the sidebar shows the palette rather than the inspector.
await page.mouse.click(box.x + 8, box.y + 8);
await page.waitForTimeout(200);
await chip("Circle").dragTo(canvas, { targetPosition: inCanvas(0, -180) });
await page.waitForTimeout(800);
await remeasure();
doc = await load();
const circle = doc.entities.find((e) => e.type === "zone" && e.shape === "circle");
if (!circle) fail("dragging the Circle chip placed nothing");
else {
  await canvas.click({ position: inCanvas(0, -180) });
  await page.waitForTimeout(300);
  const radius = page.locator('div.label:text-is("radius") + input');
  await radius.fill(String(Math.round(circle.radius) + 40));
  await radius.press("Enter");
  await page.waitForTimeout(700);

  doc = await load();
  const sized = doc.entities.find((e) => e.id === circle.id);
  if (Math.abs(sized.radius - (Math.round(circle.radius) + 40)) > 1)
    fail("typing a radius in step scope did not take: " + sized.radius);
  else if (Object.keys(sized.overrides ?? {}).length)
    fail("a Part's radius was filed under a step: " + JSON.stringify(sized.overrides));
  else console.log("the Part's radius landed on the Part, with nothing left per-step");
}

/* --- and inheritance stops at the mechanic boundary ----------------------- */

await page.getByRole("button", { name: "New mechanic" }).click();
await page.waitForTimeout(900);
doc = await load();
const opened = doc.steps[doc.steps.length - 1];
if (opened.mechanic === doc.steps[0].mechanic) fail("the new step is in the same mechanic");
const across = await drawnAt(mt.id);
if (!across) fail("MT is not drawn in the new mechanic");
else if (Math.hypot(across.x - mt.x, across.y - mt.y) > 2)
  fail(
    "a new mechanic inherited across the boundary: " +
      JSON.stringify(across) + " not base " + JSON.stringify({ x: mt.x, y: mt.y })
  );
else console.log("a new mechanic opens with the party at their base pose");

console.log(process.exitCode ? "FAILED" : "OK - steps declare movement, and nothing else");
await browser.close();
