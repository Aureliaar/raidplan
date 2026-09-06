/** Contextual selection pins resize a selected canvas entity directly. */
import { chromium } from "playwright";
import { viewScale } from "./view.mjs";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const api = (path, init = {}) =>
  page.evaluate(
    async ([p, i]) => {
      const response = await fetch(p, {
        ...i,
        headers: { "content-type": "application/json", ...(i.headers ?? {}) },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${p} -> ${response.status} ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : null;
    },
    [path, init]
  );

await page.goto(base + "/auth/dev?name=pins-e2e");
const created = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "selection pins e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(700);

const canvas = page.locator("canvas").first();
const box = await canvas.boundingBox();
const plan = await api("/api/plans/" + planId).then((value) => value.plan ?? value);
const actor = plan.entities.find((entity) => entity.type === "player");
const pose = actor.overrides?.[plan.steps[0].id] ?? actor;
const scale = viewScale(box.width);
const at = (x, y) => ({
  x: box.x + box.width / 2 + x * scale,
  y: box.y + box.height / 2 + y * scale,
});

await page.mouse.click(...Object.values(at(pose.x, pose.y)));
await page.waitForTimeout(150);
// The resize tick rides the selection ring at its south-east point; dragging
// it away from the token's centre grows the token.
const ring = (actor.size / 2 + 14) * actor.scale * Math.SQRT1_2;
const corner = at(pose.x + ring, pose.y + ring);
await page.mouse.move(corner.x, corner.y);
await page.mouse.down();
await page.mouse.move(corner.x + 34, corner.y + 34, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(700);

const changed = await api("/api/plans/" + planId).then((value) => value.plan ?? value);
const after = changed.entities.find((entity) => entity.id === actor.id);
const afterPose = { ...after, ...(after.overrides?.[changed.steps[0].id] ?? {}) };
if (afterPose.size <= actor.size + 3) {
  console.error(`FAIL: corner pin left size at ${afterPose.size}`);
  process.exitCode = 1;
} else if (afterPose.scale !== actor.scale) {
  console.error(`FAIL: corner pin changed generic scale to ${afterPose.scale}`);
  process.exitCode = 1;
} else {
  console.log(`OK - corner pin used the wheel's size field: ${actor.size} -> ${afterPose.size}`);
}

// A beam is a rect zone: its side edge carries a width grip and its front
// edge a length grip, each editing that one dimension.
const beam = await api(`/api/plans/${planId}/ops`, {
  method: "POST",
  body: JSON.stringify({
    ops: [
      {
        op: "add_entity",
        // Clear of the PF clock spots (radius 350) and the boss's grab disc.
        spec: { type: "zone", shape: "rect", x: 150, y: 100, width: 160, length: 400 },
      },
    ],
  }),
}).then((r) => (r.plan ?? r).entities.find((e) => e.type === "zone" && e.shape === "rect"));
await page.waitForTimeout(400);
await page.mouse.click(...Object.values(at(beam.x, beam.y)));
await page.waitForTimeout(150);

// Rotation 0: the width grip sits on the east edge; drag it further east.
const side = at(beam.x + beam.width / 2, beam.y);
await page.mouse.move(side.x, side.y);
await page.mouse.down();
await page.mouse.move(side.x + 40, side.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(700);
// Like the token resize, the edit lands as this step's pose override.
const beamPose = (p) => {
  const e = (p.plan ?? p).entities.find((x) => x.id === beam.id);
  return { ...e, ...(e.overrides?.[(p.plan ?? p).steps[0].id] ?? {}) };
};
let zone = await api("/api/plans/" + planId).then(beamPose);
if (zone.width <= beam.width + 20 || Math.abs(zone.length - beam.length) > 1) {
  console.error(`FAIL: width grip gave width=${zone.width} length=${zone.length}`);
  process.exitCode = 1;
} else console.log(`OK - side grip widened the beam alone: ${beam.width} -> ${zone.width}`);

// The length grip sits on the front (north) edge; drag it toward the wall.
const front = at(beam.x, beam.y - zone.length / 2);
await page.mouse.move(front.x, front.y);
await page.mouse.down();
await page.mouse.move(front.x, front.y - 50, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(700);
const stretched = await api("/api/plans/" + planId).then(beamPose);
if (stretched.length <= zone.length + 20 || Math.abs(stretched.width - zone.width) > 1) {
  console.error(`FAIL: length grip gave width=${stretched.width} length=${stretched.length}`);
  process.exitCode = 1;
} else console.log(`OK - front grip stretched the beam alone: ${zone.length} -> ${stretched.length}`);

// The grips are paired: the west edge carries a width grip too.
const west = at(beam.x - stretched.width / 2, beam.y);
await page.mouse.move(west.x, west.y);
await page.mouse.down();
await page.mouse.move(west.x - 30, west.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(700);
const wider = await api("/api/plans/" + planId).then(beamPose);
if (wider.width <= stretched.width + 15 || Math.abs(wider.length - stretched.length) > 1) {
  console.error(`FAIL: west grip gave width=${wider.width} length=${wider.length}`);
  process.exitCode = 1;
} else console.log(`OK - opposite edge carries the same grip: ${stretched.width} -> ${wider.width}`);
await browser.close();
