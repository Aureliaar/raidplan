/**
 * Waymarks live on their own layer.
 *
 * They are placed before the pull and never move again, so a drag aimed at a
 * mechanic must never nudge one, and moving one deliberately must move it for
 * the whole plan rather than for the step you happen to be looking at.
 *
 *   node scripts/e2e-markers.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=marker-e2e");
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
  body: JSON.stringify({ name: "marker e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const ops = (list) =>
  api("/api/plans/" + planId + "/ops", { method: "POST", body: JSON.stringify({ ops: list }) });
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);

await ops([{ op: "add_waymarks" }, { op: "add_step", name: "two" }]);

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

const canvas = page.locator("canvas").first();
const box = await canvas.boundingBox();
const scale = box.width / 1000;
const screen = (x, y) => ({ x: box.x + box.width / 2 + x * scale, y: box.y + box.height / 2 + y * scale });

let doc = await load();
const markerA = doc.entities.find((e) => e.type === "marker" && e.marker === "A");
if (!markerA) throw new Error("no waymark A to test with");
const step1 = doc.steps[0].id;
const step2 = doc.steps[1].id;

const drag = async (from, to) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(600);
};

// On the step layer a waymark is scenery: dragging it must do nothing at all.
await drag(screen(markerA.x, markerA.y), screen(markerA.x + 220, markerA.y + 220));
doc = await load();
let a = doc.entities.find((e) => e.id === markerA.id);
if (a.x !== markerA.x || a.y !== markerA.y || a.overrides?.[step1])
  fail("a drag on the step layer moved waymark A to " + a.x + "," + a.y);
else console.log("waymark A ignored a drag on the step layer");

// And it does not steal the click either: nothing gets selected.
await page.mouse.click(...Object.values(screen(markerA.x, markerA.y)));
await page.waitForTimeout(300);
if ((await page.locator('[data-panel="palette"]').count()) !== 1)
  fail("clicking a frozen waymark selected something");
else console.log("clicking a frozen waymark selects nothing");

// Up on the waymark layer it moves, and every other thing freezes instead.
await page.getByRole("button", { name: "move waymarks" }).click();
await page.waitForTimeout(300);

const mt = doc.entities.find((e) => e.name === "MT");
await drag(screen(mt.x, mt.y), screen(mt.x + 200, mt.y));
doc = await load();
const mtAfter = doc.entities.find((e) => e.id === mt.id);
if (mtAfter.x !== mt.x || mtAfter.overrides?.[step1]) fail("a player moved while on the waymark layer");
else console.log("players are frozen while the waymark layer is up");

const want = { x: markerA.x + 180, y: markerA.y + 140 };
await drag(screen(markerA.x, markerA.y), screen(want.x, want.y));
doc = await load();
a = doc.entities.find((e) => e.id === markerA.id);
if (Math.hypot(a.x - want.x, a.y - want.y) > 25)
  fail("waymark A did not move on its own layer: " + a.x + "," + a.y);
else if (a.overrides?.[step1] || a.overrides?.[step2])
  fail("moving a waymark wrote a per-step override");
else console.log("on its own layer waymark A moved for the whole plan: " + Math.round(a.x) + "," + Math.round(a.y));

// The mark is the same in every step, even one it was never added to.
const inStep2 = await page.evaluate(
  async ([id, mid, sid]) => {
    const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
    const drawn = (await import("/src/shared/schema.ts")).entitiesForStep(d, sid);
    const m = drawn.find((e) => e.id === mid);
    return m ? { x: m.x, y: m.y } : null;
  },
  [planId, markerA.id, step2]
);
if (!inStep2 || Math.hypot(inStep2.x - a.x, inStep2.y - a.y) > 1)
  fail("waymark A is not where it was put in the second step: " + JSON.stringify(inStep2));
else console.log("the same waymark, same spot, in a step it was never added to");

// Back down, and the step layer works exactly as before.
await page.getByRole("button", { name: "done with waymarks" }).click();
await page.waitForTimeout(300);
await drag(screen(mt.x, mt.y), screen(mt.x + 200, mt.y));
doc = await load();
const moved = doc.entities.find((e) => e.id === mt.id);
const pose = moved.overrides?.[step1] ?? moved;
if (Math.hypot(pose.x - (mt.x + 200), pose.y - mt.y) > 25) fail("the step layer did not come back");
else console.log("back on the step layer the party drags again");

/* --- and the PF clock is laid out against those marks --------------------- */

// Each slot stands on the mark it is named for: that is what "PF positions" is.
const ON_MARK = { MT: "A", R2: "2", H2: "B", M2: "3", OT: "C", M1: "4", H1: "D", R1: "1" };
await page.getByRole("button", { name: "Close inspector" }).click();
await page.getByRole("button", { name: "standard markers" }).click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: "PF positions" }).click();
await page.waitForTimeout(700);
doc = await load();
const poseOf = (e) => e.overrides?.[step1] ?? e;
const off = [];
for (const [slot, mark] of Object.entries(ON_MARK)) {
  const who = doc.entities.find((e) => e.type === "player" && e.name === slot);
  const m = doc.entities.find((e) => e.type === "marker" && e.marker === mark);
  if (!who || !m) {
    off.push(slot + " missing");
    continue;
  }
  // Same bearing as the mark, a little inside it: on it and you cannot see it.
  const p = poseOf(who);
  const bearing = (x, y) => (Math.atan2(x, -y) * 180) / Math.PI;
  const inBy = Math.hypot(m.x, m.y) - Math.hypot(p.x, p.y);
  if (Math.abs(((bearing(p.x, p.y) - bearing(m.x, m.y) + 540) % 360) - 180) > 4)
    off.push(`${slot} is not on ${mark}'s bearing`);
  else if (inBy < 20 || inBy > 90) off.push(`${slot} sits ${Math.round(inBy)} inside ${mark}`);
}
if (off.length) fail("PF positions did not line up with the marks: " + off.join(", "));
else console.log("PF positions lines all eight up just inside their waymarks, melees on 4 and 3");

console.log(process.exitCode ? "FAILED" : "OK - waymarks are frozen scenery until you say otherwise");
await browser.close();
