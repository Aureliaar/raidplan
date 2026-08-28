/**
 * Additive Beat Variant model: Beat-local content COW, sparse movement,
 * conflict-safe composition, Routes and lifecycle separation.
 *
 *   node scripts/e2e-beat-variants.mjs http://localhost:5173
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:5173").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
let failed = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label.padEnd(42)} ${detail}`);
};
const same = (actual, expected, label) =>
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    JSON.stringify(actual) === JSON.stringify(expected)
      ? ""
      : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );

await page.goto(base + "/auth/dev?name=beat-variants-e2e");
const api = async (path, init = {}, allowError = false) =>
  page.evaluate(
    async ([url, options, permitted]) => {
      const response = await fetch(url, {
        ...options,
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      });
      const text = await response.text();
      if (!response.ok && !permitted)
        throw new Error(url + " -> " + response.status + " " + text.slice(0, 500));
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    [path, init, allowError]
  );

const created = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "Beat Variant model e2e", withParty: true }),
});
const planId = (created.body.plan ?? created.body).id;
const load = () =>
  api("/api/plans/" + planId).then(({ body }) => body.plan ?? body);
const ops = (input, allowError = false) =>
  api(
    "/api/plans/" + planId + "/ops",
    { method: "POST", body: JSON.stringify({ ops: [].concat(input) }) },
    allowError
  );

let plan = await load();
const section = plan.mechanics[0].id;
const step1 = plan.steps[0].id;
const mt = plan.entities.find((entity) => entity.name === "MT").id;
const ot = plan.entities.find((entity) => entity.name === "OT").id;
await ops([
  { op: "add_step", name: "Resolve", mechanic: section },
]);
plan = await load();
const step2 = plan.steps.find((step) => step.id !== step1).id;

const beatOneResult = await ops({
  op: "add_mech",
  name: "Explosion",
  snap: step1,
  boom: step2,
  color: "#ff7043",
});
const beatOne = beatOneResult.body.values[0].id;
const beatTwoResult = await ops({
  op: "add_mech",
  name: "Orbs",
  snap: step1,
  boom: step2,
  color: "#26c6da",
});
const beatTwo = beatTwoResult.body.values[0].id;
await ops([
  {
    op: "add_entity",
    spec: { id: "explosion_shared", type: "zone", shape: "circle", mech: beatOne, x: 10, y: 20 },
  },
  {
    op: "add_entity",
    spec: {
      id: "orbs_anchor",
      type: "zone",
      shape: "circle",
      mech: beatTwo,
      anchor: { to: mt },
      x: 0,
      y: 0,
    },
  },
  { op: "add_beat_variant", beatId: beatOne },
  { op: "add_beat_variant", beatId: beatTwo },
]);
plan = await load();
const [oneA, oneB] = plan.mechs.find((beat) => beat.id === beatOne).variants.map((v) => v.id);
const [twoA, twoB] = plan.mechs.find((beat) => beat.id === beatTwo).variants.map((v) => v.id);

const inspect = (shown = { [beatOne]: oneA, [beatTwo]: twoA }, sid = step1) =>
  page.evaluate(
    async ([id, stepId, selections]) => {
      const response = await fetch("/api/plans/" + id);
      const plan = await response.json().then((result) => result.plan ?? result);
      const schema = await import("/src/shared/schema.ts");
      const composition = schema.composeBeatVariantEntities(plan, stepId, selections);
      const rendered = schema.entitiesForStep(plan, stepId, undefined, selections);
      const state = plan.steps.find((step) => step.id === stepId);
      const pick = (entityId) => rendered.find((entity) => entity.id === entityId);
      return {
        plan,
        ids: rendered.map((entity) => entity.id),
        mt: pick(plan.entities.find((entity) => entity.name === "MT").id),
        ot: pick(plan.entities.find((entity) => entity.name === "OT").id),
        anchor: pick("orbs_anchor"),
        explosion: pick("explosion_shared"),
        conflicts: composition.conflicts,
        content: state.beatVariantContent ?? {},
        movement: state.beatVariantMovement ?? {},
      };
    },
    [planId, sid, shown]
  );

let state = await inspect();
check(state.plan.variantModel === "beat", "explicit v2 model enabled");
check(!Object.keys(state.content).length, "new Variants follow shared content");
check(!Object.keys(state.movement).length, "new Variants use shared Step poses");
const mechanicVariantAttempt = await ops(
  { op: "add_variant", mechanicId: section },
  true
);
check(mechanicVariantAttempt.status === 400, "Beat plans reject Mechanic-level Variants", `HTTP ${mechanicVariantAttempt.status}`);

// A Part edit snapshots only its owning Beat and never movement or another Beat.
await ops({
  op: "update_entity",
  id: "explosion_shared",
  patch: { x: 111 },
  stepId: step1,
  variant: oneA,
});
state = await inspect();
same(state.content[oneA].parts.map((part) => part.id), ["explosion_shared"], "content COW contains only owning Beat Parts");
check(!state.movement[oneA], "Part edit did not detach movement");
await ops({ op: "update_entity", id: "explosion_shared", patch: { x: 222 }, stepId: step1 });
same((await inspect()).explosion.x, 111, "detached content ignores later shared edit");
same((await inspect({ [beatOne]: oneB, [beatTwo]: twoA })).explosion.x, 222, "untouched sibling keeps following shared content");

// One actor move is one sparse absolute override; other actors remain live.
const sharedBefore = await inspect();
await ops({
  op: "update_entity",
  id: mt,
  patch: { x: 333, y: 334 },
  stepId: step1,
  variant: oneA,
});
state = await inspect();
same(Object.keys(state.movement[oneA]), [mt], "moving MT detached only MT");
check(state.content[oneA].parts.length === 1, "movement did not alter content snapshot");
same({ x: state.ot.x, y: state.ot.y }, { x: sharedBefore.ot.x, y: sharedBefore.ot.y }, "OT still uses shared Step pose");
same({ x: state.anchor.x, y: state.anchor.y }, { x: 333, y: 334 }, "anchors resolve after effective movement");

// Different-player movement composes, same-player movement conflicts safely.
await ops({
  op: "update_entity",
  id: ot,
  patch: { x: -444, y: -445 },
  stepId: step1,
  variant: twoA,
});
state = await inspect();
same({ x: state.mt.x, y: state.mt.y }, { x: 333, y: 334 }, "independent Beat movement composed for MT");
same({ x: state.ot.x, y: state.ot.y }, { x: -444, y: -445 }, "independent Beat movement composed for OT");
await ops({
  op: "update_entity",
  id: mt,
  patch: { x: 777, y: 778 },
  stepId: step1,
  variant: twoA,
});
state = await inspect();
check(state.conflicts.some((conflict) => conflict.actorId === mt), "same-actor conflict is explicit");
same({ x: state.mt.x, y: state.mt.y }, { x: sharedBefore.mt.x, y: sharedBefore.mt.y }, "conflict preview uses shared Step pose");

// Conflicting selections cannot be saved/defaulted as a Route.
const conflictRoute = await ops(
  {
    op: "add_beat_variant_route",
    name: "unsafe",
    selections: { [beatOne]: oneA, [beatTwo]: twoA },
  },
  true
);
check(conflictRoute.status === 400, "unsafe movement map cannot be saved as Route", `HTTP ${conflictRoute.status}`);
const safeRoute = await ops({
  op: "add_beat_variant_route",
  name: "Safe route",
  selections: { [beatOne]: oneA, [beatTwo]: twoB },
});
const routeId = safeRoute.body.values[0].id;
await ops({ op: "set_default_beat_variant_route", routeId });
plan = await load();
check(plan.defaultVariantRoute === routeId, "safe Route can become document default");
const routeBreakingMove = await ops(
  {
    op: "update_entity",
    id: mt,
    patch: { x: 888, y: 889 },
    stepId: step1,
    variant: twoB,
  },
  true
);
check(routeBreakingMove.status === 400, "edits cannot make saved Route silently unsafe", `HTTP ${routeBreakingMove.status}`);

// Independent reset actions never erase the other domain.
await ops({ op: "resume_beat_variant_content", stepId: step1, variantId: oneA });
state = await inspect();
check(!state.content[oneA], "Resume shared content deletes only content snapshot");
check(!!state.movement[oneA]?.[mt], "Resume shared content preserves movement");
await ops({ op: "clear_beat_variant_movement", stepId: step1, variantId: oneA });
state = await inspect();
check(!state.movement[oneA], "Clear Variant movement deletes movement domain");

// Duplicate across all Steps, with fresh private ids and rewritten references.
await ops([
  {
    op: "add_entity",
    spec: { id: "private_a", type: "zone", shape: "circle", mech: beatOne, x: 1, y: 2 },
    stepId: step2,
    variant: oneA,
  },
  {
    op: "add_entity",
    spec: { id: "private_b", type: "zone", shape: "circle", mech: beatOne, x: 3, y: 4 },
    stepId: step2,
    variant: oneA,
  },
  {
    op: "add_entity",
    spec: { id: "private_tether", type: "tether", from: "private_a", to: "private_b", mech: beatOne },
    stepId: step2,
    variant: oneA,
  },
  {
    op: "update_entity",
    id: ot,
    patch: { x: 909, y: 910 },
    stepId: step2,
    variant: oneA,
  },
]);
const duplicate = await ops({ op: "duplicate_beat_variant", beatId: beatOne, variantId: oneA });
const copied = duplicate.body.values[0].id;
plan = await load();
const sourceStep = plan.steps.find((candidate) => candidate.id === step2);
const sourceParts = sourceStep.beatVariantContent[oneA].parts;
const copiedParts = sourceStep.beatVariantContent[copied].parts;
check(sourceParts.every((part) => !copiedParts.some((copy) => copy.id === part.id)), "Duplicate gives private Parts fresh ids");
const copiedTether = copiedParts.find((part) => part.type === "tether");
check(copiedParts.some((part) => part.id === copiedTether.from) && copiedParts.some((part) => part.id === copiedTether.to), "Duplicate rewrites private Part references");
same(sourceStep.beatVariantMovement[copied], sourceStep.beatVariantMovement[oneA], "Duplicate copies sparse movement across Steps");

// Deliberate exit: promote one complete branch to Shared and remove its boxes.
await page.request.post(`${base}/api/plans/${planId}/share`, {
  data: { userId: "local:collapse-editor", role: "editor" },
});
const editorPage = await (await browser.newContext()).newPage();
await editorPage.goto(base + "/auth/dev?name=collapse-editor");
const editorCollapse = await editorPage.request.post(`${base}/api/plans/${planId}/ops`, {
  data: { ops: [{ op: "collapse_beat_variants", beatId: beatOne, variantId: oneA }] },
});
check(editorCollapse.status() === 403, "only the plan owner can collapse Variants", `HTTP ${editorCollapse.status()}`);
await editorPage.context().close();
await ops({ op: "collapse_beat_variants", beatId: beatOne, variantId: oneA });
plan = await load();
check(plan.mechs.find((beat) => beat.id === beatOne).variants.length === 0, "Collapse removes all sibling boxes");
check(
  plan.steps.every((candidate) =>
    [oneA, oneB, copied].every(
      (variantId) =>
        !candidate.beatVariantContent?.[variantId] &&
        !candidate.beatVariantMovement?.[variantId]
    )
  ),
  "Collapse clears private Step domains"
);
check(
  plan.variantRoutes.every((route) => !route.selections[beatOne]),
  "Collapse removes the Beat from saved Routes"
);
const collapsed = await inspect({ [beatTwo]: twoB }, step2);
check(collapsed.ids.includes("private_a") && collapsed.ids.includes("private_tether"), "chosen Variant Parts become Shared");
same({ x: collapsed.ot.x, y: collapsed.ot.y }, { x: 909, y: 910 }, "chosen Variant movement becomes shared Step movement");

// Retired documents have no compatibility runtime: old branch fields flatten
// to the shared canonical plan as they enter the current model.
const retiredCreated = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "retired Mechanic Variants", withParty: false }),
});
const retiredId = retiredCreated.body.id;
const retiredSource = await api("/api/plans/" + retiredId).then(({ body }) => body.plan);
delete retiredSource.variantModel;
retiredSource.mechanics[0].variants = [
  { id: "old_a", name: "A" },
  { id: "old_b", name: "B" },
];
retiredSource.steps[0].variantScenes = { old_a: [], old_b: [] };
await api("/api/plans/" + retiredId + "/import", {
  method: "POST",
  body: JSON.stringify({ plan: retiredSource }),
});
const retired = await api("/api/plans/" + retiredId).then(({ body }) => body.plan);
check(retired.variantModel === "beat", "old documents hydrate directly into Beat model");
check(retired.mechanics.every((mechanic) => mechanic.variants.length === 0), "Mechanic Variant data is discarded");
check(retired.steps.every((candidate) => !candidate.variantScenes), "Mechanic Variant scenes are discarded");

await browser.close();
console.log(failed ? `${failed} Beat Variant check(s) failed` : "Beat Variant model checks pass");
process.exit(failed ? 1 : 0);
