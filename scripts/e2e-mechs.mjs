/**
 * Mechs: a cast written as two moments.
 *
 * You open a slot in the step the cast snapshots in, drop its shapes into it,
 * and say which step it goes off in. From then on the shapes are on the floor
 * for exactly that span, aimed at where the party stood at the snapshot — which
 * is the point: the following steps are people walking out of them.
 *
 *   node scripts/e2e-mechs.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=mech-e2e");
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
  body: JSON.stringify({ name: "mech e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);
const ops = (o) =>
  api("/api/plans/" + planId + "/ops", { method: "POST", body: JSON.stringify({ ops: [].concat(o) }) });

/** What the canvas would draw in a step, mech timing and all. */
const drawn = (stepId) =>
  page.evaluate(
    async ([id, sid]) => {
      const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
      const mod = await import("/src/shared/schema.ts");
      return mod.entitiesForStep(d, sid).map((e) => ({
        id: e.id,
        name: e.name,
        shape: e.shape,
        mech: e.mech,
        x: Math.round(e.x),
        y: Math.round(e.y),
        opacity: Number(e.opacity.toFixed(2)),
      }));
    },
    [planId, stepId]
  );

// Three steps: the cast lands in the first, the party runs in the second, it
// goes off in the third.
let doc = await load();
const pull = doc.steps[0].id;
await ops([
  { op: "update_step", stepId: pull, patch: { name: "Cast" } },
  { op: "duplicate_step", stepId: pull, name: "Run" },
]);
doc = await load();
await ops({ op: "duplicate_step", stepId: doc.steps[1].id, name: "Boom" });
doc = await load();
const [run_, boom] = [doc.steps[1].id, doc.steps[2].id];
if (doc.steps.map((s) => s.name).join() !== "Cast,Run,Boom") fail("steps are " + doc.steps.map((s) => s.name).join());

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

const canvas = page.locator("canvas").first();
const chip = (label) => page.locator("div", { hasText: new RegExp("^" + label + "$") }).last();

/* --- open a slot in the step the cast snapshots in ------------------------ */

await page.getByRole("button", { name: "New Beat here" }).click();
await page.waitForTimeout(500);
doc = await load();
if (doc.mechs.length !== 1) fail("New mech here made " + doc.mechs.length + " mechs");
const mechId = doc.mechs[0].id;
if (doc.mechs[0].snap !== pull || doc.mechs[0].boom !== pull)
  fail("a new mech should snapshot and go off in the step you were on");
else console.log("a new mech snapshots where you opened it: " + doc.mechs[0].id);

// It is open, so the arena says so and what you drop lands in it.
if (!(await page.locator("text=/Filling/").count())) fail("nothing said the slot was open");

// A Beat is also a drag surface, but a plain press must not wait for release
// before opening the editor. Close it, then inspect the UI with the pointer
// still held down; this catches the old click path that felt several beats late.
const beatBox = page.locator(`[data-mech="${mechId}"]`);
await beatBox.click();
const beatRect = await beatBox.boundingBox();
await page.mouse.move(beatRect.x + beatRect.width / 2, beatRect.y + beatRect.height / 2);
await page.mouse.down();
if (!(await page.locator("text=/Filling/").count()))
  fail("pressing a Beat did not open it until pointer release");
await page.mouse.up();
if (!(await page.locator("text=/Filling/").count()))
  fail("a Beat opened on press but closed again on the same release");
else console.log("pressing a Beat opens it before pointer release");

/* --- everything dropped while it is open joins it ------------------------- */

await page.locator("div", { hasText: /^Donut$/ }).last().dragTo(chip("Party"));
await page.waitForTimeout(900);
doc = await load();
const donuts = doc.entities.filter((e) => e.type === "zone" && e.shape === "donut");
if (donuts.length !== 8) fail("a donut on Party made " + donuts.length + " shapes");
else if (!donuts.every((d) => d.mech === mechId)) fail("the donuts did not join the open mech");
else console.log("eight donuts dropped straight into the mech");

// Unnamed, it goes by what is in it — F2 opens the name where the box sits, and
// offers that as the placeholder rather than an empty field.
await page.keyboard.press("F2");
const nameField = page.getByTitle("Rename Beat");
await nameField.waitFor();
const name = await nameField.getAttribute("placeholder");
await nameField.press("Escape");
await page.waitForTimeout(300);
if (name !== "Donut") fail("the slot is called " + name + ", expected the name of the first thing in it");
else console.log('an unnamed slot is called after what is in it: "' + name + '"');

