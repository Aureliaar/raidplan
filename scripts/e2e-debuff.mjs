/**
 * The debuff deal: "New debuff mech here" opens the popup, a status dragged
 * from the fight's timeline lands in a role pool, and dropping on Supports
 * folds tanks and healers into one pool and flips the tokens to S/D art.
 *
 *   node scripts/e2e-debuff.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=debuff-e2e");
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
  body: JSON.stringify({ name: "debuff e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

/* --- the popup opens on a fresh debuff mech ------------------------------- */

await page.getByRole("button", { name: "New debuff mech here" }).click();
await page.waitForTimeout(600);
const modal = page.locator("div.fixed.inset-0");
if (!(await modal.count())) fail("the debuff popup did not open");
if (!(await modal.getByText("statuses by first appearance").count()))
  fail("the popup shows no first-appearance timeline");

/* --- a status dragged onto Tanks lands in their pool ---------------------- */

const chip = modal.locator("div[draggable=true]", { hasText: "Bleeding" }).first();
const tanks = modal.getByText("Tanks", { exact: true });
await chip.dragTo(tanks);
await page.waitForTimeout(600);

let doc = await load();
let mech = doc.mechs.find((m) => m.debuffs);
if (!mech) fail("no mech holds a debuff deal after the drop");
else if ((mech.debuffs.pools.tanks ?? []).length !== 1 || mech.debuffs.pools.tanks[0].name !== "Bleeding")
  fail("Bleeding did not land in the tank pool: " + JSON.stringify(mech.debuffs.pools));
else console.log("Bleeding dealt to the tanks, mode " + mech.debuffs.mode);

/* --- dropping on Supports folds the pools and flips to S/D art ------------ */

const chip2 = modal.locator("div[draggable=true]", { hasText: "Magic Vulnerability Up" }).first();
await chip2.dragTo(modal.getByText("Supports", { exact: true }));
await page.waitForTimeout(600);

doc = await load();
mech = doc.mechs.find((m) => m.debuffs);
const pools = mech?.debuffs?.pools ?? {};
if ((pools.supports ?? []).length !== 2)
  fail("Supports did not absorb the tank pool plus the drop: " + JSON.stringify(pools));
if ((pools.tanks ?? []).length !== 0) fail("the tank pool was not emptied by the fold");
if (mech?.debuffs?.mode !== "sd") fail("the fold did not flip token art to S/D: " + mech?.debuffs?.mode);
if (!process.exitCode) console.log("Supports fold: " + pools.supports.map((d) => d.name).join(", ") + " in sd mode");

/* --- the deal reads back off the popup's sentence ------------------------- */

if (!(await modal.getByText(/Supports take/).count())) fail("the reads-out-as sentence does not name the supports");

console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
await browser.close();
