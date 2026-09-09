/**
 * Three sizes of timeline.
 *
 * Collapsed turns the rail sideways: the rail goes away, a strip of step pills
 * and Beat bars appears under the arena, tapping a pill walks the fight and
 * tapping a bar opens that Beat. Normal puts the rail back. And a link somebody
 * can only read opens collapsed on its own, without being asked.
 *
 *   node scripts/e2e-modes.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=modes-e2e");
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
  body: JSON.stringify({ name: "modes e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);
const ops = (o) =>
  api("/api/plans/" + planId + "/ops", { method: "POST", body: JSON.stringify({ ops: [].concat(o) }) });

/* --- five steps, a Beat over all of them, and a note to read -------------- */

let doc = await load();
await ops({ op: "update_step", stepId: doc.steps[0].id, patch: { name: "One", notes: "Tanks north, healers south." } });
for (const name of ["Two", "Three", "Four", "Five"]) await ops({ op: "add_step", name });
doc = await load();
const steps = doc.steps.map((s) => s.id);
if (steps.length !== 5) fail("expected five steps, got " + steps.length);
await ops({ op: "add_mech", id: "mech_modes", name: "Add cast", snap: steps[0], boom: steps[4] });

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

const rail = page.locator("nav");
const strip = page.locator("[data-timeline-strip]");
const stepParam = () => new URL(page.url()).searchParams.get("step");
const mechParam = () => new URL(page.url()).searchParams.get("mech");

/* --- an editable plan on a wide window opens with its rail ---------------- */

if ((await rail.count()) !== 1) fail("an editable plan did not open with the rail");
else if (await strip.count()) fail("the strip is on screen beside the rail");
else console.log("an editable plan on a 1280px window opens in Normal: the rail, no strip");

/* --- Collapsed: the rail goes, the strip arrives -------------------------- */

await page.locator('[data-timeline-mode] [data-mode-option="collapsed"]').click();
await page.waitForTimeout(500);
if (await rail.count()) fail("Collapsed left the rail on screen");
else if ((await strip.count()) !== 1) fail("Collapsed put no strip under the arena");
else console.log("Collapsed: the rail is gone and the strip is under the arena");

if (await page.locator('[data-panel="palette"]').count()) fail("Collapsed left the Add palette up");
else console.log("the Add palette is gone too — the arena has the width");

/* --- and it is a mode for reading: the tools are put away ----------------- */

if (await page.locator('[aria-label="Symmetry controls"]').count())
  fail("Collapsed kept the translate/rotate toolbar");
else if (await page.locator('[title^="Undo"]').count()) fail("Collapsed kept undo/redo");
else if (await page.locator("text=/Filling/").count()) fail("Collapsed kept the open-Beat banner");
else if (!(await page.getByRole("button", { name: "History" }).count()))
  fail("Collapsed took History away with the editing tools");
else console.log("Collapsed puts the editing tools away and keeps History");

/* --- a pill is a step ----------------------------------------------------- */

await page.locator(`[data-strip-step="${steps[2]}"]`).click();
await page.waitForTimeout(400);
if (stepParam() !== steps[2]) fail("tapping pill 3 left the view on step=" + stepParam());
else if (!(await page.locator(`[data-strip-step="${steps[2]}"][aria-current="step"]`).count()))
  fail("pill 3 does not read as the step being looked at");
else console.log("tapping pill 3 walked the fight to step 3");

/* --- a bar is a Beat ------------------------------------------------------ */

const bar = page.locator('[data-strip-beat="mech_modes"]');
if (!(await bar.count())) fail("the five-step Beat has no bar on the strip");
if (!(await page.locator('[data-strip-freeze="mech_modes"]').count()))
  fail("a Beat spanning five steps has no Snap diamond on its bar");
else console.log("the Beat is one bar with its Snap diamond on the seam");
await bar.click();
await page.waitForTimeout(500);
if (mechParam() !== "mech_modes") fail("tapping the bar opened mech=" + mechParam());
else if (stepParam() !== steps[0]) fail("tapping the bar left the view on step=" + stepParam());
else console.log("tapping the bar opened its Beat and jumped to the step it casts in");

/* --- the note stands in for the arena's card ------------------------------ */

const note = await page.locator("[data-strip-note]").innerText();
if (!note.includes("Tanks north")) fail("the strip does not carry the step's note: " + JSON.stringify(note));
else console.log("the step's note reads on one line under the bars");

await page.screenshot({ path: "scripts/e2e-modes-laptop.png" });

/* --- and Normal puts the rail back ---------------------------------------- */

await page.locator('[data-timeline-mode] [data-mode-option="normal"]').click();
await page.waitForTimeout(500);
if ((await rail.count()) !== 1) fail("Normal did not bring the rail back");
else if (await strip.count()) fail("Normal left the strip under the arena");
else if (!(await page.locator('[aria-label="Symmetry controls"]').count()))
  fail("Normal did not hand the editing tools back");
else console.log("Normal brings the rail back, and the tools with it");

/* --- a link you can only read opens collapsed on its own ------------------ */

await api("/api/plans/" + planId + "/public", { method: "POST", body: JSON.stringify({ isPublic: true }) });
const guest = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const viewer = await guest.newPage();
await viewer.goto(base + "/p/" + planId);
await viewer.waitForSelector("canvas");
await viewer.waitForTimeout(1400);
if (await viewer.locator("nav").count()) fail("a view-only link opened with the rail up");
else if (!(await viewer.locator("[data-timeline-strip]").count()))
  fail("a view-only link opened without the strip");
else console.log("a fresh view-only context lands in Collapsed");

/* --- and a phone gets the same thing, plus its prev/next ------------------ */

const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
const small = await phone.newPage();
await small.goto(base + "/auth/dev?name=modes-e2e");
await small.goto(base + "/p/" + planId);
await small.waitForSelector("canvas");
await small.waitForTimeout(1400);
if (!(await small.locator("[data-timeline-strip]").count())) fail("a 390px window has no strip");
else if (await small.locator("nav").count()) fail("a 390px window kept the rail");
else if (!(await small.locator('[data-strip-walk="next"]').count()))
  fail("a 390px window has no prev/next pair under the strip");
else if (await small.locator('[aria-label="Chips"]:visible').count())
  fail("a 390px top bar still carries the chip toggles");
else if (!(await small.locator('[aria-label="Sharing options"]:visible').count()))
  fail("a 390px top bar dropped Share");
else console.log("a 390px window is collapsed: back, title and Share, prev/next under the strip");
// The strip is the arena's width, so measuring it measures the floor.
const floor = await small.locator("[data-timeline-strip]").boundingBox();
if (Math.abs(floor.width - 358) > 6) fail("the phone's arena came out " + Math.round(floor.width) + "px wide, not 358");
else console.log("the arena is the window less 16px either side: " + Math.round(floor.width) + "px");
await small.screenshot({ path: "scripts/e2e-modes-phone.png", fullPage: true });

console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
await browser.close();
