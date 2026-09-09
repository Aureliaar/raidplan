/**
 * Keyboard: delete removes what is selected, copy/paste makes an offset twin
 * with its authored properties. Both must keep their hands off text fields — Backspace in the plan
 * name is a letter, not the boss.
 *
 *   node scripts/e2e-keys.mjs http://localhost:59577
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

await page.goto(base + "/auth/dev?name=keys-e2e");
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

const created = await api("/api/plans", { method: "POST", body: JSON.stringify({ name: "keys e2e" }) });
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);
await api("/api/plans/" + planId + "/ops", {
  method: "POST",
  body: JSON.stringify({
    ops: [
      { op: "add_entity", spec: { type: "zone", shape: "circle", radius: 120, name: "puddle", x: -250, y: 0 } },
      { op: "add_entity", spec: { type: "marker", marker: "A", x: 250, y: 0 } },
    ],
  }),
});
const seeded = await load();
const sourceId = seeded.entities.find((e) => e.name === "puddle").id;
await api("/api/plans/" + planId + "/ops", {
  method: "POST",
  body: JSON.stringify({
    ops: [{
      op: "update_entity",
      id: sourceId,
      stepId: seeded.steps[0].id,
      patch: { radius: 150, rotation: 23, scale: 1.25, opacity: 0.7, notes: "retain me" },
    }],
  }),
});
await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

const box = await page.locator("canvas").first().boundingBox();
const scale = viewScale(box.width);
const screen = (x, y) => ({ x: box.x + box.width / 2 + x * scale, y: box.y + box.height / 2 + y * scale });

/* --- copy and paste under the cursor -------------------------------------- */

const src = screen(-250, 0);
await page.mouse.click(src.x, src.y);
await page.waitForTimeout(300);
// Fast hex entry is a step-scoped edit by default: copying the raw base entity
// would therefore lose it, which is the original regression.
const hex = page.getByLabel("Hex colour");
await hex.fill("0af");
await hex.press("Enter");
await page.waitForTimeout(600);
await page.keyboard.press("Control+c");
await page.keyboard.press("Control+v");
await page.waitForTimeout(700);

let doc = await load();
const twins = doc.entities.filter((e) => e.name === "puddle");
if (twins.length !== 2) fail("ctrl+v made " + (twins.length - 1) + " copies");
else {
  const pasted = twins[1];
  if (Math.hypot(pasted.x - -190, pasted.y - 60) > 2)
    fail("the paste landed at " + pasted.x + "," + pasted.y + ", not at the 60-unit offset");
  else if (pasted.color !== "#00aaff")
    fail("the paste lost its colour, becoming " + pasted.color);
  else if (
    pasted.radius !== 150 ||
    pasted.shape !== "circle" ||
    pasted.rotation !== 23 ||
    pasted.scale !== 1.25 ||
    pasted.opacity !== 0.7 ||
    pasted.notes !== "retain me"
  ) fail("the paste lost authored properties: " + JSON.stringify(pasted));
  else console.log("ctrl+c, ctrl+v: an offset twin retaining #00aaff and its authored properties");
}

/* --- delete removes the selection ----------------------------------------- */

const before = (await load()).entities.length;
// Paste selects the new twin. Do not click its center again: large overlapping
// shapes can legitimately route that click to the original beneath it.
await page.keyboard.press("Delete");
await page.waitForTimeout(600);
doc = await load();
if (doc.entities.length !== before - 1) fail("Delete removed " + (before - doc.entities.length) + " entities");
else if (doc.entities.some((e) => Math.hypot(e.x - -190, e.y - 60) < 30))
  fail("Delete removed the wrong one");
else console.log("Delete removes what is selected, and only that");

/* --- relationships copy with their owner, but not by themselves ---------- */

await api("/api/plans/" + planId + "/ops", {
  method: "POST",
  body: JSON.stringify({
    ops: [{
      op: "add_entity",
      // Clear of every party token: R2 stands at (247, -247).
      spec: { type: "enemy", name: "clipboard boss", x: 150, y: -100, size: 70, color: "#cc3355" },
    }],
  }),
});
const withBoss = await load();
const bossId = withBoss.entities.find((e) => e.name === "clipboard boss").id;
await api("/api/plans/" + planId + "/ops", {
  method: "POST",
  body: JSON.stringify({
    ops: [{
      op: "add_entity",
      spec: {
        type: "zone",
        shape: "rect",
        name: "clipboard beam",
        width: 70,
        length: 400,
        color: "#cc3355",
        anchor: { from: bossId, to: sourceId },
      },
    }],
  }),
});
await page.waitForTimeout(650);

const bossPoint = screen(150, -100);
await page.mouse.click(bossPoint.x, bossPoint.y);
await page.waitForTimeout(250);
await page.keyboard.press("Control+c");
await page.keyboard.press("Control+v");
await page.waitForTimeout(700);
doc = await load();
const bosses = doc.entities.filter((e) => e.name === "clipboard boss");
const beams = doc.entities.filter((e) => e.name === "clipboard beam");
const copiedBoss = bosses.find((e) => e.id !== bossId);
const copiedBeam = beams.find((e) => e.id !== beams[0].id);
if (bosses.length !== 2 || beams.length !== 2 || !copiedBoss || !copiedBeam)
  fail("deep copy made " + bosses.length + " bosses and " + beams.length + " assigned baits");
