/**
 * Right-click a Part on the canvas: the point-anchored menu comes up with the
 * rows that Part owns, and Delete removes it. The same press must not start a
 * drag — a right-press that carried the shape would move things behind the
 * menu you opened to talk about them.
 */
import { chromium } from "playwright";
import { viewScale } from "./view.mjs";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1900, height: 1000 } })).newPage();
const fail = (message) => {
  console.error("FAIL:", message);
  process.exitCode = 1;
};

await page.goto(`${base}/auth/dev?name=context-menu-e2e`);
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
  body: JSON.stringify({ name: "context menu e2e", withParty: false }),
});
const id = (created.plan ?? created).id;
await api(`/api/plans/${id}/ops`, {
  method: "POST",
  body: JSON.stringify({
    ops: [
      { op: "add_entity", spec: { type: "player", name: "H1", job: "WHM", x: -300, y: 300 } },
      { op: "add_entity", spec: { type: "zone", shape: "circle", name: "puddle", radius: 120, x: 0, y: -200 } },
    ],
  }),
});

await page.goto(`${base}/p/${id}`);
await page.waitForSelector("canvas");
await page.waitForTimeout(700);

const canvas = page.locator("canvas").first();
let box = await canvas.boundingBox();
const scale = viewScale(box.width);
const at = (x, y) => ({ x: box.x + box.width / 2 + x * scale, y: box.y + box.height / 2 + y * scale });

const before = (await api(`/api/plans/${id}`)).plan;
const puddle = before.entities.find((e) => e.name === "puddle");
if (!puddle) throw new Error("the seeded Part is missing");

/* --- a right-press never carries the shape -------------------------------- */
const from = at(puddle.x, puddle.y);
await page.mouse.move(from.x, from.y);
await page.mouse.down({ button: "right" });
await page.mouse.move(from.x + 120, from.y + 90, { steps: 10 });
await page.mouse.up({ button: "right" });
await page.waitForTimeout(400);
const held = (await api(`/api/plans/${id}`)).plan.entities.find((e) => e.id === puddle.id);
if (!held) fail("the Part vanished on a right-press");
else if (held.x !== puddle.x || held.y !== puddle.y)
  fail(`a right-press dragged the Part to ${held.x},${held.y}`);
else console.log("a right-press leaves the Part exactly where it stood");
await page.keyboard.press("Escape");
await page.waitForTimeout(150);

/* --- the menu the Part owns ----------------------------------------------- */
await page.mouse.click(from.x, from.y, { button: "right" });
const menu = page.locator("[data-context-menu]").first();
await menu.waitFor({ state: "visible", timeout: 3000 });
const rows = await menu.locator("[data-menu-item]").evaluateAll((nodes) =>
  nodes.map((node) => node.getAttribute("data-menu-item"))
);
for (const expected of ["Move to Beat…", "Duplicate", "Send to back", "Bring to front", "Delete"])
  if (!rows.includes(expected)) fail(`the Part menu has no "${expected}" row: ${rows.join(", ")}`);
if (!process.exitCode) console.log(`right-click on a Part opens its menu: ${rows.join(", ")}`);

/* --- Delete does what it says --------------------------------------------- */
await page.locator('[data-menu-item="Delete"]').click();
await page.waitForTimeout(600);
if (await page.locator("[data-context-menu]").count())
  fail("the menu stayed up after a row was chosen");
const after = (await api(`/api/plans/${id}`)).plan;
if (after.entities.some((e) => e.id === puddle.id)) fail("Delete left the Part in the plan");
else if (!process.exitCode) console.log("Delete removes the Part and closes the menu");

await browser.close();
if (!process.exitCode) console.log("OK - the canvas context menu");