/* --- and it is on the floor from snapshot to explosion -------------------- */

const inStep = async (sid) => (await drawn(sid)).filter((e) => e.mech === mechId).length;
if ((await inStep(run_)) !== 0) fail("the mech is on the floor in Run before its explosion was set");

// Say where it goes off by dragging the bottom edge of the box down to Boom.
const boxOf = (n) => page.getByTitle(new RegExp("casts in step [0-9]+, resolves in step " + n));
const rowMid = async (label) => {
  const r = await page.getByRole("button", { name: `Step ${label}`, exact: true }).boundingBox();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};
async function dragBox(box, grab, toRow) {
  const b = await box.boundingBox();
  // The strip you take hold of is the end you are dragging: 6px at the top for
  // the cast, 7px at the bottom for the resolve. In between is the whole Beat.
  const at = grab === "top" ? b.y + 3 : b.y + b.height - 3;
  const to = await rowMid(toRow);
  await page.mouse.move(b.x + b.width / 2, at);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, to.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
}
await dragBox(boxOf(1), "bottom", 3);
const spread = [await inStep(pull), await inStep(run_), await inStep(boom)];
if (spread.join() !== "8,8,8") fail("the mech is on the floor in " + spread.join("/") + " of Cast/Run/Boom");
else console.log("snapshot in Cast, goes off in Boom: on the floor for all three steps");

// A fourth step, after the explosion, is past it.
await ops({ op: "add_step", name: "After" });
doc = await load();
if ((await inStep(doc.steps[3].id)) !== 0) fail("the mech is still on the floor after it went off");
else console.log("and gone in the step after it goes off");

/* --- it is aimed at the snapshot, not at wherever people went ------------- */

const donut = donuts[0];
const target = donut.anchor.to;
const home = (await drawn(pull)).find((e) => e.id === donut.id);
// Everybody runs to the north wall in Run and stays there for the explosion.
await ops(
  [run_, boom].map((sid) => ({ op: "update_entity", id: target, patch: { x: -430, y: -430 }, stepId: sid }))
);
await page.waitForTimeout(400);
const later = (await drawn(boom)).find((e) => e.id === donut.id);
const who = (await drawn(boom)).find((e) => e.id === target);
if (later.x !== home.x || later.y !== home.y)
  fail("the donut followed its target: " + JSON.stringify(later) + " vs " + JSON.stringify(home));
else if (Math.hypot(who.x - later.x, who.y - later.y) < 100)
  fail("the target never actually moved away from it");
else
  console.log(
    "the donut stayed on the snapshot at " + JSON.stringify(home) + " while its target ran to " +
      JSON.stringify({ x: who.x, y: who.y })
  );

// Before it lands it reads as a telegraph, and in the step it goes off it does not.
const faint = (await drawn(pull)).find((e) => e.id === donut.id).opacity;
const full = later.opacity;
if (!(faint < full)) fail("the telegraph is not fainter than the hit: " + faint + " vs " + full);
else console.log("faint while it is in the air (" + faint + "), full when it goes off (" + full + ")");

/* --- move the snapshot and the whole mech re-aims -------------------------- */

await dragBox(boxOf(3), "top", 2);
const reaimed = (await drawn(boom)).find((e) => e.id === donut.id);
if (Math.hypot(reaimed.x - who.x, reaimed.y - who.y) > 60)
  fail("moving the snapshot to Run did not re-aim the mech: " + JSON.stringify(reaimed));
else if ((await inStep(pull)) !== 0) fail("the mech is still on the floor in Cast, before its snapshot");
else console.log("snapshotting in Run instead: it re-aims at the north wall and leaves Cast empty");

/* --- the box beside the steps is the mech --------------------------------- */

