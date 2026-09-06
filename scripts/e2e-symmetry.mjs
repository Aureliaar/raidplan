/**
 * Symmetry controls create persistent copies, and moving an older player finds
 * its same-role counterpart even though neither player has symmetry metadata.
 *
 *   npm run dev
 *   node scripts/e2e-symmetry.mjs http://localhost:5173
 */
import { chromium } from "playwright";
import { viewScale } from "./view.mjs";

const base = (process.argv[2] ?? "http://localhost:5173").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (
  await browser.newContext({ viewport: { width: Number(process.env.SYMMETRY_WIDTH ?? 1900), height: 1000 } })
).newPage();
const fail = (message) => {
  console.error("FAIL:", message);
  process.exitCode = 1;
};

await page.goto(`${base}/auth/dev?name=symmetry-e2e`);
const api = (path, init = {}) =>
  page.evaluate(
    async ([url, options]) => {
      const response = await fetch(url, {
        ...options,
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`${url} -> ${response.status} ${body.slice(0, 300)}`);
      return body ? JSON.parse(body) : null;
    },
    [path, init]
  );
const created = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "symmetry e2e", withParty: false }),
});
const id = (created.plan ?? created).id;
await api(`/api/plans/${id}/ops`, {
  method: "POST",
  body: JSON.stringify({
    ops: [
      { op: "add_entity", spec: { type: "player", job: "WAR", name: "MT", x: -220, y: -120 } },
      { op: "add_entity", spec: { type: "player", job: "PLD", name: "OT", x: 220, y: 120 } },
    ],
  }),
});
await page.goto(`${base}/p/${id}`);
await page.waitForSelector("canvas");
await page.waitForTimeout(1000);

const canvas = page.locator("canvas").first();
let box = await canvas.boundingBox();
let scale = viewScale(box.width);
const at = (x, y) => ({ x: box.x + box.width / 2 + x * scale, y: box.y + box.height / 2 + y * scale });
const read = async () => (await api(`/api/plans/${id}`)).plan;
let plan = await read();
let mt = plan.entities.find((e) => e.name === "MT");
let ot = plan.entities.find((e) => e.name === "OT");

// Key 2 enables two-way; Q changes the transform to rotation. These players
// were made through the API and therefore deliberately have no saved group.
await page.mouse.click(800, 500);
await page.keyboard.press("2");
await page.keyboard.press("q");
await page.locator("header select").selectOption("all");
const from = at(-220, -120);
const to = at(120, -220);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 12 });
await page.waitForTimeout(200);

const live = await page.evaluate(
  ([otherId]) => {
    const stage = window.Konva.stages[0];
    const other = stage.findOne("#" + otherId);
    return {
      other: other ? { x: Math.round(other.x()), y: Math.round(other.y()) } : null,
      selected: stage.find(".selection").map((ring) => ring.getParent()?.id()).filter(Boolean),
    };
  },
  [ot.id]
);
if (!live.other || Math.hypot(live.other.x + 120, live.other.y - 220) > 12)
  fail(`counterpart waited for drop instead of moving live: ${JSON.stringify(live.other)}`);
else console.log("mid-drag: rotational counterpart is already moving");
if (!live.selected.includes(mt.id) || !live.selected.includes(ot.id))
  fail(`counterparts are not both selected: ${live.selected.join(", ")}`);
else console.log("selection rings appear on both matched players");

await page.mouse.up();
await page.waitForTimeout(700);

plan = await read();
mt = plan.entities.find((e) => e.name === "MT");
ot = plan.entities.find((e) => e.name === "OT");
if (Math.hypot(mt.x - 120, mt.y + 220) > 8) fail(`MT orbited to ${mt.x},${mt.y}`);
if (Math.hypot(ot.x + 120, ot.y - 220) > 8)
  fail(`same-role rotational counterpart moved to ${ot.x},${ot.y}`);
else console.log("loose same-role player counterpart follows a rotational move");

