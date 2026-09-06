/**
 * The donut chip, and the wheel as the way to size things.
 *
 * Scrolling over a shape resizes that shape — and over a shape a group owns it
 * resizes the whole set, because the set is the thing you are pointing at.
 *
 *   node scripts/e2e-size.mjs http://localhost:59577
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

await page.goto(base + "/auth/dev?name=size-e2e");
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
  body: JSON.stringify({ name: "size e2e", withParty: true }),
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
const inCanvas = (x, y) => ({ x: box.width / 2 + x * scale, y: box.height / 2 + y * scale });
const screen = (x, y) => ({ x: box.x + box.width / 2 + x * scale, y: box.y + box.height / 2 + y * scale });

// Spread the party out first, so nothing overlaps anything by accident.
await page.getByRole("button", { name: "PF positions" }).click();
await page.waitForTimeout(600);

/* --- a multi-selection resizes as one ------------------------------------ */

let doc = await load();
const markerIds = doc.entities.filter((e) => e.type === "marker").map((e) => e.id);
if (markerIds.length) {
  await api("/api/plans/" + planId + "/ops", {
    method: "POST",
    body: JSON.stringify({ ops: [{ op: "delete_entities", ids: markerIds }] }),
  });
  await page.reload();
  await page.waitForSelector("canvas");
  await page.waitForTimeout(500);
  doc = await load();
}
const mtBefore = doc.entities.find((e) => e.name === "M1");
const otBefore = doc.entities.find((e) => e.name === "M2");
const h1Before = doc.entities.find((e) => e.name === "H1");
await page.mouse.move(box.x + 8, box.y + 8);
await page.mouse.down();
await page.mouse.move(box.x + box.width - 8, box.y + box.height - 8, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(150);
const mtBeforePose = mtBefore.overrides?.[doc.steps[0].id] ?? mtBefore;
const selectedProbe = screen(mtBeforePose.x, mtBeforePose.y);
await page.mouse.move(selectedProbe.x, selectedProbe.y);
await page.mouse.wheel(0, -120);
await page.waitForTimeout(700);
doc = await load();
const mtSelected = doc.entities.find((e) => e.id === mtBefore.id);
const otSelected = doc.entities.find((e) => e.id === otBefore.id);
const h1Unselected = doc.entities.find((e) => e.id === h1Before.id);
if (
  mtSelected.size !== Math.round(mtBefore.size * 1.08) ||
  otSelected.size !== Math.round(otBefore.size * 1.08) ||
  h1Unselected.size !== Math.round(h1Before.size * 1.08)
)
  fail("wheel over a marquee selection did not resize all selected players: " + mtSelected.size + "/" + otSelected.size + "/" + h1Unselected.size);
else console.log("wheel over one selected player resized the whole marquee selection");

// Leave no token selected before probing bonded shapes below.
await page.mouse.click(box.x + 4, box.y + 4);
await page.waitForTimeout(150);

/* --- a set resizes as one ------------------------------------------------- */

await chip("Circle").dragTo(chip("Supports"));
await page.waitForTimeout(900);
doc = await load();
const set = doc.entities.filter((e) => e.type === "zone" && e.shape === "circle" && e.bond);
if (set.length !== 4) fail("Supports should hold 4 circles, got " + set.length);
const mt = doc.entities.find((e) => e.name === "MT");
const mtPose = mt.overrides?.[doc.steps[0].id] ?? mt;
// Inside MT's circle, well off the token itself: only the circle is under here.
const probe = screen(mtPose.x, mtPose.y + 150);

const before = set[0].radius;
await page.mouse.move(probe.x, probe.y);
for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -120);
await page.waitForTimeout(700);
doc = await load();
const grown = doc.entities.filter((e) => e.type === "zone" && e.shape === "circle" && e.bond);
const want = Math.round(before * 1.08 ** 3);
if (!grown.every((c) => Math.abs(c.radius - want) <= 2))
  fail("three notches on one circle gave " + grown.map((c) => c.radius).join() + ", wanted " + want);
else console.log("three notches over one of the four grew all four: " + before + " -> " + grown[0].radius);

// Down again, on the same spot: the wheel goes both ways.
for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 120);
await page.waitForTimeout(700);
doc = await load();
const back = doc.entities.find((e) => e.id === set[0].id).radius;
if (Math.abs(back - before) > 3) fail("scrolling back down left the circle at " + back);
else console.log("and scrolling back down undid it: " + back);

// The group row lists the sets of the open Beat, so open the set's Beat first.
await page.locator(`[data-mech="${set[0].mech}"]`).click();
await page.waitForTimeout(300);
await page.getByTitle("Remove this circle from the supports").click();
await page.waitForTimeout(600);

/* --- the donut chip, and the wheel on a shape of your own ----------------- */

await chip("Donut").dragTo(canvas, { targetPosition: inCanvas(0, 0) });
await page.waitForTimeout(700);
doc = await load();
const donut = doc.entities.find((e) => e.type === "zone" && e.shape === "donut");
if (!donut) fail("dragging the Donut chip onto the floor placed nothing");
else if (!(donut.innerRadius > 0 && donut.innerRadius < donut.radius))
  fail("the donut has no hole: " + donut.radius + "/" + donut.innerRadius);
else console.log("a donut on bare floor: radius " + donut.radius + ", hole " + donut.innerRadius);

// Every drop grew the rail by a Beat lane, so measure the floor afresh.
box = await canvas.boundingBox();
scale = viewScale(box.width);
// A point in the ring, outside the hole and clear of everyone.
await page.mouse.move(...Object.values(screen(0, -(donut.radius + donut.innerRadius) / 2)));
for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
await page.waitForTimeout(700);
doc = await load();
const bigger = doc.entities.find((e) => e.id === donut.id);
const factor = bigger.radius / donut.radius;
if (Math.abs(factor - 1.08 ** 4) > 0.03)
  fail("four notches scaled the donut by " + factor.toFixed(3));
else if (Math.abs(bigger.innerRadius / donut.innerRadius - factor) > 0.05)
  fail("the hole did not keep up with the ring: " + bigger.innerRadius + "/" + bigger.radius);
else
  console.log(
    "the wheel sized the donut ring and hole together: " +
      donut.radius + "/" + donut.innerRadius + " -> " + bigger.radius + "/" + bigger.innerRadius
  );

console.log(process.exitCode ? "FAILED" : "OK - the wheel is the size control");
await browser.close();
