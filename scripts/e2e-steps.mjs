/**
 * Naming and shuffling steps from the rail.
 *
 * A step's poses are keyed by its id, so moving it in the sequence has to carry
 * every override with it — that is the part worth checking, not the ordering.
 *
 *   node scripts/e2e-steps.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=steps-e2e");
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
  body: JSON.stringify({ name: "steps e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

/** F2 turns the selected step's row into a field, right where it sits. */
const rename = async (to) => {
  await page.keyboard.press("F2");
  const field = page.getByTitle("Rename step");
  await field.waitFor();
  await field.fill(to);
  await field.press("Enter");
  await page.waitForTimeout(500);
};
const names = (doc) => doc.steps.map((s) => s.name).join(" | ");

/** Carry a row onto another one: where a step sits is the whole of the edit. */
async function dragRow(from, to) {
  const a = await page.getByRole("button", { name: from }).boundingBox();
  const b = await page.getByRole("button", { name: to }).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
}

/* --- naming --------------------------------------------------------------- */

await rename("Pull");
let doc = await load();
if (doc.steps[0].name !== "Pull") fail("renaming the first step gave " + names(doc));
else console.log('the rail renamed step 1: "' + doc.steps[0].name + '"');
if (!(await page.getByRole("button", { name: "1. Pull" }).isVisible()))
  fail("the rail still lists the old name");

await page.getByRole("button", { name: "Duplicate step" }).click();
await page.waitForTimeout(600);
await rename("Adds");
await page.getByRole("button", { name: "Add step after this one" }).click();
await page.waitForTimeout(600);
await rename("Enrage");
doc = await load();
if (names(doc) !== "Pull | Adds | Enrage") fail("expected Pull | Adds | Enrage, got " + names(doc));
else console.log("three named steps: " + names(doc));

/* --- a step carries its own poses when it moves ---------------------------- */

const mt = doc.entities.find((e) => e.name === "MT");
const adds = doc.steps[1].id;
await api("/api/plans/" + planId + "/ops", {
  method: "POST",
  body: JSON.stringify({
    ops: [{ op: "update_entity", id: mt.id, patch: { x: -420, y: 330 }, stepId: adds }],
  }),
});

// Drag "Enrage" up onto the row Adds is in.
await dragRow("3. Enrage", "2. Adds");
doc = await load();
if (names(doc) !== "Pull | Enrage | Adds") fail("dragging the last step up gave " + names(doc));
else console.log("the row was dragged up: " + names(doc));

// The rail follows the step you moved, rather than staying on that slot: F2
// renames whatever is selected, so what it opens on is the answer.
await page.keyboard.press("F2");
const opened = page.getByTitle("Rename step");
await opened.waitFor();
const shown = await opened.inputValue();
await opened.press("Escape");
await page.waitForTimeout(300);
if (shown !== "Enrage") fail("the rail selection did not follow the step: it shows " + shown);

const posed = await page.evaluate(
  async ([id, eid, sid]) => {
    const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
    const drawn = (await import("/src/shared/schema.ts")).entitiesForStep(d, sid);
    const e = drawn.find((x) => x.id === eid);
    return { x: e.x, y: e.y, index: d.steps.findIndex((s) => s.id === sid) };
  },
  [planId, mt.id, adds]
);
if (Math.hypot(posed.x + 420, posed.y - 330) > 1)
  fail("the pose did not travel with its step: MT is at " + posed.x + "," + posed.y);
else console.log("MT is still where Adds put them, now that Adds is step " + (posed.index + 1));

// And back down again, to prove the other direction.
await dragRow("2. Enrage", "3. Adds");
doc = await load();
if (names(doc) !== "Pull | Adds | Enrage") fail("dragging it back down gave " + names(doc));
else console.log("and back down: " + names(doc));

// A row cannot leave its section by being dragged, and the last row has
// nowhere below it to go. A drag that stays put is a click, so Enrage is still
// what is selected afterwards.
await dragRow("3. Enrage", "3. Enrage");
doc = await load();
if (names(doc) !== "Pull | Adds | Enrage") fail("a row wandered out of its section: " + names(doc));
else console.log("dragging the last row onto itself changes nothing");

/* --- deleting ------------------------------------------------------------- */

await page.getByRole("button", { name: "Delete step" }).click();
await page.waitForTimeout(600);
doc = await load();
if (names(doc) !== "Pull | Adds") fail("deleting the last step gave " + names(doc));
else console.log("delete removed the selected one: " + names(doc));

/* --- a binding belongs to the step it was declared in ---------------------- */

// Drop the mechanic in "Pull": it marks where the party stood in *that* step.
await page.getByRole("button", { name: "1. Pull" }).click();
await page.waitForTimeout(400);
await page.locator("div", { hasText: /^Circle$/ }).last().dragTo(page.locator("div", { hasText: /^Party$/ }).last());
await page.waitForTimeout(1000);
doc = await load();
const pull = doc.steps[0].id;
const addsStep = doc.steps[1].id;
const onMT = doc.entities.find((e) => e.anchor && e.anchor.to === mt.id);
if (!onMT) fail("dropping a circle on Party bound nothing to MT");
else if (onMT.declaredIn !== pull)
  fail("the circle was declared in " + onMT.declaredIn + " instead of the step it was dropped in");

// The drop made a Beat for the circle in Pull. Stretch that Beat into Adds,
// where MT stands somewhere else: the circle must not follow them there.
await api("/api/plans/" + planId + "/ops", {
  method: "POST",
  body: JSON.stringify({
    ops: [{ op: "update_mech", mechId: onMT.mech, patch: { boom: addsStep } }],
  }),
});
const seen = await page.evaluate(
  async ([id, zid, a, b]) => {
    const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
    const mod = await import("/src/shared/schema.ts");
    const at = (sid) => {
      const z = mod.entitiesForStep(d, sid).find((e) => e.id === zid);
      return z ? { x: Math.round(z.x), y: Math.round(z.y) } : null;
    };
    return { pull: at(a), adds: at(b) };
  },
  [planId, onMT.id, pull, addsStep]
);
if (!seen.pull || !seen.adds) fail("the circle is not drawn in both steps");
else if (Math.hypot(seen.adds.x - seen.pull.x, seen.adds.y - seen.pull.y) > 1)
  fail(
    "the circle followed MT into the next step: " +
      JSON.stringify(seen.pull) + " -> " + JSON.stringify(seen.adds)
  );
else
  console.log(
    "the circle marks where MT stood when it was dropped, in both steps: " + JSON.stringify(seen.pull)
  );

// And it really is MT's step-2 position it is refusing to follow.
const mtIn2 = await page.evaluate(
  async ([id, eid, sid]) => {
    const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
    const e = (await import("/src/shared/schema.ts")).entitiesForStep(d, sid).find((x) => x.id === eid);
    return { x: Math.round(e.x), y: Math.round(e.y) };
  },
  [planId, mt.id, addsStep]
);
if (Math.hypot(mtIn2.x - seen.adds.x, mtIn2.y - seen.adds.y) < 50)
  fail("MT and the circle are in the same place in step 2, so nothing was proved");
else console.log("MT is at " + JSON.stringify(mtIn2) + " in Adds, the circle stayed behind");

console.log(process.exitCode ? "FAILED" : "OK - steps are named, moved and deleted from the rail");
await browser.close();