// Party symmetry uses encounter pairings rather than exact job roles. In
// particular BRD R1 and BLM R2 are the ranged pair, while four-way matching
// spans all four supports or all four damage dealers.
await api(`/api/plans/${id}/ops`, {
  method: "POST",
  body: JSON.stringify({
    ops: [
      { op: "update_entity", id: mt.id, patch: { x: -140, y: -140 } },
      { op: "update_entity", id: ot.id, patch: { x: 140, y: 140 } },
      { op: "add_entity", spec: { type: "player", job: "WHM", name: "H1", x: 140, y: -140 } },
      { op: "add_entity", spec: { type: "player", job: "SCH", name: "H2", x: -140, y: 140 } },
      { op: "add_entity", spec: { type: "player", job: "BRD", name: "R1", x: -270, y: -270 } },
      { op: "add_entity", spec: { type: "player", job: "BLM", name: "R2", x: 270, y: -270 } },
      { op: "add_entity", spec: { type: "player", job: "SAM", name: "M1", x: 270, y: 270 } },
      { op: "add_entity", spec: { type: "player", job: "DRG", name: "M2", x: -270, y: 270 } },
    ],
  }),
});
await page.reload();
await page.waitForSelector("canvas");
await page.waitForTimeout(700);
box = await canvas.boundingBox();
scale = viewScale(box.width);
await page.locator("header select").selectOption("all");
const dragPlayer = async (name, dx, dy) => {
  const current = await read();
  const player = current.entities.find((e) => e.name === name);
  const point = await page.evaluate(
    (playerId) => window.Konva.stages[0].findOne("#" + playerId)?.getAbsolutePosition(),
    player.id
  );
  await page.mouse.move(box.x + point.x, box.y + point.y);
  await page.mouse.down();
  await page.mouse.move(box.x + point.x + dx * scale, box.y + point.y + dy * scale, { steps: 10 });
  await page.mouse.up();
};

await page.mouse.click(800, 500);
await page.keyboard.press("2");
await dragPlayer("R1", 20, 20);
await page.waitForTimeout(600);
plan = await read();
let r1 = plan.entities.find((e) => e.name === "R1");
let r2 = plan.entities.find((e) => e.name === "R2");
if (Math.hypot(r2.x - 250, r2.y + 250) > 8)
  fail(`two-way R1/R2 pairing left R1/R2 at ${r1.x},${r1.y} / ${r2.x},${r2.y}`);
else console.log("two-way symmetry pairs physical-ranged R1 with caster R2");

await page.getByRole("button", { name: "3: 4-way" }).click();
await dragPlayer("R1", 20, 20);
await page.waitForTimeout(600);
plan = await read();
const damageExpected = { R1: [-230, -230], R2: [230, -230], M1: [230, 230], M2: [-230, 230] };
if (
  Object.entries(damageExpected).some(([name, [x, y]]) => {
    const player = plan.entities.find((e) => e.name === name);
    return !player || Math.hypot(player.x - x, player.y - y) > 8;
  })
)
  fail("four-way symmetry did not move all four damage dealers");
else console.log("four-way symmetry moves all four damage dealers");

await dragPlayer("MT", 20, 20);
await page.waitForTimeout(600);
plan = await read();
const supportExpected = { MT: [-120, -120], H1: [120, -120], OT: [120, 120], H2: [-120, 120] };
if (
  Object.entries(supportExpected).some(([name, [x, y]]) => {
    const player = plan.entities.find((e) => e.name === name);
    return !player || Math.hypot(player.x - x, player.y - y) > 8;
  })
)
  fail("four-way symmetry did not move all four supports");
else console.log("four-way symmetry moves all four supports");

// Exercise persistent symmetric creation as well: drop one circle.
// The contextual rail shows the selected player's inspector after a drag;
// close it to return to the palette before starting a creation gesture.
const inspector = page.locator('[data-panel="inspector"]');
if (await inspector.count()) {
  await inspector.locator("button", { hasText: "✕" }).click();
  await page.locator('[data-panel="palette"]').waitFor();
}
const target = { x: box.width / 2 - 190 * scale, y: box.height / 2 - 140 * scale };
const circleChip = page.getByText("Circle", { exact: true });
const chipBox = await circleChip.boundingBox();
await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + target.x, box.y + target.y, { steps: 12 });
await page.waitForTimeout(200);
const readDropPreview = () => page.evaluate(() =>
  window.Konva.stages[0].find(".drop-preview").map((node) => ({
    x: Math.round(node.x()),
    y: Math.round(node.y()),
  }))
);
let dropPreview = await readDropPreview();
const previewExpected = [
  [-190, -140],
  [190, -140],
  [190, 140],
  [-190, 140],
];
if (
  previewExpected.some(
    ([x, y]) => !dropPreview.some((e) => Math.hypot(e.x - x, e.y - y) < 8)
  )
)
  fail(`circle drop had no four-way preview before mouseup: ${JSON.stringify(dropPreview)}`);
else console.log("before drop: the circle previews all four mirrored copies at full arena size");

// Pointer-driven palette dragging keeps normal keyboard input alive. Switch to
// two-way, Rotate, and four-way without restarting the drag.
await page.keyboard.press("2");
await page.waitForTimeout(100);
dropPreview = await readDropPreview();
if (
  dropPreview.length !== 2 ||
  !dropPreview.some((e) => Math.hypot(e.x + 190, e.y + 140) < 8) ||
  !dropPreview.some((e) => Math.hypot(e.x - 190, e.y + 140) < 8)
)
  fail(`count did not change to two-way while dragging: ${JSON.stringify(dropPreview)}`);
