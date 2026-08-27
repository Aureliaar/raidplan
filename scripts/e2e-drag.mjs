/**
 * Canvas regression test: can you actually grab and move every kind of entity?
 *
 * This exists because a `listening={false}` on the token art once made half the
 * canvas unclickable, and nothing else catches that — it typechecks and builds fine.
 *
 *   npm run dev                       # in another terminal
 *   npm run e2e -- http://localhost:5173
 *
 * Needs the dev-mode local sign-in (no Discord credentials configured).
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:5173").replace(/\/$/, "");
const DRAG_PX = { x: 60, y: -45 };

// No waymark here on purpose: a waymark is frozen on the step layer and only
// moves on its own one, which is what scripts/e2e-markers.mjs checks.
const SPECS = [
  ["player", { type: "player", job: "WHM", name: "H1", x: -350, y: -350, rotation: 135 }],
  ["enemy", { type: "enemy", name: "boss", size: 120, x: 350, y: -350, rotation: 180 }],
  ["icon", { type: "icon", src: "marker/attack1", size: 90, x: -350, y: 0 }],
  ["zone circle", { type: "zone", shape: "circle", radius: 90, x: 0, y: 0 }],
  ["zone cone", { type: "zone", shape: "cone", radius: 200, angle: 60, x: 350, y: 0 }],
  ["zone donut", { type: "zone", shape: "donut", radius: 120, innerRadius: 60, x: -350, y: 350 }],
  ["zone hollow", { type: "zone", shape: "circle", radius: 100, hollow: true, x: 0, y: 350 }],
  ["text", { type: "text", text: "stack here", fontSize: 40, x: 350, y: 350 }],
];

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));

await page.goto(`${base}/auth/dev?name=e2e`, { waitUntil: "domcontentloaded" });
const api = page.request;

const { id } = await (
  await api.post(`${base}/api/plans`, { data: { name: "e2e drag", withParty: false } })
).json();
await api.post(`${base}/api/plans/${id}/ops`, {
  data: { ops: SPECS.map(([, spec]) => ({ op: "add_entity", spec })) },
});
// A big AoE added last used to cover the party and swallow every click on it.
await api.post(`${base}/api/plans/${id}/ops`, {
  data: { ops: [{ op: "add_entity", spec: { type: "zone", shape: "circle", radius: 480, x: 0, y: 0 } }] },
});

await page.goto(`${base}/p/${id}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas");
await page.waitForTimeout(2000);

const read = async () => (await (await api.get(`${base}/api/plans/${id}`)).json()).plan;
const before = await read();
const step = before.steps[0].id;
const box = await page.locator("canvas").first().boundingBox();
const size = box.width;
const scale = size / Math.max(before.arena.width, before.arena.height);
const expected = { x: Math.round(DRAG_PX.x / scale), y: Math.round(DRAG_PX.y / scale) };

let failed = 0;
for (const entity of before.entities.filter((e) => e.name === "H1" || e.name === "boss")) {
  const labelRotation = await page.evaluate((id) => {
    const label = window.Konva.stages[0]?.findOne(`#${id}`)?.findOne(".entity-name");
    return label?.getAbsoluteTransform().decompose().rotation;
  }, entity.id);
  const upright = labelRotation !== undefined && Math.abs(labelRotation) < 0.01;
  console.log(`${upright ? "PASS" : "FAIL"} ${entity.name.padEnd(12)} label upright`);
  if (!upright) failed++;
}

for (const [label, spec] of SPECS) {
  const entity = before.entities.find((e) => e.type === spec.type && e.x === spec.x && e.y === spec.y);
  const from = { x: box.x + size / 2 + entity.x * scale, y: box.y + size / 2 + entity.y * scale };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + DRAG_PX.x, from.y + DRAG_PX.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const raw = (await read()).entities.find((e) => e.id === entity.id);
  const now = { ...raw, ...(raw.overrides?.[step] ?? {}) };
  const moved = { x: Math.round(now.x - entity.x), y: Math.round(now.y - entity.y) };
  const ok = Math.abs(moved.x - expected.x) < 6 && Math.abs(moved.y - expected.y) < 6;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label.padEnd(12)} moved (${moved.x}, ${moved.y})`);
}

// Selection: clicking anything — including a tether, which is positioned by its
// endpoints and so never draggable — must put it in the inspector.
await api.post(`${base}/api/plans/${id}/ops`, {
  data: { ops: [{ op: "add_entity", spec: { type: "player", job: "WAR", name: "MT", x: 250, y: 150 } }] },
});
// Poses, not base coords: the drags above were written as step overrides.
const pose = (e) => ({ ...e, ...(e.overrides?.[step] ?? {}) });
const [p1, p2] = (await read()).entities.filter((e) => e.type === "player").map(pose);
await api.post(`${base}/api/plans/${id}/ops`, {
  data: { ops: [{ op: "add_entity", spec: { type: "tether", from: p1.id, to: p2.id, style: "close" } }] },
});
await page.waitForTimeout(600);

const tether = (await read()).entities.find((e) => e.type === "tether");
const mid = {
  x: box.x + size / 2 + ((p1.x + p2.x) / 2) * scale,
  y: box.y + size / 2 + ((p1.y + p2.y) / 2) * scale,
};
await page.mouse.click(mid.x, mid.y);
await page.waitForTimeout(300);
const inspector = await page.locator("aside").innerText();
const selectedTether = inspector.includes(tether.id);
console.log(`${selectedTether ? "PASS" : "FAIL"} tether       selectable`);
if (!selectedTether) failed++;

if (errors.length) console.log("page errors:\n" + errors.slice(0, 5).join("\n"));
await api.delete(`${base}/api/plans/${id}`);
await browser.close();

console.log(failed ? `${failed} check(s) failed` : `all ${SPECS.length} draggable, tether selectable`);
process.exit(failed || errors.length ? 1 : 0);
