/**
 * Clicking a token must not glue it to the pointer.
 *
 * `pickAt` starts the drag by hand, and a click with no movement used to leave
 * the node latched: the token then followed the mouse everywhere, including out
 * of the arena, and the next real drag committed that position. The canvas is
 * the only place this shows — the server never sees it until it is too late.
 *
 *   node scripts/e2e-click.mjs http://localhost:59577
 */
import { chromium } from "playwright";
import { viewScale } from "./view.mjs";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
await page.goto(base + "/auth/dev?name=click-e2e");

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
  body: JSON.stringify({ name: "click e2e", withParty: true }),
});
const id = (created.plan ?? created).id;
await page.goto(base + "/p/" + id);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

const box = await page.locator("canvas").first().boundingBox();
const doc = await api("/api/plans/" + id).then((p) => p.plan ?? p);
const mt = doc.entities.find((e) => e.name === "MT");
const scale = viewScale(box.width, doc.arena.width);

await page.mouse.click(box.x + box.width / 2 + mt.x * scale, box.y + box.height / 2 + mt.y * scale);
await page.waitForTimeout(300);
// Wander off to the sidebar and click something there, the way you would on the
// way to any button — that second mouseup is what used to commit the stuck drag.
await page.mouse.move(1400, 420, { steps: 15 });
await page.locator("input.field").first().click();
await page.waitForTimeout(400);

// The inspector reads live client state, which is where the stuck drag showed.
const x = Number(await page.locator("input[type=number]").first().inputValue());
const y = Number(await page.locator("input[type=number]").nth(1).inputValue());
if (Math.abs(x - mt.x) > 2 || Math.abs(y - mt.y) > 2) {
  console.error("FAIL: MT followed the pointer to " + x + "," + y + " (should be " + Math.round(mt.x) + "," + Math.round(mt.y) + ")");
  process.exitCode = 1;
} else {
  console.log("OK - a click selects without moving: MT still at " + x + "," + y);
}
await browser.close();
