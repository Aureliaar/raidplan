/**
 * The canvas under the hand. Every kind of thing can be grabbed and moved; a
 * click selects without gluing the token to the pointer and swaps the Add
 * palette for the inspector; a right-press opens the menu the Part owns rather
 * than dragging it; a tether, which has no pose of its own, is still a click
 * target; Shift-click gathers a set that one drag carries; the wheel sizes the
 * shape it is over; a box's edge and corner grips stretch out of the side you
 * pull and leave the side across from it standing, and win a press over a
 * player just beside them; a player wins a click over anything parked on it —
 * and a drop never flashes
 * back to where it started while the server is still answering.
 *
 * This exists because a `listening={false}` on the token art once made half the
 * canvas unclickable, and nothing else catches that: it typechecks and builds.
 */
import { check, drag, fail, finish, floor, menuAt, posed, session } from "./harness.mjs";

const DRAG_PX = { x: 60, y: -45 };
// No waymark here: a waymark is frozen on the step layer, which e2e-arena covers.
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

const s = await session("canvas-e2e", { height: 900 });
const { page } = s;
const plan = await s.createPlan({ name: "canvas e2e", withParty: false });
await plan.ops(SPECS.map(([, spec]) => ({ op: "add_entity", spec })));
// A big AoE added last used to cover everything and swallow every click on it.
await plan.ops({ op: "add_entity", spec: { type: "zone", shape: "circle", radius: 480, x: 0, y: 0 } });
await s.openPlan(plan.id, 2000);

const f = await floor(page);
let doc = await plan.load();
const step = doc.steps[0].id;

/* --- everything can be grabbed and moved ---------------------------------- */

const want = { x: Math.round(DRAG_PX.x / f.scale), y: Math.round(DRAG_PX.y / f.scale) };
for (const [label, spec] of SPECS) {
  const entity = doc.entities.find((e) => e.type === spec.type && e.x === spec.x && e.y === spec.y);
  const from = f.screen(entity.x, entity.y);
  await drag(page, from, { x: from.x + DRAG_PX.x, y: from.y + DRAG_PX.y }, { steps: 10, settle: 400 });
  const now = posed(await plan.load(), entity.id, step);
  const moved = { x: Math.round(now.x - entity.x), y: Math.round(now.y - entity.y) };
  check(Math.abs(moved.x - want.x) < 6 && Math.abs(moved.y - want.y) < 6, `${label} drags`, `moved (${moved.x}, ${moved.y})`);
}

/* --- a click selects, and only selects ------------------------------------ */

const palette = page.locator('[data-panel="palette"]');
const inspector = page.locator('[data-panel="inspector"]');
await f.deselect();
await palette.waitFor();
doc = await plan.load();
const h1 = posed(doc, "H1", step);
await f.click(h1.x, h1.y);
await inspector.waitFor();
if (await palette.count()) fail("the Add palette stayed up while a token is selected");
// Wander off to the sidebar and click something there, the way you would on the
// way to any button: `pickAt` starts a drag by hand, and a click with no
// movement used to leave the token latched to the pointer until this mouseup.
await page.mouse.move(1400, 420, { steps: 15 });
await page.locator("input.field").first().click();
await page.waitForTimeout(400);
// The inspector reads live client state, which is where a stuck drag shows.
const x = Number(await page.locator("input[type=number]").first().inputValue());
const y = Number(await page.locator("input[type=number]").nth(1).inputValue());
if (Math.abs(x - h1.x) > 2 || Math.abs(y - h1.y) > 2)
  fail(`H1 followed the pointer to ${x},${y} (should be ${Math.round(h1.x)},${Math.round(h1.y)})`);
// The two panels are tabs: Add comes back without giving up the selection, and
// the Details tab is only out when there is nothing under it to talk about.
await page.locator('[data-side-tab="add"]').click();
await palette.waitFor();
await page.keyboard.press("Tab");
await inspector.waitFor();
await page.keyboard.press("Tab");
await palette.waitFor();
await page.locator('[data-side-tab="details"]').click();
await inspector.waitFor();
if ((await page.locator("input.field").first().inputValue()) !== "H1")
  fail("the Details tab came back about something other than H1");
