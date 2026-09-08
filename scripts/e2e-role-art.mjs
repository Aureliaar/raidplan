/**
 * A player whose job is a role, not a job, still gets role art: pick "melee"
 * or "ranged" in the inspector and the token stops being the generic dps blade.
 *
 *   node scripts/e2e-role-art.mjs http://localhost:59577
 */
import { chromium } from "playwright";
import { viewScale } from "./view.mjs";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

/** Every actor texture the page pulls, in order. */
const fetched = [];
page.on("request", (r) => {
  const m = /\/assets\/(actor\/[^?]+)\.png/.exec(r.url());
  if (m) fetched.push(m[1]);
});

await page.goto(base + "/auth/dev?name=role-art-e2e");
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
  body: JSON.stringify({ name: "role art e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const plan = await api("/api/plans/" + planId).then((p) => p.plan ?? p);
const players = (plan.entities ?? []).filter((e) => e.type === "player");

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

const canvas = page.locator("canvas").first();
async function clickPlayer(name) {
  const p = players.find((e) => e.name === name);
  if (!p) throw new Error("no player " + name);
  const box = await canvas.boundingBox();
  const scale = viewScale(box.width);
  await page.mouse.click(box.x + box.width / 2 + p.x * scale, box.y + box.height / 2 + p.y * scale);
  await page.waitForTimeout(250);
}

/** Set the selected player's job through the inspector dropdown. */
async function setJob(role) {
  const select = page.locator("select").filter({ has: page.locator('option[value="melee"]') }).first();
  await select.selectOption(role);
  await page.waitForTimeout(600);
}

for (const [name, role, want] of [
  ["M1", "melee", "actor/melee1"],
  ["R1", "ranged", "actor/ranged1"],
]) {
  fetched.length = 0;
  await clickPlayer(name);
  await setJob(role);
  if (!fetched.includes(want)) fail(`${name} as ${role} loaded ${fetched.join(", ") || "nothing"}, wanted ${want}`);
  if (fetched.some((k) => /^actor\/dps/.test(k))) fail(`${name} as ${role} still loaded generic dps art`);
  console.log(`${name} -> ${role}: ${fetched.join(", ")}`);
}

await page.screenshot({ path: "scripts/e2e-role-art.png" });
await browser.close();
if (!process.exitCode) console.log("OK: role players use role art");