else if (copiedBoss.x !== 210 || copiedBoss.y !== -40)
  fail("the deep-copied source did not receive the standard offset");
else if (copiedBeam.anchor?.from !== copiedBoss.id || copiedBeam.anchor?.to !== sourceId)
  fail("the copied bait was not remapped to its copied source: " + JSON.stringify(copiedBeam.anchor));
else console.log("copying a source deep-copies its assigned bait and remaps the source reference");

// Paste selects the new source; removing it also proves its attached bait is a
// real relationship in the document rather than a disconnected visual clone.
await page.keyboard.press("Delete");
await page.waitForTimeout(600);

// The beam body is clear of both endpoints here. Copying it directly clears
// the clipboard, so the following paste must do nothing.
// A third of the way from the boss (150, -100) toward the puddle (-250, 0).
const beamPoint = screen(34, -71);
await page.mouse.click(beamPoint.x, beamPoint.y);
await page.waitForTimeout(250);
const beforeBaitCopy = (await load()).entities.length;
await page.keyboard.press("Control+c");
await page.keyboard.press("Control+v");
await page.waitForTimeout(500);
if ((await load()).entities.length !== beforeBaitCopy)
  fail("a baited entity entered the clipboard directly");
else console.log("baited entities are blacklisted as standalone clipboard roots");

// The beam is still selected, and the inspector stands in for the panel
// that holds the waymark button while anything is: click bare floor first.
const clearPoint = screen(100, 150);
await page.mouse.click(clearPoint.x, clearPoint.y);
await page.waitForTimeout(250);
await page.getByRole("button", { name: "move waymarks" }).click();
const markerPoint = screen(250, 0);
await page.mouse.click(markerPoint.x, markerPoint.y);
await page.waitForTimeout(250);
const beforeMarkerCopy = (await load()).entities.length;
await page.keyboard.press("Control+c");
await page.keyboard.press("Control+v");
await page.waitForTimeout(500);
if ((await load()).entities.length !== beforeMarkerCopy)
  fail("a floor marker entered the clipboard");
else console.log("floor markers are blacklisted from copy/paste");
await page.getByRole("button", { name: "done with waymarks" }).click();

/* --- and it keeps out of the text fields ---------------------------------- */

doc = await load();
// The plan title reads as text until you click it, which is what opens the
// field; after that it is an ordinary input.
const openPlanName = async () => {
  const field = page.locator("header input").first();
  if (!(await field.count())) await page.locator("header [data-plan-name]").click();
  return page.locator("header input").first();
};
/** The plan's name, whether the field is open or the text is back. */
const planName = async () => {
  const field = page.locator("header input").first();
  return (await field.count())
    ? await field.inputValue()
    : await page.locator("header [data-plan-name]").getAttribute("data-plan-name");
};
const name = await openPlanName();
await name.click();
await name.press("Backspace");
await page.waitForTimeout(400);
if ((await load()).entities.length !== doc.entities.length)
  fail("Backspace in the name field deleted an entity");
else console.log("Backspace in a text field is just a letter");

/* --- WASD walks the fight: W/S the steps, A/D the readings ---------------- */

await api("/api/plans/" + planId + "/ops", {
  method: "POST",
  body: JSON.stringify({ ops: [{ op: "add_step", name: "Two" }, { op: "add_step", name: "Three" }] }),
});
await page.waitForTimeout(900);

/** The step the rail says you are on: a row is its 1-based number. */
const on = () => page.locator("nav [data-step][aria-current]").innerText();
/** The reading the rail says is playing. */
const playing = () => page.locator("nav [data-variant][aria-pressed=true]").innerText();
const press = async (key) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(350);
};

// The canvas has the focus, as it would after clicking about on the floor.
await page.mouse.click(600, 500);
await page.waitForTimeout(300);
await press("s");
await press("s");
if ((await on()).trim() !== "3") fail("S twice landed on " + (await on()));
else console.log("S walks down the steps: " + (await on()).trim());

await press("w");
if ((await on()).trim() !== "2") fail("W went to " + (await on()));
else console.log("W walks back up: " + (await on()).trim());

await press("w");
await press("w");
await press("w");
if ((await on()).trim() !== "1") fail("W past the first step went to " + (await on()));
else console.log("and it stops at the first step rather than falling off the fight");

const at = await on();

// And none of it while you are typing: WASD in a name field is four letters.
const field = await openPlanName();
await field.click();
await field.fill("");
await field.type("swad");
await page.waitForTimeout(400);
if ((await on()) !== at) fail("typing in a field walked the steps, landing on " + (await on()));
else console.log("typing 'swad' in a text field is four letters, not four moves: " + (await planName()));

console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
await browser.close();
