/**
 * Keyboard: delete removes what is selected, copy/paste drops a twin under the
 * cursor. Both must keep their hands off text fields — Backspace in the plan
 * name is a letter, not the boss.
 *
 *   node scripts/e2e-keys.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=keys-e2e");
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

const created = await api("/api/plans", { method: "POST", body: JSON.stringify({ name: "keys e2e" }) });
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);
await api("/api/plans/" + planId + "/ops", {
  method: "POST",
  body: JSON.stringify({
    ops: [
      { op: "add_entity", spec: { type: "zone", shape: "circle", radius: 120, name: "puddle", x: -250, y: 0 } },
      { op: "add_entity", spec: { type: "marker", marker: "A", x: 250, y: 0 } },
    ],
  }),
});

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

const box = await page.locator("canvas").first().boundingBox();
const scale = box.width / 1000;
const screen = (x, y) => ({ x: box.x + box.width / 2 + x * scale, y: box.y + box.height / 2 + y * scale });

/* --- copy and paste under the cursor -------------------------------------- */

const src = screen(-250, 0);
await page.mouse.click(src.x, src.y);
await page.waitForTimeout(300);
await page.keyboard.press("Control+c");
const to = screen(300, 300);
await page.mouse.move(to.x, to.y);
await page.keyboard.press("Control+v");
await page.waitForTimeout(700);

let doc = await load();
const twins = doc.entities.filter((e) => e.name === "puddle");
if (twins.length !== 2) fail("ctrl+v made " + (twins.length - 1) + " copies");
else {
  const pasted = twins[1];
  if (Math.hypot(pasted.x - 300, pasted.y - 300) > 30)
    fail("the paste landed at " + pasted.x + "," + pasted.y + ", not under the cursor");
  else console.log("ctrl+c, ctrl+v: a twin at the pointer, " + pasted.x + "," + pasted.y);
}

/* --- delete removes the selection ----------------------------------------- */

const before = (await load()).entities.length;
await page.mouse.click(to.x, to.y);
await page.waitForTimeout(300);
await page.keyboard.press("Delete");
await page.waitForTimeout(600);
doc = await load();
if (doc.entities.length !== before - 1) fail("Delete removed " + (before - doc.entities.length) + " entities");
else if (doc.entities.some((e) => Math.hypot(e.x - 300, e.y - 300) < 30))
  fail("Delete removed the wrong one");
else console.log("Delete removes what is selected, and only that");

/* --- and it keeps out of the text fields ---------------------------------- */

const name = page.locator("input").first();
await name.click();
await name.press("Backspace");
await page.waitForTimeout(400);
if ((await load()).entities.length !== doc.entities.length)
  fail("Backspace in the name field deleted an entity");
else console.log("Backspace in a text field is just a letter");

console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
await browser.close();
