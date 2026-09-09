/**
 * Expanded: the same rail, measured for hands.
 *
 * Switching the timeline to Expanded grows the rows from 28px to 40px, which is
 * the whole claim: the Snap diamond and the card's two edges are easier to
 * aim at. So the test drags the diamond at the bigger pitch and reads the plan,
 * writes a step's note in the column Expanded gives it — the pane under the
 * rail is gone, the note lives on its row and on the arena card — and then
 * switches back to Normal, where the note reads as a dot beside its number.
 *
 *   node scripts/e2e-expanded.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=expanded-e2e");
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
  body: JSON.stringify({ name: "expanded e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);
const ops = (o) =>
  api("/api/plans/" + planId + "/ops", { method: "POST", body: JSON.stringify({ ops: [].concat(o) }) });

/* --- five steps, a Beat over all of them, and a Variant on step three ----- */

let doc = await load();
await ops({ op: "update_step", stepId: doc.steps[0].id, patch: { name: "One" } });
for (const name of ["Two", "Three", "Four", "Five"]) await ops({ op: "add_step", name });
doc = await load();
const steps = doc.steps.map((s) => s.id);
if (steps.length !== 5) fail("expected five steps, got " + steps.length);
await ops({ op: "add_mech", id: "mech_exp", name: "Add cast", snap: steps[0], boom: steps[4] });
await ops({ op: "add_step_variant", stepId: steps[2] });

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

const rowMid = async (n) => {
  const r = await page.getByRole("button", { name: `Step ${n}`, exact: true }).boundingBox();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};
// The row band runs the whole width of the rail, and a Variant box sits on top
// of it: the gutter with the number in it is the part that is always the row.
const clickRow = async (id) => {
  const r = await page.locator(`[data-row="${id}"]`).boundingBox();
  await page.mouse.click(r.x + 12, r.y + r.height / 2);
};
const rowHeight = async () =>
  Math.round((await page.locator(`[data-row="${steps[0]}"]`).boundingBox()).height);

/* --- Normal is 28px rows -------------------------------------------------- */

if ((await rowHeight()) !== 28) fail("Normal rows are " + (await rowHeight()) + "px, expected 28");
else console.log("Normal: a step row is 28px tall");

/* --- Expanded is 40px rows ------------------------------------------------ */

await page.locator('[data-timeline-mode] [data-mode-option="expanded"]').click();
await page.waitForTimeout(600);
if ((await rowHeight()) !== 40) fail("Expanded rows are " + (await rowHeight()) + "px, expected 40");
else console.log("Expanded: the same row is 40px tall");

if (!(await page.getByText("Step notes", { exact: true }).count()))
  fail("Expanded has no notes column header");
else console.log("the columns are named: Beats, then Step notes");

/* --- the Snap diamond drags at the bigger pitch --------------------------- */

const diamond = page.locator('[data-freeze="mech_exp"]');
if (!(await diamond.count())) fail("the five-step Beat has no Snap marker in Expanded");
if ((await load()).mechs[0].freeze !== "")
  fail("a fresh Beat should freeze as it casts, not at " + (await load()).mechs[0].freeze);

const d = await diamond.boundingBox();
const to = await rowMid(3);
await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
await page.mouse.down();
await page.mouse.move(d.x + d.width / 2, to.y, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(800);
doc = await load();
if (doc.mechs[0].freeze !== steps[2])
  fail(
    "dragging the marker to row 3 on a 44px pitch froze at " +
      (doc.steps.findIndex((s) => s.id === doc.mechs[0].freeze) + 1)
  );
else console.log("the diamond dragged from under row 1 to under row 3: it freezes in step 3");

/* --- the note is written on its own row ----------------------------------- */

await clickRow(steps[2]);
await page.waitForTimeout(500);
const cell = page.locator(`[data-note-cell="${steps[2]}"]`);
if (!(await cell.count())) fail("the selected row has no note cell to write in");
if (await page.locator(`[data-note-cell="${steps[3]}"]`).count())
  fail("an unselected row with no note still drew a card");
else console.log("only the selected row offers an empty note card; the rest stay quiet");

await cell.click();
await page.waitForTimeout(300);
await page.keyboard.type("Bait the ring on the outer edge.");
await clickRow(steps[0]);
await page.waitForTimeout(900);
doc = await load();
if (doc.steps[2].notes !== "Bait the ring on the outer edge.")
  fail("the note cell did not save: " + JSON.stringify(doc.steps[2].notes));
else console.log("clicking the note cell, typing and blurring wrote update_step");

await clickRow(steps[2]);
await page.waitForTimeout(500);
if (!(await page.locator(`[data-step-notes="${steps[2]}"]`).count()))
  fail("the arena is not showing the note card the rail wrote");
else console.log("the arena card carries the same note — the rail column is that card");

await page.screenshot({ path: "scripts/e2e-expanded.png" });

/* --- and Normal keeps the note as a dot ----------------------------------- */

await page.locator('[data-timeline-mode] [data-mode-option="normal"]').click();
await page.waitForTimeout(600);
if ((await rowHeight()) !== 28) fail("back in Normal rows are " + (await rowHeight()) + "px");
else console.log("Normal: rows are 28px again");
if (!(await page.locator(`[data-note-dot="${steps[2]}"]`).count()))
  fail("the step carrying a note has no dot beside its number in Normal");
else console.log("the step that carries a note shows a dot beside its number");
if (await page.locator("[data-note-cell]").count())
  fail("Normal drew the Expanded note column");

/* --- the three adds are one row under the grid ---------------------------- */

for (const name of ["New Beat here", "New debuff Beat here", "Add step after the last one"])
  if (!(await page.getByRole("button", { name, exact: true }).count()))
    fail(`the add row is missing "${name}"`);
console.log("Beat, Debuff Beat and Step sit in one row under the grid");
if (await page.getByText("Step notes", { exact: true }).count())
  fail("the Step notes pane is still under the rail in Normal");
else console.log("the notes pane is gone: the arena card is the note");

await page.screenshot({ path: "scripts/e2e-expanded-normal.png" });

console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
await browser.close();