// It spans the rows of the steps it is on the floor for: rows 2 and 3 of four,
// now that it snapshots in Run and goes off in Boom.
const box = page.getByTitle(/casts in step 2, resolves in step 3/);
if (!(await box.count())) fail("no mech box spanning steps 2 to 3 beside the step list");
else {
  const b = await box.boundingBox();
  const rowOf = async (n) =>
    await page.getByRole("button", { name: `Step ${n}`, exact: true }).boundingBox();
  const [cast, run2, boom2] = [await rowOf(1), await rowOf(2), await rowOf(3)];
  // A row is the whole width of the rail now; the step column is a 24px gutter.
  if (b.x < cast.x + 24) fail("the mech box is not beside the step gutter");
  else if (Math.abs(b.y - run2.y) > 6) fail("the box does not start at the step it snapshots in");
  else if (Math.abs(b.y + b.height - (boom2.y + boom2.height)) > 6)
    fail("the box does not end at the step it goes off in");
  else if (b.y < cast.y + cast.height - 2) fail("the box covers a step the mech is not on the floor in");
  else console.log("the box runs from the Run row to the Boom row, alongside the steps");
}

// The bottom strip is only the resolve: pulling it down is "it goes off later",
// and the snapshot stays exactly where it was.
await dragBox(boxOf(3), "bottom", 4);
doc = await load();
const pulled = doc.mechs[0];
if (pulled.snap !== run_) fail("dragging the middle down moved the snapshot too");
else if (pulled.boom !== doc.steps[3].id) fail("dragging down did not carry the explosion to After");
else console.log("dragging down from the middle stretched it to After, snapshot untouched");

/* --- a mech has a colour, and its shapes wear it --------------------------- */

const mod = (fn) => page.evaluate(async ([id, src]) => {
  const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
  const m = await import("/src/shared/schema.ts");
  return new Function("m", "d", "return (" + src + ")(m, d)")(m, d);
}, [planId, fn.toString()]);

const m_cast = await mod((m) => [...m.ZONE_FAMILIES.cast]);
const first = (await mod((m, d) => m.mechColor(d, d.mechs[0])));
const worn = (await drawn(run_)).filter((e) => e.mech === mechId);
// `drawn` does not report colour; read it the same way the canvas does.
const colors = await mod((m, d) =>
  [...new Set(m.entitiesForStep(d, d.steps[1].id).filter((e) => e.mech).map((e) => e.color))]);
// Nobody has picked a colour for this cast, so its shapes go by family: a
// donut is something the boss throws, so it is a shade of red-orange, and all
// eight of them are the same shade because they are the same cast.
if (colors.length !== 1) fail("the donuts came out in " + colors.length + " colours: " + colors.join(","));
else if (!m_cast.includes(colors[0]))
  fail("the donuts are drawn in " + colors[0] + ", which is no shade of the cast family");
else console.log("the donuts wear a shade of their family, " + colors[0]);

// A second cast is told apart from the first by colour without anyone asking.
await ops({ op: "add_mech", snap: run_ });
const second = await mod((m, d) => m.mechColor(d, d.mechs[1]));
if (second === first) fail("the second mech came out the same colour as the first");
else console.log("a second mech is a different colour: " + second);
await ops({ op: "delete_mech", mechId: (await load()).mechs[1].id });

// And the swatches in the mech panel change it, shapes and all.
// Moving the snapshot off Cast closed filling there; stand inside the mech's
// span and explicitly reopen it before using its controls.
await page.getByRole("button", { name: "Step 2", exact: true }).click({ position: { x: 12, y: 14 } });
await page.locator(`[data-mech="${mechId}"]`).click();
const swatch = page.getByTitle(/^Draw this Beat in #/).nth(3);
const picked = (await swatch.getAttribute("title")).slice("Draw this Beat in ".length);
await swatch.click();
await page.waitForTimeout(500);
const after = await mod((m, d) => m.entitiesForStep(d, d.steps[1].id).find((e) => e.mech).color);
if (after !== picked) fail("picking " + picked + " left the donuts " + after);
else console.log("picking a swatch recoloured the cast to " + picked);
if (!worn.length) fail("nothing of the mech was drawn in Run");

/* --- the slot is the object ----------------------------------------------- */

await page.keyboard.press("F2");
await page.getByTitle("Rename Beat").fill("Ice Missile");
await page.getByTitle("Rename Beat").press("Enter");
await page.waitForTimeout(600);
doc = await load();
if (doc.mechs[0].name !== "Ice Missile") fail("renaming the slot did not stick: " + doc.mechs[0].name);

await page.getByTitle("Delete this Beat and everything in it").click();
await page.waitForTimeout(700);
doc = await load();
if (doc.mechs.length) fail("the mech survived its own delete button");
else if (doc.entities.some((e) => e.shape === "donut")) fail("deleting the mech left its donuts behind");
else console.log("deleting Ice Missile took all eight donuts with it");

console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
await browser.close();
