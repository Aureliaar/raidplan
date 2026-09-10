/**
 * The debuff deal, from a combat log to the tokens.
 *
 * A log imported into the fight library is offered to every plan. A plan with
 * no encounter named picks the fight in the debuff popup, and the header's
 * encounter — and the plan itself — take its name. In the popup a status
 * dragged from the fight's timeline lands in a role pool, and dropping on
 * Supports folds tanks and healers into one pool and flips the tokens to S/D.
 * A later plan that names the encounter finds the fight without being asked.
 */
import { readFileSync } from "node:fs";
import { fail, finish, session } from "./harness.mjs";

const dump = JSON.parse(readFileSync(new URL("./fixtures/athena-debuffs.json", import.meta.url), "utf8"));
const s = await session("debuff-e2e");
const { page } = s;

const { entry } = await s.api.post("/api/debuffs", dump);
if (entry.name !== dump.fight.name) fail("the import did not name the fight: " + JSON.stringify(entry));

const plan = await s.createPlan({ name: "debuff e2e", withParty: true });
await s.openPlan(plan.id);
const modal = page.locator("div.fixed.inset-0");
const heading = `${dump.fight.name} — statuses by first appearance`;

/* --- an unnamed plan picks the fight, and takes its name ------------------- */

// The header reads as text until clicked, so the name lives on the button that
// opens the field — and on the field itself once it is open.
const encounterName = async () => {
  const input = page.locator('input[placeholder="encounter"]');
  if (await input.count()) return input.inputValue();
  return page.locator("[data-encounter-name]").getAttribute("data-encounter-name");
};
if ((await encounterName()) !== "") fail("the plan started with an encounter named");
const offered = await page.locator("#encounter-fights option").evaluateAll((els) => els.map((e) => e.value));
if (!offered.includes(dump.fight.name)) fail("the encounter field does not offer the library's fight: " + JSON.stringify(offered));

await page.getByRole("button", { name: "New debuff Beat here" }).click();
await page.waitForTimeout(600);
const picker = modal.locator("select");
if (!(await picker.count())) fail("an unnamed plan got no fight picker in the debuff popup");
await picker.selectOption(entry.key);
await page.waitForTimeout(900);
if (!(await modal.getByText(heading).count())) fail("the popup did not switch to the chosen fight");
if ((await encounterName()) !== dump.fight.name) fail("the header did not take the fight's name: " + (await encounterName()));
if ((await plan.load()).encounter !== dump.fight.name) fail("the plan did not record the encounter");
console.log(`picking ${dump.fight.name} in the popup named the plan's encounter after it`);

/* --- a status dragged onto a role lands in its pool ------------------------ */

await modal.locator("div[draggable=true]", { hasText: "Umbralbright Soul" }).first().dragTo(modal.getByText("Tanks", { exact: true }));
await page.waitForTimeout(600);
let deal = (await plan.load()).mechs.find((m) => m.debuffs)?.debuffs;
if (!deal) fail("no Beat holds a debuff deal after the drop");
if ((deal.pools.tanks ?? []).map((d) => d.name).join() !== "Umbralbright Soul")
  fail("Umbralbright Soul did not land in the tank pool: " + JSON.stringify(deal.pools));

// Dropping on Supports folds the tank pool in and flips the tokens to S/D.
await modal
  .locator("div[draggable=true]", { hasText: "Magic Vulnerability Up" })
  .first()
  .dragTo(modal.getByText("Supports", { exact: true }));
await page.waitForTimeout(600);
deal = (await plan.load()).mechs.find((m) => m.debuffs)?.debuffs;
if ((deal.pools.supports ?? []).length !== 2) fail("Supports did not absorb the tank pool plus the drop: " + JSON.stringify(deal.pools));
if ((deal.pools.tanks ?? []).length) fail("the fold left the tank pool standing");
if (deal.mode !== "sd") fail("the fold did not flip the tokens to S/D: " + deal.mode);
if (!(await modal.getByText(/Supports take/).count())) fail("the popup's sentence does not name the supports");
console.log("a status dropped on Tanks went to the tanks; one on Supports folded both pools and flipped to S/D");

/* --- a later plan that names the encounter finds the fight by itself ------- */

const later = await s.createPlan({ name: "debuff e2e 2", encounter: "P12S — Athena", withParty: true });
await s.openPlan(later.id);
await page.getByRole("button", { name: "New debuff Beat here" }).click();
await page.waitForTimeout(600);
if (!(await modal.getByText(heading).count())) fail("a plan for P12S — Athena did not pick the fight up from its encounter");
console.log("a plan for P12S — Athena opens the popup on the imported fight without being asked");

await finish(s, "OK - " + plan.url);
