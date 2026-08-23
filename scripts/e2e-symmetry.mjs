/**
 * Symmetry controls create persistent copies, and moving an older player finds
 * its same-role counterpart even though neither player has symmetry metadata.
 *
 *   npm run dev
 *   node scripts/e2e-symmetry.mjs http://localhost:5173
 */
import { chromium } from "playwright";

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
const box = await canvas.boundingBox();
const scale = box.width / 1000;
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
const to = at(-160, -90);
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
if (!live.other || Math.hypot(live.other.x - 160, live.other.y - 90) > 12)
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
if (Math.hypot(mt.x + 160, mt.y + 90) > 8) fail(`MT moved to ${mt.x},${mt.y}`);
if (Math.hypot(ot.x - 160, ot.y - 90) > 8)
  fail(`same-role rotational counterpart moved to ${ot.x},${ot.y}`);
else console.log("loose same-role player counterpart follows a rotational move");

// Exercise buttons as well as keys: mirror + four-way, then drop one circle.
await page.getByRole("button", { name: "Q: rotate" }).click();
await page.getByRole("button", { name: "3: 4-way" }).click();
const target = { x: box.width / 2 - 190 * scale, y: box.height / 2 - 140 * scale };
await page.getByText("Circle", { exact: true }).dragTo(canvas, { targetPosition: target });
await page.waitForTimeout(700);

plan = await read();
const circles = plan.entities.filter((e) => e.type === "zone" && e.shape === "circle");
const expected = [
  [-190, -140],
  [190, -140],
  [190, 140],
  [-190, 140],
];
if (circles.length !== 4) fail(`four-way mirror made ${circles.length} circles`);
else if (
  expected.some(([x, y]) => !circles.some((e) => Math.hypot(e.x - x, e.y - y) < 8))
)
  fail("four-way mirror did not cover all four quadrants");
else console.log("buttons create four persistent mirrored entities");

if (process.env.SYMMETRY_SCREENSHOT)
  await page.screenshot({ path: process.env.SYMMETRY_SCREENSHOT, fullPage: false });

await browser.close();
if (!process.exitCode) console.log("OK - symmetry buttons, keys, copies, and loose player matching");