else console.log("held drag: count changes update the preview immediately");
await page.keyboard.press("q");
await page.waitForTimeout(100);
dropPreview = await readDropPreview();
if (!dropPreview.some((e) => Math.hypot(e.x - 190, e.y - 140) < 8))
  fail(`mode did not change to rotation while dragging: ${JSON.stringify(dropPreview)}`);
else console.log("held drag: mirror/rotate changes update the preview immediately");
await page.keyboard.press("3");
await page.waitForTimeout(100);
const rotateExpected = [
  [-190, -140],
  [140, -190],
  [190, 140],
  [-140, 190],
];
dropPreview = await readDropPreview();
if (
  rotateExpected.some(
    ([x, y]) => !dropPreview.some((e) => Math.hypot(e.x - x, e.y - y) < 8)
  )
)
  fail(`four-way rotation did not update while dragging: ${JSON.stringify(dropPreview)}`);
const beforeCreate = await read();
if (beforeCreate.entities.some((e) => e.type === "zone" && e.shape === "circle"))
  fail("circle placement committed before mouseup");
// Hold the write off the server long enough to inspect the first post-drop
// paint. The preview must hand directly to optimistic persistent entities.
await page.route(`**/api/plans/${id}/ops`, async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  await route.continue();
}, { times: 1 });
await page.mouse.up();
await page.waitForTimeout(50);
const handoff = await page.evaluate(() => ({
  previews: window.Konva.stages[0].find(".drop-preview").length,
  circles: window.Konva.stages[0]
    .find(".entity")
    .filter((node) => node.id().startsWith("zone_"))
    .map((node) => ({ x: Math.round(node.x()), y: Math.round(node.y()) })),
}));
if (handoff.previews || handoff.circles.length !== 4)
  fail(`drop handoff flashed before the server reply: ${JSON.stringify(handoff)}`);
else console.log("mouseup hands the preview directly to persistent entities without a blank frame");
await page.waitForTimeout(700);

plan = await read();
const circles = plan.entities.filter((e) => e.type === "zone" && e.shape === "circle");
if (circles.length !== 4) fail(`four-way mirror made ${circles.length} circles`);
else if (
  rotateExpected.some(([x, y]) => !circles.some((e) => Math.hypot(e.x - x, e.y - y) < 8))
)
  fail("four-way rotation did not commit the held preview");
else console.log("buttons create the four persistent entities last previewed");

// Moving any face of a persistent set previews every other face before the
// mouse comes up. Large, simple zones are the easiest place for this to regress:
// Konva is also moving the grabbed node directly while React redraws the set.
const northWest = circles.find((e) => e.x < 0 && e.y < 0);
const circleFrom = at(northWest.x, northWest.y);
const circleTo = at(-250, -200);
await page.mouse.move(circleFrom.x, circleFrom.y);
await page.mouse.down();
await page.mouse.move(circleTo.x, circleTo.y, { steps: 12 });
await page.waitForTimeout(200);
const circleLive = await page.evaluate(
  (ids) =>
    ids.map((circleId) => {
      const node = window.Konva.stages[0].findOne("#" + circleId);
      return node ? { id: circleId, x: Math.round(node.x()), y: Math.round(node.y()) } : null;
    }),
  circles.map((e) => e.id)
);
const liveExpected = [
  [-250, -200],
  [200, -250],
  [250, 200],
  [-200, 250],
];
if (
  liveExpected.some(
    ([x, y]) => !circleLive.some((e) => e && Math.hypot(e.x - x, e.y - y) < 8)
  )
)
  fail(`symmetric circles waited for drop instead of previewing: ${JSON.stringify(circleLive)}`);
else console.log("mid-drag: all four persistent circles preview their symmetric positions");
const beforeCircleDrop = await read();
if (beforeCircleDrop.rev !== plan.rev) fail("circle drag committed before mouseup");
await page.mouse.up();
await page.waitForTimeout(700);

plan = await read();
const movedCircles = plan.entities.filter((e) => e.type === "zone" && e.shape === "circle");
if (
  liveExpected.some(
    ([x, y]) => !movedCircles.some((e) => Math.hypot(e.x - x, e.y - y) < 8)
  )
)
  fail("symmetric circle preview and committed positions disagreed");
else console.log("symmetric circle preview is exactly what commits");

if (process.env.SYMMETRY_SCREENSHOT)
  await page.screenshot({ path: process.env.SYMMETRY_SCREENSHOT, fullPage: false });

await browser.close();
if (!process.exitCode) console.log("OK - symmetry buttons, keys, copies, and loose player matching");
