/**
 * Deleting a Variant box from the timeline, the way a user does it: click the
 * box to make it the edit destination, then Delete (or the button). A Step's
 * boxes come as a pair, so the survivor becomes Shared.
 *
 *   node scripts/e2e-variant-delete.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
let failed = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label.padEnd(52)} ${detail}`);
};

await page.goto(base + "/auth/dev?name=variant-delete-e2e");
const api = async (path, init = {}) =>
  page.evaluate(
    async ([url, options]) => {
      const response = await fetch(url, {
        ...options,
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${url} -> ${response.status} ${text.slice(0, 500)}`);
      return text ? JSON.parse(text) : null;
    },
    [path, init],
  );

const created = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "Variant delete e2e", withParty: true, variantModel: "step" }),
});
const planId = (created.plan ?? created).id;
const load = () => api(`/api/plans/${planId}`).then((body) => body.plan ?? body);
const ops = (input) =>
  api(`/api/plans/${planId}/ops`, { method: "POST", body: JSON.stringify({ ops: [].concat(input) }) });

let plan = await load();
const mechanic = plan.mechanics[0].id;
const step1 = plan.steps[0].id;
await ops([
  { op: "add_step", name: "Resolve", mechanic },
  { op: "add_step", name: "Aftermath", mechanic },
]);
plan = await load();
const step3 = plan.steps[2].id;

async function makeBeat(name, partId) {
  const made = await ops({ op: "add_mech", name, snap: step1, boom: step3 });
  const id = made.values[0].id;
  await ops({
    op: "add_entity",
    spec: { id: partId, type: "zone", name, shape: "circle", mech: id, x: 0, y: 0 },
  });
  return id;
}

const lightBeat = await makeBeat("Light", "light_part");
const darkBeat = await makeBeat("Dark", "dark_part");
const nearBeat = await makeBeat("Near", "near_part");
const farBeat = await makeBeat("Far", "far_part");

await ops([{ op: "add_step_variant", stepId: step1 }, { op: "add_step_variant", stepId: step3 }]);
plan = await load();
const [light, dark] = plan.steps.find((step) => step.id === step1).variants;
const [near, far] = plan.steps.find((step) => step.id === step3).variants;
await ops([
  { op: "assign_beats_to_step_variant", stepId: step1, variantId: light.id, beatIds: [lightBeat] },
  { op: "assign_beats_to_step_variant", stepId: step1, variantId: dark.id, beatIds: [darkBeat] },
  { op: "assign_beats_to_step_variant", stepId: step3, variantId: near.id, beatIds: [nearBeat] },
  { op: "assign_beats_to_step_variant", stepId: step3, variantId: far.id, beatIds: [farBeat] },
]);

await page.goto(`${base}/p/${planId}`);
await page.waitForSelector("canvas");
await page.waitForSelector("[data-step-variant]");
const destination = page.locator("[data-edit-destination]");
// The box's caption strip is its handle: clicking a Beat chip inside the box
// opens that Beat instead, which is a different destination.
const box = (id) => page.locator(`[data-step-variant="${id}"] [aria-pressed]`);

// Clicking a box is the selection: it says so, and it offers the way out.
await box(dark.id).click();
check(
  (await destination.textContent()).includes(await box(dark.id).getAttribute("aria-label")),
  "clicking a box makes it the edit destination",
  await destination.textContent(),
);
check(await page.locator("[data-delete-step-variant]").count() === 1, "a selected box offers Delete Variant");

await page.keyboard.press("Escape");
check(
  (await destination.textContent()).includes("shared"),
  "Escape steps back out to Shared",
  await destination.textContent(),
);
check(await page.locator("[data-delete-step-variant]").count() === 0, "no box selected, nothing to delete");

// Cancelling the confirm leaves the split exactly as it was.
let answer = "dismiss";
page.on("dialog", (dialog) => (answer === "accept" ? dialog.accept() : dialog.dismiss()));
await box(dark.id).click();
await page.keyboard.press("Delete");
await page.waitForTimeout(300);
plan = await load();
check(
  plan.steps.find((step) => step.id === step1).variants.length === 2,
  "cancelling the confirm keeps both boxes",
);
check(plan.mechs.some((beat) => beat.id === darkBeat), "cancelling the confirm keeps the box's Beats");

// Delete on the selected box ends the split; the sibling becomes Shared.
answer = "accept";
await page.keyboard.press("Delete");
await page.waitForFunction(
  (id) => !document.querySelector(`[data-step-variant="${id}"]`),
  dark.id,
);
plan = await load();
const collapsed = plan.steps.find((step) => step.id === step1);
check(!collapsed.variants.length, "Delete on a selected box ends the split");
check(!plan.mechs.some((beat) => beat.id === darkBeat), "the deleted box takes its Beats with it");
check(plan.mechs.some((beat) => beat.id === lightBeat), "the surviving box's Beats become Shared");
check(
  (await destination.textContent()).includes("shared"),
  "the edit destination falls back to Shared",
  await destination.textContent(),
);

// The button is the same act, for the split that is still standing.
await box(near.id).click();
await page.locator("[data-delete-step-variant]").click();
await page.waitForFunction((id) => !document.querySelector(`[data-step-variant="${id}"]`), near.id);
plan = await load();
check(
  !plan.steps.find((step) => step.id === step3).variants.length,
  "the Delete Variant button ends the other split",
);
check(!plan.mechs.some((beat) => beat.id === nearBeat), "button delete takes the selected box's Beats");
check(plan.mechs.some((beat) => beat.id === farBeat), "button delete keeps the sibling's Beats");
check(await page.locator("[data-step-variant]").count() === 0, "the timeline has no boxes left");

await browser.close();
console.log(failed ? `${failed} Variant delete check(s) failed` : "Variant delete checks pass");
process.exit(failed ? 1 : 0);
