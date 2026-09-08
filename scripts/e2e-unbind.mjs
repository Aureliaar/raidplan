/**
 * Unbinding a bait is a button, not a word in a paragraph.
 *
 * A donut that follows H1 is selected on the canvas, the inspector's Unbind
 * button is pressed, and the shape must stay exactly where it was drawn while
 * H1 walks off — the point of unbinding is that it stops following anyone.
 *
 *   npm run dev                        # in another terminal
 *   node scripts/e2e-unbind.mjs http://localhost:59577
 */
import { chromium } from "playwright";
import { viewScale } from "./view.mjs";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=unbind-e2e");
const api = (path, init = {}) =>
  page.evaluate(
    async ([p, i]) => {
      const r = await fetch(p, { ...i, headers: { "content-type": "application/json", ...(i.headers ?? {}) } });
      const t = await r.text();
      if (!r.ok) throw new Error(p + " -> " + r.status + " " + t.slice(0, 300));
      return t ? JSON.parse(t) : null;
    },
    [path, init]
  );

const created = await api("/api/plans", { method: "POST", body: JSON.stringify({ name: "unbind e2e" }) });
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);
const ops = (o) =>
  api("/api/plans/" + planId + "/ops", { method: "POST", body: JSON.stringify({ ops: [].concat(o) }) });

await ops([
  { op: "add_entity", spec: { type: "enemy", name: "boss", x: 0, y: 0, size: 140 } },
  { op: "add_entity", spec: { type: "player", name: "H1", job: "WHM", x: -250, y: 250 } },
]);
let doc = await load();
const h1 = doc.entities.find((e) => e.name === "H1");
await ops([
  {
    op: "add_entity",
    spec: {
      type: "zone",
      shape: "donut",
      name: "Donut",
      radius: 200,
      innerRadius: 120,
      anchor: { to: h1.id },
    },
  },
]);

/** The pose the canvas would draw for a named entity in the first step. */
const pose = (name) =>
  page.evaluate(
    async ([id, n]) => {
      const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
      const mod = await import("/src/shared/schema.ts");
      const e = mod.entitiesForStep(d, d.steps[0].id).find((x) => x.name === n);
      return e ? { x: Math.round(e.x), y: Math.round(e.y) } : null;
    },
    [planId, name]
  );

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(800);

const before = await pose("Donut");
if (!before || before.x !== h1.x || before.y !== h1.y) fail("the donut did not start on H1: " + JSON.stringify(before));

const box = await page.locator("canvas").first().boundingBox();
doc = await load();
const scale = viewScale(box.width, doc.arena.width);
const screen = (x, y) => ({ x: box.x + box.width / 2 + x * scale, y: box.y + box.height / 2 + y * scale });

// Click the annulus, clear of H1's token and of the boss.
const grab = screen(before.x, before.y + 160);
await page.mouse.click(grab.x, grab.y);
await page.waitForTimeout(500);

const unbind = page.getByRole("button", { name: /Unbind from H1/ });
if (!(await unbind.count())) fail("selecting the donut showed no Unbind button");
else {
  const shape = await unbind.boundingBox();
  if (!shape || shape.height < 20 || shape.width < 120)
    fail("the Unbind control is not a full button: " + JSON.stringify(shape));
  else console.log("the inspector offers a real button: " + Math.round(shape.width) + "x" + Math.round(shape.height));
  await page.screenshot({ path: "scripts/e2e-unbind.png" });
  await unbind.click();
  await page.waitForTimeout(700);
}

doc = await load();
const donut = doc.entities.find((e) => e.name === "Donut");
if (donut?.anchor) fail("pressing Unbind left the bait anchored to " + donut.anchor.to);
else console.log("pressing Unbind dropped the bait rule");

const frozen = await pose("Donut");
if (!frozen || Math.hypot(frozen.x - before.x, frozen.y - before.y) > 2)
  fail("unbinding moved the donut: " + JSON.stringify(before) + " -> " + JSON.stringify(frozen));
else console.log("it stayed where it was drawn: " + frozen.x + "," + frozen.y);

// H1 walks away; an unbound shape does not follow.
await ops([{ op: "update_entity", id: h1.id, patch: { x: 300, y: -300 } }]);
const after = await pose("Donut");
if (!after || Math.hypot(after.x - before.x, after.y - before.y) > 2)
  fail("the unbound donut still followed H1: " + JSON.stringify(after));
else console.log("H1 walked off and the donut stayed put");

// And the panel is gone: an unbound shape has no bait target to edit.
if (await page.getByRole("button", { name: /Unbind from/ }).count())
  fail("the Unbind button is still offered for a shape with no anchor");

if (errors.length) fail("page errors: " + errors.join(" | "));
await browser.close();
console.log(process.exitCode ? "FAILED" : "OK");
