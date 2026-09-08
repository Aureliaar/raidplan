/**
 * The plan's encounter and the debuff Beat's fight are one choice: a plan with
 * no encounter named picks a fight in the debuff popup, and the header's
 * encounter field — and the plan itself — take the fight's name, so every later
 * debuff Beat finds the statuses without being asked again.
 *
 *   node scripts/e2e-encounter-fight.mjs http://localhost:59577
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const dump = JSON.parse(readFileSync(new URL("./fixtures/athena-debuffs.json", import.meta.url), "utf8"));

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=encounter-fight-e2e");
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

const entry = (await api("/api/debuffs", { method: "POST", body: JSON.stringify(dump) })).entry;

const created = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "encounter fight e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

// The header reads as text until you click it, so the name lives on the
// button that opens the field — and on the field itself once it is open.
const encounterName = async () => {
  const field = page.locator('input[placeholder="encounter"]');
  if (await field.count()) return field.inputValue();
  return page.locator("[data-encounter-name]").getAttribute("data-encounter-name");
};
if ((await encounterName()) !== "") fail("the plan started with an encounter named");

/* --- the header offers the library's fights ------------------------------ */

const options = await page.locator("#encounter-fights option").evaluateAll((els) => els.map((e) => e.value));
if (!options.includes(dump.fight.name))
  fail("the encounter field does not offer the library's fight: " + JSON.stringify(options));

/* --- picking the fight in the debuff popup names the encounter ------------ */

await page.getByRole("button", { name: "New debuff Beat here" }).click();
await page.waitForTimeout(600);
const modal = page.locator("div.fixed.inset-0");
const picker = modal.locator("select");
if (!(await picker.count())) fail("an unnamed plan got no fight picker in the debuff popup");
else await picker.selectOption(entry.key);
await page.waitForTimeout(900);

if (!(await modal.getByText(dump.fight.name + " — statuses by first appearance").count()))
  fail("the popup did not switch to the chosen fight");

if ((await encounterName()) !== dump.fight.name)
  fail("the header encounter field did not take the fight's name: " + (await encounterName()));

const doc = await load();
if (doc.encounter !== dump.fight.name) fail("the plan did not record the encounter: " + JSON.stringify(doc.encounter));

/* --- and a fresh plan for that encounter now finds the fight by name ------ */

const second = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "encounter fight e2e 2", encounter: dump.fight.name, withParty: true }),
});
const secondId = (second.plan ?? second).id;
const found = await api("/api/plans/" + secondId + "/debuffs");
if (!found.dump) fail("a second plan naming the same encounter did not resolve to the fight");

console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
await browser.close();
