/**
 * Step-owned Variant boxes: complete-Beat exclusivity, Shared composition,
 * sparse movement, Route safety, timeline UI and owner-Step deletion cleanup.
 *
 *   node scripts/e2e-step-variants.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
let failed = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label.padEnd(48)} ${detail}`);
};

await page.goto(base + "/auth/dev?name=step-variants-e2e");
const api = async (path, init = {}, allowError = false) =>
  page.evaluate(
    async ([url, options, permitted]) => {
      const response = await fetch(url, {
        ...options,
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      });
      const text = await response.text();
      if (!response.ok && !permitted)
        throw new Error(`${url} -> ${response.status} ${text.slice(0, 500)}`);
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    [path, init, allowError],
  );

const created = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "Step Variant model e2e", withParty: true, variantModel: "step" }),
});
const planId = (created.body.plan ?? created.body).id;
const load = () => api(`/api/plans/${planId}`).then(({ body }) => body.plan ?? body);
const ops = (input, allowError = false) =>
  api(
    `/api/plans/${planId}/ops`,
    { method: "POST", body: JSON.stringify({ ops: [].concat(input) }) },
    allowError,
  );

let plan = await load();
const mechanic = plan.mechanics[0].id;
const step1 = plan.steps[0].id;
await ops([
  { op: "add_step", name: "Resolve", mechanic },
  { op: "add_step", name: "Aftermath", mechanic },
]);
plan = await load();
const step2 = plan.steps[1].id;
const step3 = plan.steps[2].id;
const mt = plan.entities.find((entity) => entity.name === "MT");

async function makeBeat(name, partId, shape) {
  const made = await ops({ op: "add_mech", name, snap: step1, boom: step3 });
  const id = made.body.values[0].id;
  await ops({
    op: "add_entity",
    spec: { id: partId, type: "zone", name, shape, mech: id, x: 0, y: 0 },
  });
  return id;
}

const sharedBeat = await makeBeat("Shared", "shared_part", "circle");
const lightBeat = await makeBeat("Light", "light_part", "circle");
const darkBeat = await makeBeat("Dark", "dark_part", "donut");
const nearBeat = await makeBeat("Near", "near_part", "circle");
const farBeat = await makeBeat("Far", "far_part", "donut");

await ops({ op: "add_step_variant", stepId: step1 });
await ops({ op: "add_step_variant", stepId: step3 });
plan = await load();
const [light, dark] = plan.steps.find((step) => step.id === step1).variants;
const [near, far] = plan.steps.find((step) => step.id === step3).variants;
await ops([
  { op: "update_step_variant", stepId: step1, variantId: light.id, patch: { name: "Light" } },
  { op: "update_step_variant", stepId: step1, variantId: dark.id, patch: { name: "Dark" } },
  { op: "update_step_variant", stepId: step3, variantId: near.id, patch: { name: "Near" } },
  { op: "update_step_variant", stepId: step3, variantId: far.id, patch: { name: "Far" } },
  { op: "assign_beats_to_step_variant", stepId: step1, beatIds: [lightBeat], variantId: light.id },
  { op: "assign_beats_to_step_variant", stepId: step1, beatIds: [darkBeat], variantId: dark.id },
  { op: "assign_beats_to_step_variant", stepId: step3, beatIds: [nearBeat], variantId: near.id },
  { op: "assign_beats_to_step_variant", stepId: step3, beatIds: [farBeat], variantId: far.id },
]);

const inspect = (selections) =>
  page.evaluate(
    async ([id, stepId, shown]) => {
      const response = await fetch(`/api/plans/${id}`);
      const body = await response.json();
      const plan = body.plan ?? body;
      const module = await import("/src/shared/step-variants.ts");
      const result = module.composeStepVariantEntities(plan, stepId, shown);
      return {
        ids: result.entities.map((entity) => entity.id),
        mt: result.entities.find((entity) => entity.name === "MT"),
        conflicts: result.conflicts,
      };
    },
    [planId, step1, selections],
  );

let scene = await inspect({ [step1]: light.id, [step3]: near.id });
check(scene.ids.includes("shared_part"), "Shared Beat always contributes");
check(scene.ids.includes("light_part") && !scene.ids.includes("dark_part"), "first split selects exactly one box");
check(scene.ids.includes("near_part") && !scene.ids.includes("far_part"), "simultaneous split composes independently");

await ops({
  op: "set_step_variant_movement",
  stepId: step1,
  variantId: light.id,
  actorId: mt.id,
  pose: { x: 111, y: 112, rotation: mt.rotation },
});
const route = await ops({
  op: "add_beat_variant_route",
  name: "Safe",
  selections: { [step1]: light.id, [step3]: far.id },
});
const routeId = route.body.values[0].id;
await ops({ op: "set_default_beat_variant_route", routeId });
check((await load()).defaultVariantRoute === routeId, "Step-box Route can become default");

const unsafe = await ops(
  {
    op: "set_step_variant_movement",
    stepId: step1,
    variantId: far.id,
    actorId: mt.id,
    pose: { x: 222, y: 223, rotation: mt.rotation },
  },
  true,
);
check(unsafe.status === 400, "saved Route cannot become movement-unsafe", `HTTP ${unsafe.status}`);

await ops({
  op: "set_step_variant_movement",
  stepId: step1,
  variantId: near.id,
  actorId: mt.id,
  pose: { x: 333, y: 334, rotation: mt.rotation },
});
scene = await inspect({ [step1]: light.id, [step3]: near.id });
check(scene.conflicts.some((conflict) => conflict.actorId === mt.id), "same-actor movement conflict is explicit");
check(scene.mt.x === mt.x && scene.mt.y === mt.y, "movement conflict keeps Shared pose");

await page.goto(`${base}/p/${planId}`);
await page.waitForSelector("canvas");
await page.waitForSelector("[data-step-variant-set]");
check(await page.locator("[data-step-variant-set]").count() === 2, "timeline renders both outer Variant containers");
check(await page.locator("[data-step-variant]").count() === 4, "timeline renders sibling Variant boxes");

await ops({ op: "delete_step", stepId: step3 });
plan = await load();
check(!plan.mechs.some((beat) => beat.id === nearBeat || beat.id === farBeat), "deleting owner Step removes box-owned Beats");
check(plan.variantRoutes.every((candidate) => !(step3 in candidate.selections)), "deleting owner Step scrubs Route selection");
check(
  plan.steps.every((step) => !step.stepVariantMovement?.[near.id] && !step.stepVariantMovement?.[far.id]),
  "deleting owner Step scrubs Variant movement",
);
check(plan.mechs.some((beat) => beat.id === sharedBeat), "deleting split preserves Shared Beats");

await browser.close();
console.log(failed ? `${failed} Step Variant check(s) failed` : "Step Variant model checks pass");
process.exit(failed ? 1 : 0);