await inspector.locator("button", { hasText: "✕" }).click();
await palette.waitFor();
if (await inspector.count()) fail("the inspector stayed up after it was closed");
if (!(await page.locator('[data-side-tab="details"]').isDisabled()))
  fail("the Details tab is still offered with nothing selected");
console.log("a click swaps the palette for the inspector, Tab and the tabs switch back, and H1 stands still");

// A right-click brings the inspector with it, which sends a scrolled palette
// back to the top. That reset is the panel settling, not somebody scrolling
// out from under the menu, and it used to take the menu straight back down.
await page.locator("aside[data-panel] > div").last().evaluate((e) => (e.scrollTop = 400));
await page.waitForTimeout(200);
const scrolled = posed(await plan.load(), "boss", step);
const onBoss = f.screen(scrolled.x, scrolled.y);
await page.mouse.click(onBoss.x, onBoss.y, { button: "right" });
await page.waitForTimeout(400);
if (!(await page.locator("[data-context-menu]").count()))
  fail("the right-click menu died when the panel it swapped in reset the scroll");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
console.log("a right-click over a scrolled palette still opens its menu");

/* --- a right-press opens the menu the Part owns, and never drags ----------- */

doc = await plan.load();
const puddle = doc.entities.find((e) => e.type === "zone" && e.radius === 90);
const at = f.screen(puddle.x, puddle.y);
await page.mouse.move(at.x, at.y);
await page.mouse.down({ button: "right" });
await page.mouse.move(at.x + 120, at.y + 90, { steps: 10 });
await page.mouse.up({ button: "right" });
await page.waitForTimeout(400);
const held = (await plan.load()).entities.find((e) => e.id === puddle.id);
if (held.x !== puddle.x || held.y !== puddle.y) fail(`a right-press dragged the circle to ${held.x},${held.y}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);

await menuAt(page, at);
const rows = await page
  .locator("[data-context-menu]")
  .first()
  .locator("[data-menu-item]")
  .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-menu-item")));
for (const row of ["Move to Beat…", "Duplicate", "Send to back", "Bring to front", "Delete"])
  if (!rows.includes(row)) fail(`the circle's menu has no "${row}" row: ${rows.join(", ")}`);
await page.locator('[data-menu-item="Delete"]').click();
await page.waitForTimeout(600);
if (await page.locator("[data-context-menu]").count()) fail("the menu stayed up after Delete");
if ((await plan.load()).entities.some((e) => e.id === puddle.id)) fail("Delete left the circle in the plan");
console.log(`a right-press moved nothing; the right-click menu (${rows.join(", ")}) deleted the circle`);

/* --- a tether has no pose of its own, and is still a click target ---------- */

await plan.ops({ op: "add_entity", spec: { type: "player", job: "WAR", name: "MT", x: 250, y: 150 } });
doc = await plan.load();
const [p1, p2] = [posed(doc, "H1", step), posed(doc, "MT", step)];
const tetherId = (
  await plan.ops({ op: "add_entity", spec: { type: "tether", from: p1.id, to: p2.id, style: "close" } })
).values[0].id;
await page.waitForTimeout(600);
await f.click((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
if (!(await page.locator("aside").innerText()).includes(tetherId)) fail("clicking a tether did not select it");
console.log("clicking the middle of a tether selects it");

/* --- Shift-click gathers a set, and one drag carries all of it -------------- */

await f.deselect();
doc = await plan.load();
const [boss, mt, h1Was] = ["boss", "MT", "H1"].map((n) => posed(doc, n, step));
await f.click(boss.x, boss.y);
await page.keyboard.down("Shift");
await f.click(mt.x, mt.y);
await page.keyboard.up("Shift");
await drag(page, f.screen(boss.x, boss.y), f.screen(boss.x + 70, boss.y + 45));
doc = await plan.load();
const [b, m, h] = ["boss", "MT", "H1"].map((n) => posed(doc, n, step));
if (Math.hypot(b.x - boss.x - 70, b.y - boss.y - 45) > 8) fail(`the grabbed token landed at ${b.x},${b.y}`);
if (Math.hypot(m.x - mt.x - 70, m.y - mt.y - 45) > 8) fail(`the other selected token did not come along: ${m.x},${m.y}`);
if (h.x !== h1Was.x || h.y !== h1Was.y) fail("a token outside the selection moved with it");
console.log("Shift-click gathered the boss and MT, and one drag carried both");

/* --- the wheel sizes the shape under it, ring and hole together ------------ */

await f.deselect();
doc = await plan.load();
const donut = doc.entities.find((e) => e.shape === "donut");
const ring = f.screen(donut.x, donut.y + (donut.radius + donut.innerRadius) / 2);
await page.mouse.move(ring.x, ring.y);
for (let i = 0; i < 2; i++) await page.mouse.wheel(0, -120);
await page.waitForTimeout(700);
const grown = (await plan.load()).entities.find((e) => e.id === donut.id);
const factor = grown.radius / donut.radius;
if (Math.abs(factor - 1.08 ** 2) > 0.03) fail(`two notches scaled the donut by ${factor.toFixed(3)}`);
if (Math.abs(grown.innerRadius / donut.innerRadius - factor) > 0.05)
  fail(`the hole did not keep up with the ring: ${grown.innerRadius}/${grown.radius}`);
console.log(`two notches of the wheel over the donut: ${donut.radius}/${donut.innerRadius} -> ${grown.radius}/${grown.innerRadius}`);

/* --- a grip stretches the side you pull, not both -------------------------- */

// |-C-| pulled by its right pill is |-C---|, never |--C--|: the held edge walks
// and the one across from it stands still, which means the dimension and the
// pose travel together. A corner does it on both axes at once, anchored on the
// corner diagonally across the box.
await f.deselect();
await plan.ops({
  op: "add_entity",
  spec: { type: "zone", shape: "rect", width: 200, length: 120, x: 0, y: -150 },
});
await page.waitForTimeout(600);
const rect = (await plan.load()).entities.find((e) => e.shape === "rect");
const box = (id, doc) => {
  const e = doc.entities.find((candidate) => candidate.id === id);
  return { w: e.width, l: e.length, left: e.x - e.width / 2, top: e.y - e.length / 2 };
};
await f.click(rect.x, rect.y);
await inspector.waitFor();

let was = box(rect.id, await plan.load());
await f.measure();
const pill = f.screen(rect.x + rect.width / 2, rect.y);
await drag(page, pill, { x: pill.x + 60 * f.scale, y: pill.y }, { steps: 10, settle: 700 });
let now = box(rect.id, await plan.load());
check(
  Math.abs(now.w - (was.w + 60)) < 6 && Math.abs(now.left - was.left) < 3 && Math.abs(now.l - was.l) < 1,
  "the right edge pill stretches rightwards only",
  `width ${was.w} -> ${now.w}, left edge ${was.left} -> ${now.left}`
);

was = now;
const wide = (await plan.load()).entities.find((e) => e.id === rect.id);
await f.measure();
const se = f.screen(wide.x + wide.width / 2, wide.y + wide.length / 2);
await drag(page, se, { x: se.x + 40 * f.scale, y: se.y + 30 * f.scale }, { steps: 10, settle: 700 });
now = box(rect.id, await plan.load());
check(
  Math.abs(now.w - (was.w + 40)) < 6 &&
    Math.abs(now.l - (was.l + 30)) < 6 &&
    Math.abs(now.left - was.left) < 3 &&
    Math.abs(now.top - was.top) < 3,
  "the SE corner stretches out of the NW one",
  `${was.w}x${was.l} -> ${now.w}x${now.l}, NW corner ${was.left},${was.top} -> ${now.left},${now.top}`
);

/* --- a grip beats what is under it, and a player beats every other thing --- */

// H1 stands on the rect's right pill. A press on H1 just past the pill's own
// disc still takes the grip: sizing what is selected beats selecting anew.
const sized = (await plan.load()).entities.find((e) => e.id === rect.id);
await f.measure();
const pillAt = { x: sized.x + sized.width / 2, y: sized.y };
const standing = posed(await plan.load(), "H1", step);
await plan.ops({
  op: "update_entity",
  id: standing.id,
  stepId: step,
  patch: { x: Math.round(pillAt.x), y: Math.round(pillAt.y + 20 / f.scale) },
});
await page.waitForTimeout(700);
const nearPill = f.screen(pillAt.x, pillAt.y + 22 / f.scale);
await drag(page, nearPill, { x: nearPill.x + 50 * f.scale, y: nearPill.y }, { steps: 10, settle: 700 });
doc = await plan.load();
const pulled = doc.entities.find((e) => e.id === rect.id);
const stood = posed(doc, "H1", step);
check(
  Math.abs(pulled.width - (sized.width + 50)) < 8 && stood.x === Math.round(pillAt.x),
  "a press on a player beside a grip takes the grip",
  `width ${sized.width} -> ${pulled.width}, H1 x ${Math.round(pillAt.x)} -> ${stood.x}`
);

// A small icon parked on H1 covers less ground than H1 does, and still loses.
await f.deselect();
const marker = doc.entities.find((e) => e.type === "icon");
await plan.ops({ op: "update_entity", id: marker.id, patch: { size: 30, x: stood.x, y: stood.y } });
await page.waitForTimeout(700);
await f.click(stood.x, stood.y);
check(
  (await page.locator("aside").innerText()).includes(stood.id),
  "a click on a player under a smaller icon picks the player"
);
await f.deselect();
await plan.ops({ op: "update_entity", id: marker.id, patch: { size: marker.size, x: marker.x, y: marker.y } });
await page.waitForTimeout(700);

/* --- a drop holds still while the server answers ---------------------------- */

// The release contract in AGENTS.md: from mouseup to the server's answer no
// frame may show the old position. Hold the request and watch every paint.
await f.deselect();
doc = await plan.load();
const icon = posed(doc, doc.entities.find((e) => e.type === "icon").id, step);
let answer;
await page.route(
  `**/api/plans/${plan.id}/ops`,
  async (route) => {
    await new Promise((resolve) => (answer = resolve));
    await route.continue();
  },
  { times: 1 }
);
const grab = f.screen(icon.x, icon.y);
const to = f.screen(icon.x + 100, icon.y + 80);
await page.mouse.move(grab.x, grab.y);
await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 10 });
await page.mouse.up();
const frames = await page.evaluate(
  (id) =>
    new Promise((done) => {
      const seen = [];
      const tick = () => {
        const n = window.Konva.stages[0].findOne("#" + id);
        seen.push(n ? [n.x(), n.y()] : null);
        if (seen.length < 30) requestAnimationFrame(tick);
        else done(seen);
      };
      tick();
    }),
  icon.id
);
if (!answer) fail("the drop sent nothing to the server");
const stale = posed(await plan.load(), icon.id, step);
if (Math.hypot(stale.x - icon.x, stale.y - icon.y) > 1) fail("the request was not actually held, so this proves nothing");
const [dropX, dropY] = frames[0] ?? [icon.x, icon.y];
if (Math.hypot(dropX - icon.x, dropY - icon.y) < 50) fail("the icon was drawn back at its start right after the drop");
if (frames.some((p) => !p || Math.hypot(p[0] - dropX, p[1] - dropY) > 1))
  fail("the icon moved between the drop and the server's answer: " + JSON.stringify(frames));
answer();
await page.waitForTimeout(700);
const landed = posed(await plan.load(), icon.id, step);
if (Math.hypot(landed.x - dropX, landed.y - dropY) > 3)
  fail(`the server's answer moved the icon from where it was dropped: ${landed.x},${landed.y}`);
console.log("the dropped icon held its spot through 30 paints while the server was held, and that spot committed");

await finish(s, "OK - " + plan.url);
