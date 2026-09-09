/**
 * The Timeline Rail: three moments on one card.
 *
 * A Beat card's top edge is the step it casts in, its bottom edge the step it
 * resolves in, and — for a Beat that spans three steps or more — a diamond on a
 * dashed seam says how far its baits and anchors follow their target before
 * they freeze on the snapshot. All three are dragged, not typed, and the word
 * "boom" is gone from the card: the amber edge is the caption.
 *
 *   node scripts/e2e-rail.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=rail-e2e");
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
  body: JSON.stringify({ name: "rail e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);
const ops = (o) =>
  api("/api/plans/" + planId + "/ops", { method: "POST", body: JSON.stringify({ ops: [].concat(o) }) });

/* --- five steps, and a Beat that spans all of them ------------------------ */

let doc = await load();
await ops({ op: "update_step", stepId: doc.steps[0].id, patch: { name: "One" } });
for (const name of ["Two", "Three", "Four", "Five"]) await ops({ op: "add_step", name });
doc = await load();
if (doc.steps.length !== 5) fail("expected five steps, got " + doc.steps.length);
const steps = doc.steps.map((s) => s.id);
await ops({ op: "add_mech", id: "mech_rail", name: "Add cast", snap: steps[0], boom: steps[4] });

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

const card = page.locator('[data-mech="mech_rail"]');
const diamond = page.locator('[data-freeze="mech_rail"]');
/**
 * Measured fresh every time: every one of these gestures moves the rail. Rows
 * have no names any more — a row is its number, in a 24px gutter.
 */
const rowMid = async (n) => {
  const r = await page.getByRole("button", { name: `Step ${n}`, exact: true }).boundingBox();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};

/* --- the resolve is an edge, not a word ----------------------------------- */

if (!(await card.count())) fail("no Beat card on the rail");
const text = (await card.innerText()).toLowerCase();
if (text.includes("boom")) fail('the card still says "boom": ' + JSON.stringify(text));
else console.log("the card carries no caption for its resolve: " + JSON.stringify(await card.innerText()));
if (!(await page.getByText("resolve", { exact: true }).count()))
  fail("the legend above the grid does not name the resolve");
else console.log("cast / snap / resolve are named once, in the legend above the grid");

/* --- the marker drags, and it says where the Beat freezes ----------------- */

if (!(await diamond.count())) fail("a Beat spanning five steps has no Snap marker");
const before = (await load()).mechs[0].freeze;
if (before !== "") fail("a fresh Beat should freeze as it casts, not at " + before);

async function dragDiamond(n) {
  const d = await diamond.boundingBox();
  const to = await rowMid(n);
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
  await page.mouse.down();
  await page.mouse.move(d.x + d.width / 2, to.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
}
await dragDiamond(3);
doc = await load();
if (doc.mechs[0].freeze !== steps[2])
  fail(
    "dragging the marker to row 3 froze at " +
      (doc.steps.findIndex((s) => s.id === doc.mechs[0].freeze) + 1)
  );
else console.log("the marker was dragged from under row 1 to under row 3: it now freezes in step 3");

// It cannot be dragged onto the resolve row: freezing at the last step says
// nothing, so the last legal row is the one before it.
await dragDiamond(5);
doc = await load();
if (doc.mechs[0].freeze !== steps[3])
  fail("the marker was allowed past the row before the resolve: " + doc.mechs[0].freeze);
else console.log("dragged at the resolve row it stops on the row before it, step 4");
await dragDiamond(3);

/* --- the body carries the whole Beat -------------------------------------- */

await ops({ op: "update_mech", mechId: "mech_rail", patch: { boom: steps[3] } });
await page.waitForTimeout(500);
doc = await load();
const was = [doc.mechs[0].snap, doc.mechs[0].boom, doc.mechs[0].freeze];
if (was.join() !== [steps[0], steps[3], steps[2]].join())
  fail("the Beat is not where the body drag expects it: " + JSON.stringify(was));

const body = await card.boundingBox();
const down = await rowMid(2);
// Well clear of the 6px cast strip and the 7px resolve strip: this is the body.
await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
await page.mouse.down();
await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2 + (down.y - (await rowMid(1)).y), {
  steps: 12,
});
await page.mouse.up();
await page.waitForTimeout(800);
doc = await load();
const now = [doc.mechs[0].snap, doc.mechs[0].boom, doc.mechs[0].freeze];
if (now.join() !== [steps[1], steps[4], steps[3]].join())
  fail(
    "dragging the body down one row gave " +
      JSON.stringify(now.map((id) => doc.steps.findIndex((s) => s.id === id) + 1))
  );
else console.log("the body carried cast, resolve and marker down one row each: steps 2, 5, freeze 4");

/* --- the menus the rows and the cards own --------------------------------- */

const menu = page.locator("[data-context-menu]").first();
const openMenu = async (x, y) => {
  await page.mouse.click(x, y, { button: "right" });
  await menu.waitFor({ state: "visible", timeout: 3000 });
};

// Snap is typed as well as dragged: right-click the Beat on a row strictly
// between its cast and its resolve, and that row is where it freezes.
const cardBox = await card.boundingBox();
const middle = await rowMid(3);
await openMenu(cardBox.x + cardBox.width / 2, middle.y);
await page.locator('[data-menu-item="Snap here"]').click();
await page.waitForTimeout(700);
doc = await load();
if (doc.mechs[0].freeze !== steps[2])
  fail(
    '"Snap here" on row 3 froze at ' +
      (doc.steps.findIndex((s) => s.id === doc.mechs[0].freeze) + 1)
  );
else console.log('"Snap here" on the middle row moved the marker to step 3');
const moved = await page.locator('[data-freeze="mech_rail"]').boundingBox();
const seam = moved.y + moved.height / 2;
// The marker sits in the gutter under the row it names, so it falls between
// that row's middle and the next one's.
if (!(seam > middle.y && seam < (await rowMid(4)).y))
  fail("the diamond did not follow the menu: it sits at " + Math.round(seam));
else console.log("the diamond sits on the seam under row 3");

// A step is added from the row's own menu, and the row after it is numbered.
const first = await rowMid(1);
await openMenu(first.x, first.y);
await page.locator('[data-menu-item="Add step after"]').click();
await page.waitForTimeout(800);
doc = await load();
if (doc.steps.length !== 6) fail('"Add step after" gave ' + doc.steps.length + " steps");
else if (!(await page.getByRole("button", { name: "Step 6", exact: true }).count()))
  fail("the sixth row is not numbered in the gutter");
else console.log('"Add step after" on row 1 added a step: the rail now numbers six rows');

// And a Variant box, from the same menu: the lanes are wide enough for one
// beside the Beat, which is the whole point of giving the names' width away.
const third = await rowMid(3);
await openMenu(third.x, third.y);
await page.locator('[data-menu-item="Add Variant here"]').click();
await page.waitForTimeout(800);
if (!(await page.locator("[data-step-variant-set]").count()))
  fail('"Add Variant here" put no Variant box on the rail');
else console.log('"Add Variant here" opened a Variant container beside the Beat');

await page.screenshot({ path: "scripts/e2e-rail.png" });
console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
await browser.close();
