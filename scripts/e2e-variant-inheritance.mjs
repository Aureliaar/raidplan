/**
 * Variant-step entity state is copy-on-write.
 *
 * An untouched reading resolves the live shared step. Its first scoped edit
 * materializes every entity in that moment; later shared edits no longer leak
 * into it, while other readings and other steps keep inheriting independently.
 *
 *   node scripts/e2e-variant-inheritance.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const fail = (message) => {
  console.error("FAIL:", message);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=variant-inheritance-e2e");
const api = (path, init = {}) =>
  page.evaluate(
    async ([url, options]) => {
      const response = await fetch(url, {
        ...options,
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(url + " -> " + response.status + " " + text.slice(0, 300));
      return text ? JSON.parse(text) : null;
    },
    [path, init]
  );

const created = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "variant inheritance e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const { token } = await api("/api/tokens", {
  method: "POST",
  body: JSON.stringify({ label: "variant-inheritance-e2e" }),
});
const load = () => api("/api/plans/" + planId).then((result) => result.plan ?? result);
const ops = (input) =>
  api("/api/plans/" + planId + "/ops", {
    method: "POST",
    body: JSON.stringify({ ops: [].concat(input) }),
  });

let mcpSession;
async function mcp(method, params, notify = false) {
  const body = { jsonrpc: "2.0", method, params };
  if (!notify) body.id = Math.floor(Math.random() * 1e6);
  const response = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer " + token,
      ...(mcpSession ? { "mcp-session-id": mcpSession } : {}),
    },
    body: JSON.stringify(body),
  });
  mcpSession ??= response.headers.get("mcp-session-id") ?? undefined;
  if (notify) return;
  const text = await response.text();
  const line = text.split("\n").filter((candidate) => candidate.startsWith("data: ")).pop();
  if (!line) throw new Error(method + " -> " + response.status + " " + text.slice(0, 300));
  const message = JSON.parse(line.slice(6));
  if (message.error) throw new Error(method + ": " + message.error.message);
  return message.result;
}
const tool = async (name, args) => {
  const result = await mcp("tools/call", { name, arguments: args });
  const text = result.content.map((item) => item.text).join("");
  if (result.isError) throw new Error(name + ": " + text);
  return text;
};
await mcp("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "variant-inheritance-e2e", version: "0" },
});
await mcp("notifications/initialized", undefined, true);

let doc = await load();
const mechanicId = doc.mechanics[0].id;
const firstStep = doc.steps[0].id;
const mt = doc.entities.find((entity) => entity.name === "MT").id;
const ot = doc.entities.find((entity) => entity.name === "OT").id;

await ops({ op: "add_step", name: "Follow-up", mechanic: mechanicId });
doc = await load();
const secondStep = doc.steps.find((step) => step.id !== firstStep).id;

const shared = (stepId, id, patch) => ({ op: "update_entity", id, patch, stepId });
await ops([
  shared(firstStep, mt, { x: 100, y: 110, color: "#112233" }),
  shared(firstStep, ot, { x: -100, y: -110, color: "#223344" }),
  shared(secondStep, mt, { x: 200, y: 210 }),
  shared(secondStep, ot, { x: -200, y: -210 }),
  { op: "add_variant", mechanicId },
]);
doc = await load();
const [A, B] = doc.mechanics[0].variants.map((variant) => variant.id);

/** The authored state the canvas resolves for named entities in one reading. */
const state = (stepId, variantId) =>
  page.evaluate(
    async ([id, sid, mechanic, variant]) => {
      const response = await fetch("/api/plans/" + id);
      const plan = await response.json().then((result) => result.plan ?? result);
      const schema = await import("/src/shared/schema.ts");
      const entities = schema.entitiesForStep(plan, sid, undefined, { [mechanic]: variant });
      const authored = schema.authoredEntitiesForStep(plan, sid, variant);
      const pick = (name) => {
        const entity = entities.find((candidate) => candidate.name === name);
        return entity
          ? { x: entity.x, y: entity.y, color: entity.color ?? null }
          : null;
      };
      return {
        MT: pick("MT"),
        OT: pick("OT"),
        detached: schema.variantStepEdited(plan, sid, variant),
        order: authored.filter((entity) => entity.type !== "marker").map((entity) => entity.id),
        ids: entities.map((entity) => entity.id),
        mechs: Object.fromEntries(authored.map((entity) => [entity.id, entity.mech ?? null])),
      };
    },
    [planId, stepId, mechanicId, variantId]
  );

const same = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
};

// Both new readings are live views of the state that already existed.
let a1 = await state(firstStep, A);
let b1 = await state(firstStep, B);
same(a1.MT, { x: 100, y: 110, color: "#112233" }, "A did not initially inherit shared MT");
same(b1.OT, { x: -100, y: -110, color: "#223344" }, "B did not initially inherit shared OT");
if (a1.detached) fail("new A was materialized too early");
if (b1.detached) fail("new B was materialized too early");

// Shared membership added before either reading is edited is live in both.
const inheritedNote = "text_inherited_note";
await ops({
  op: "add_entity",
  spec: { id: inheritedNote, type: "text", text: "shared before detach", steps: [firstStep] },
});
a1 = await state(firstStep, A);
b1 = await state(firstStep, B);
if (!a1.ids.includes(inheritedNote) || !b1.ids.includes(inheritedNote))
  fail("untouched variants did not inherit shared membership");

// Shared edits continue propagating while a reading is untouched.
await ops([
  shared(firstStep, mt, { x: 120, y: 130 }),
  shared(firstStep, ot, { x: -120, y: -130 }),
]);
a1 = await state(firstStep, A);
b1 = await state(firstStep, B);
same(a1.MT, { x: 120, y: 130, color: "#112233" }, "untouched A stopped following shared state");
same(b1.OT, { x: -120, y: -130, color: "#223344" }, "untouched B stopped following shared state");

// One field on one entity is enough to detach the whole A/step 1 state.
await ops({
  op: "update_entity",
  id: mt,
  patch: { x: 333 },
  stepId: firstStep,
  variant: A,
});
a1 = await state(firstStep, A);
same(a1.MT, { x: 333, y: 130, color: "#112233" }, "first edit lost inherited MT fields");
same(a1.OT, { x: -120, y: -130, color: "#223344" }, "first edit did not snapshot untouched OT");
if (!a1.detached) fail("A/step 1 was not detached");
const frozenOrder = a1.order;

await ops([
  shared(firstStep, mt, { x: 500, y: 510, color: "#aabbcc" }),
  shared(firstStep, ot, { x: -500, y: -510, color: "#bbccdd" }),
  { op: "delete_entities", ids: [inheritedNote] },
  {
    op: "add_entity",
    spec: { id: "text_after_detach", type: "text", text: "shared later", steps: [firstStep] },
  },
  { op: "reorder_entity", id: ot, where: "back" },
]);
a1 = await state(firstStep, A);
b1 = await state(firstStep, B);
same(a1.MT, { x: 333, y: 130, color: "#112233" }, "shared state overwrote detached A/MT");
same(a1.OT, { x: -120, y: -130, color: "#223344" }, "shared state overwrote detached A/OT");
same(b1.MT, { x: 500, y: 510, color: "#aabbcc" }, "A detachment isolated B from shared state");
same(b1.OT, { x: -500, y: -510, color: "#bbccdd" }, "untouched B did not keep following shared state");
if (!a1.ids.includes(inheritedNote) || a1.ids.includes("text_after_detach"))
  fail("shared add/delete leaked into detached A membership");
if (b1.ids.includes(inheritedNote) || !b1.ids.includes("text_after_detach"))
  fail("untouched B stopped following shared add/delete");
same(a1.order, frozenOrder, "shared reorder leaked into detached A");
if (b1.order[0] !== ot) fail("untouched B did not follow shared draw order");

// Detachment is per step: A/step 2 remains live until its own first edit.
await ops([
  shared(secondStep, mt, { x: 220, y: 230 }),
  shared(secondStep, ot, { x: -220, y: -230 }),
]);
let a2 = await state(secondStep, A);
same(a2.MT, { x: 220, y: 230, color: null }, "A/step 1 edit detached A/step 2");
if (a2.detached) fail("A/step 2 was detached before it was edited");

await ops({
  op: "update_entity",
  id: ot,
  patch: { y: -444 },
  stepId: secondStep,
  variant: A,
});
await ops([
  shared(secondStep, mt, { x: 600, y: 610 }),
  shared(secondStep, ot, { x: -600, y: -610 }),
]);
a2 = await state(secondStep, A);
const b2 = await state(secondStep, B);
same(a2.MT, { x: 220, y: 230, color: null }, "shared edit overwrote detached A/step 2 MT");
same(a2.OT, { x: -220, y: -444, color: null }, "shared edit overwrote detached A/step 2 OT");
same(b2.MT, { x: 600, y: 610, color: null }, "A/step 2 detachment affected B");

// Clear is an edit too: it detaches B/step 1 and freezes the base pose there.
await ops({ op: "clear_override", id: mt, stepId: firstStep, variant: B });
b1 = await state(firstStep, B);
const cleared = b1.MT;
const frozenOt = b1.OT;
if (!b1.detached) fail("clear_override did not detach B/step 1");
await ops([
  shared(firstStep, mt, { x: 700, y: 710 }),
  shared(firstStep, ot, { x: -700, y: -710 }),
]);
b1 = await state(firstStep, B);
same(b1.MT, cleared, "shared edit overwrote variant state materialized by clear_override");
same(b1.OT, frozenOt, "clear_override did not snapshot the rest of the step");

// Variant-scoped membership and order edits stay inside their detached scene.
await ops({ op: "add_variant", mechanicId });
doc = await load();
const C = doc.mechanics[0].variants.at(-1).id;
let c1 = await state(firstStep, C);
if (!c1.ids.includes("text_after_detach") || c1.ids.includes(inheritedNote) || c1.detached)
  fail("new C did not start as the current live shared scene");
const variantOnly = "text_variant_only";
await ops({
  op: "add_entity",
  spec: { id: variantOnly, type: "text", text: "C only", steps: [firstStep] },
  stepId: firstStep,
  variant: C,
});
const duplicated = await ops({
  op: "duplicate_entity",
  id: variantOnly,
  offset: 40,
  stepId: firstStep,
  variant: C,
});
const duplicateId = duplicated.values?.[0]?.id;
if (!duplicateId) fail("variant-scoped duplicate did not return its entity");
const madeMech = await ops({ op: "add_mech", name: "C scene cast", snap: firstStep, boom: firstStep });
const sceneMech = madeMech.values?.[0]?.id;
await ops({
  op: "assign_mech",
  ids: [duplicateId],
  mechId: sceneMech,
  stepId: firstStep,
  variant: C,
});
await ops({ op: "reorder_entity", id: variantOnly, where: "back", stepId: firstStep, variant: C });
await ops({ op: "delete_entities", ids: [mt], stepId: firstStep, variant: C });
c1 = await state(firstStep, C);
a1 = await state(firstStep, A);
b1 = await state(firstStep, B);
if (
  !c1.detached ||
  !c1.ids.includes(variantOnly) ||
  !c1.ids.includes(duplicateId) ||
  c1.ids.includes(mt) ||
  c1.order[0] !== variantOnly ||
  c1.mechs[duplicateId] !== sceneMech
)
  fail("C-scoped add/duplicate/assign/reorder/delete did not mutate C's standalone scene");
if (a1.ids.includes(variantOnly) || b1.ids.includes(variantOnly) || !a1.ids.includes(mt) || !b1.ids.includes(mt))
  fail("C-scoped membership edit leaked into another reading");

// MCP reads and searches can address the exact detached reading, including
// entities that have no plan-wide source record.
const describedC = await tool("read_plan", {
  plan_id: planId,
  step: firstStep,
  variant: C,
});
if (!describedC.includes(variantOnly) || !describedC.includes("C only"))
  fail("read_plan could not inspect a variant-only entity:\n" + describedC);
const foundC = await tool("find_entities", {
  plan_id: planId,
  step: firstStep,
  variant: C,
  query: "C only",
});
if (!foundC.includes(variantOnly))
  fail("find_entities could not rediscover a variant-only entity:\n" + foundC);

// Clearing an addition means reverting to the shared absence, not a no-op.
const clearOnly = "text_clear_only";
await ops({
  op: "add_entity",
  spec: { id: clearOnly, type: "text", text: "remove on clear", steps: [firstStep] },
  stepId: firstStep,
  variant: C,
});
await ops({ op: "clear_override", id: clearOnly, stepId: firstStep, variant: C });
c1 = await state(firstStep, C);
if (c1.ids.includes(clearOnly)) fail("clear_override kept a variant-only addition");
await ops({ op: "delete_mech", mechId: sceneMech });
c1 = await state(firstStep, C);
if (c1.ids.includes(duplicateId) || !c1.ids.includes(variantOnly))
  fail("shared mech deletion left its variant-scene entity or removed unrelated members");

// Later shared membership cannot enter any detached scene; a newly added D
// still opens on that latest shared source.
const postDetach = "text_post_detach";
await ops({
  op: "add_entity",
  spec: { id: postDetach, type: "text", text: "after C", steps: [firstStep] },
});
await ops({ op: "delete_entities", ids: [ot] });
await ops({ op: "add_variant", mechanicId });
doc = await load();
const D = doc.mechanics[0].variants.at(-1).id;
const d1 = await state(firstStep, D);
c1 = await state(firstStep, C);
a1 = await state(firstStep, A);
b1 = await state(firstStep, B);
if (a1.ids.includes(postDetach) || b1.ids.includes(postDetach) || c1.ids.includes(postDetach))
  fail("later shared addition entered a detached scene");
if (!a1.ids.includes(ot) || !b1.ids.includes(ot) || !c1.ids.includes(ot))
  fail("later shared deletion removed a member from a detached scene");
if (!d1.ids.includes(postDetach) || d1.ids.includes(ot) || d1.detached)
  fail("new D did not inherit the latest shared membership");

// Waymarks remain global even when a client supplies the currently displayed
// step and variant. These operations must not detach that reading.
const markerId = "marker_variant_global";
await ops({
  op: "add_entity",
  spec: { id: markerId, type: "marker", marker: "A", x: 10, y: 20 },
  stepId: firstStep,
  variant: D,
});
await ops({
  op: "update_entity",
  id: markerId,
  patch: { x: 77, y: 88 },
  stepId: firstStep,
  variant: D,
});
const markerCopy = await ops({
  op: "duplicate_entity",
  id: markerId,
  stepId: firstStep,
  variant: D,
});
const markerCopyId = markerCopy.values?.[0]?.id;
doc = await load();
if (doc.steps.find((candidate) => candidate.id === firstStep).variantScenes?.[D])
  fail("waymark edit detached an untouched variant step");
const storedMarker = doc.entities.find((candidate) => candidate.id === markerId);
if (storedMarker?.x !== 77 || storedMarker?.y !== 88 || !markerCopyId)
  fail("waymark contextual operations did not remain global");
await ops({
  op: "delete_entities",
  ids: [markerId, markerCopyId],
  stepId: firstStep,
  variant: D,
});
doc = await load();
if (doc.entities.some((candidate) => candidate.id === markerId || candidate.id === markerCopyId))
  fail("contextual waymark delete was not global");
if (doc.steps.find((candidate) => candidate.id === firstStep).variantScenes?.[D])
  fail("waymark delete detached an untouched variant step");

// Legacy sparse `step@variant` overrides materialize deterministically during
// hydration, preserving their old resolved state before shared edits resume.
const legacy = await page.evaluate(
  async ([id, sid, eid, mechanic, variant]) => {
    const response = await fetch("/api/plans/" + id);
    const stored = await response.json().then((result) => result.plan ?? result);
    for (const step of stored.steps) delete step.variantScenes;
    const entity = stored.entities.find((candidate) => candidate.id === eid);
    entity.overrides = { ...entity.overrides, [sid + "@" + variant]: { x: 909, y: 919 } };
    const schema = await import("/src/shared/schema.ts");
    const apply = await import("/src/shared/apply.ts");
    const hydrated = schema.hydratePlan(stored);
    const before = schema.entitiesForStep(hydrated, sid, undefined, { [mechanic]: variant })
      .find((candidate) => candidate.id === eid);
    const changed = apply.applyOp(hydrated, {
      op: "update_entity",
      id: eid,
      patch: { x: -909, y: -919 },
      stepId: sid,
    }).plan;
    const after = schema.entitiesForStep(changed, sid, undefined, { [mechanic]: variant })
      .find((candidate) => candidate.id === eid);
    const clearedPlan = apply.applyOp(hydrated, {
      op: "clear_override",
      id: eid,
      stepId: sid,
      variant,
    }).plan;
    const cleared = schema.entitiesForStep(clearedPlan, sid, undefined, { [mechanic]: variant })
      .find((candidate) => candidate.id === eid);
    const shared = schema.resolveEntity(stored.entities.find((candidate) => candidate.id === eid), sid);
    return {
      detached: schema.variantStepEdited(hydrated, sid, variant),
      before: { x: before.x, y: before.y },
      after: { x: after.x, y: after.y },
      cleared: { x: cleared.x, y: cleared.y },
      shared: { x: shared.x, y: shared.y },
    };
  },
  [planId, firstStep, mt, mechanicId, A]
);
if (!legacy.detached || legacy.before.x !== 909 || legacy.before.y !== 919)
  fail("legacy variant override did not hydrate into a scene snapshot");
same(legacy.after, legacy.before, "shared edit overwrote hydrated legacy scene");
same(legacy.cleared, legacy.shared, "clear_override retained a legacy variant overlay");

// Timeline lifecycle operations must neither discard a surviving authored
// reading nor leave snapshots keyed to a mechanic the step no longer belongs to.
const lifecycle = await page.evaluate(async () => {
  const ops = await import("/src/shared/ops.ts");
  const apply = await import("/src/shared/apply.ts");
  const mutate = (plan, op) => apply.applyOp(plan, op).plan;

  let survivor = ops.createPlan({ withParty: true });
  const survivorStep = survivor.steps[0].id;
  const survivorMechanic = survivor.mechanics[0].id;
  const survivorMt = survivor.entities.find((entity) => entity.name === "MT").id;
  survivor = mutate(survivor, { op: "add_variant", mechanicId: survivorMechanic });
  const [surviving, removed] = survivor.mechanics[0].variants.map((variant) => variant.id);
  survivor = mutate(survivor, {
    op: "update_entity",
    id: survivorMt,
    patch: { x: 321 },
    stepId: survivorStep,
    variant: surviving,
  });
  const before = JSON.stringify(survivor.steps[0].variantScenes[surviving]);
  survivor = mutate(survivor, {
    op: "delete_variant",
    mechanicId: survivorMechanic,
    variantId: removed,
  });

  let adopted = ops.createPlan({ withParty: true });
  const adoptedStep = adopted.steps[0].id;
  const adoptedMechanic = adopted.mechanics[0].id;
  const adoptedMt = adopted.entities.find((entity) => entity.name === "MT").id;
  adopted = mutate(adopted, { op: "add_variant", mechanicId: adoptedMechanic });
  const adoptedVariant = adopted.mechanics[0].variants[0].id;
  adopted = mutate(adopted, {
    op: "update_entity",
    id: adoptedMt,
    patch: { x: 654 },
    stepId: adoptedStep,
    variant: adoptedVariant,
  });
  const adoptedScene = JSON.stringify(adopted.steps[0].variantScenes);
  let adoptedRejected = false;
  try {
    adopted = mutate(adopted, {
      op: "add_mechanic",
      name: "adopter",
      stepIds: [adoptedStep],
    });
  } catch {
    adoptedRejected = true;
  }

  let merged = ops.createPlan({ withParty: true });
  const mergedStep = merged.steps[0].id;
  const mergedMechanic = merged.mechanics[0].id;
  const mergedMt = merged.entities.find((entity) => entity.name === "MT").id;
  merged = mutate(merged, { op: "add_variant", mechanicId: mergedMechanic });
  const mergedVariant = merged.mechanics[0].variants[0].id;
  merged = mutate(merged, {
    op: "update_entity",
    id: mergedMt,
    patch: { x: 987 },
    stepId: mergedStep,
    variant: mergedVariant,
  });
  merged = mutate(merged, { op: "add_mechanic", name: "neighbour" });
  const mergedScene = JSON.stringify(
    merged.steps.find((step) => step.id === mergedStep).variantScenes
  );
  let mergedRejected = false;
  try {
    merged = mutate(merged, {
      op: "delete_mechanic",
      mechanicId: mergedMechanic,
      keepSteps: true,
    });
  } catch {
    mergedRejected = true;
  }

  let deletedStep = ops.createPlan({ withParty: true });
  const deletedSource = deletedStep.steps[0].id;
  const deletedMechanic = deletedStep.mechanics[0].id;
  const deletedMt = deletedStep.entities.find((entity) => entity.name === "MT").id;
  deletedStep = mutate(deletedStep, { op: "add_variant", mechanicId: deletedMechanic });
  const deletedVariant = deletedStep.mechanics[0].variants[0].id;
  deletedStep = mutate(deletedStep, {
    op: "update_entity",
    id: deletedMt,
    patch: { x: 246 },
    stepId: deletedSource,
    variant: deletedVariant,
  });
  deletedStep = mutate(deletedStep, { op: "duplicate_step", stepId: deletedSource });
  const deletedCopy = deletedStep.steps.find((step) => step.id !== deletedSource).id;
  deletedStep = mutate(deletedStep, { op: "delete_step", stepId: deletedSource });
  const copiedScene = deletedStep.steps.find((step) => step.id === deletedCopy)
    .variantScenes?.[deletedVariant];

  const firstEdits = {};
  for (const kind of [
    "update_entity",
    "clear_override",
    "add_entity",
    "delete_entities",
    "duplicate_entity",
    "reorder_entity",
    "assign_mech",
    "arrange_party",
  ]) {
    let sample = ops.createPlan({ withParty: true });
    const sid = sample.steps[0].id;
    const mechanicId = sample.mechanics[0].id;
    const target = sample.entities.find((entity) => entity.name === "MT").id;
    sample = mutate(sample, { op: "add_variant", mechanicId });
    const [variant, untouched] = sample.mechanics[0].variants.map((item) => item.id);
    let operation;
    if (kind === "update_entity")
      operation = { op: kind, id: target, patch: { x: 42 }, stepId: sid, variant };
    else if (kind === "clear_override")
      operation = { op: kind, id: target, stepId: sid, variant };
    else if (kind === "add_entity")
      operation = {
        op: kind,
        spec: { id: "first_add", type: "text", text: "first", steps: [sid] },
        stepId: sid,
        variant,
      };
    else if (kind === "delete_entities")
      operation = { op: kind, ids: [target], stepId: sid, variant };
    else if (kind === "duplicate_entity")
      operation = { op: kind, id: target, stepId: sid, variant };
    else if (kind === "reorder_entity")
      operation = { op: kind, id: target, where: "front", stepId: sid, variant };
    else if (kind === "assign_mech") {
      sample = mutate(sample, { op: "add_mech", name: "slot", snap: sid, boom: sid });
      operation = {
        op: kind,
        ids: [target],
        mechId: sample.mechs[0].id,
        stepId: sid,
        variant,
      };
    } else
      operation = { op: kind, radiusFraction: 0.5, stepId: sid, variant };
    sample = mutate(sample, operation);
    firstEdits[kind] = {
      detached: Object.prototype.hasOwnProperty.call(sample.steps[0].variantScenes ?? {}, variant),
      untouched: Object.prototype.hasOwnProperty.call(sample.steps[0].variantScenes ?? {}, untouched),
    };
  }

  let emptyArrangement = ops.createPlan({ withParty: false });
  const emptyStep = emptyArrangement.steps[0].id;
  const emptyMechanic = emptyArrangement.mechanics[0].id;
  emptyArrangement = mutate(emptyArrangement, { op: "add_variant", mechanicId: emptyMechanic });
  const emptyVariant = emptyArrangement.mechanics[0].variants[0].id;
  const emptyRevision = emptyArrangement.rev;
  emptyArrangement = mutate(emptyArrangement, {
    op: "arrange_party",
    stepId: emptyStep,
    variant: emptyVariant,
  });

  return {
    surviving,
    survivorVariants: survivor.mechanics[0].variants.map((variant) => variant.id),
    survivorExact: JSON.stringify(survivor.steps[0].variantScenes?.[surviving]) === before,
    adoptedRejected,
    adoptedPreserved:
      JSON.stringify(adopted.steps.find((step) => step.id === adoptedStep).variantScenes) ===
      adoptedScene,
    mergedRejected,
    mergedPreserved:
      JSON.stringify(merged.steps.find((step) => step.id === mergedStep).variantScenes) ===
      mergedScene,
    deletedStepPreserved:
      copiedScene?.find((entity) => entity.id === deletedMt)?.x === 246 &&
      !copiedScene.some((entity) => entity.declaredIn === deletedSource),
    firstEdits,
    emptyArrangement: {
      detached: Object.prototype.hasOwnProperty.call(
        emptyArrangement.steps[0].variantScenes ?? {},
        emptyVariant,
      ),
      revisionAdvanced: emptyArrangement.rev > emptyRevision,
    },
  };
});
same(lifecycle.survivorVariants, [lifecycle.surviving], "detached survivor id");
if (!lifecycle.survivorExact || lifecycle.survivorVariants.length !== 1)
  fail("deleting a sibling discarded or dissolved the detached survivor");
if (
  !lifecycle.adoptedRejected ||
  !lifecycle.adoptedPreserved ||
  !lifecycle.mergedRejected ||
  !lifecycle.mergedPreserved
)
  fail("mechanic adoption/keepSteps did not reject and preserve authored variant scenes");
if (!lifecycle.deletedStepPreserved)
  fail("deleting a source step corrupted the copied variant scene");
for (const [kind, result] of Object.entries(lifecycle.firstEdits)) {
  if (!result.detached || result.untouched)
    fail(kind + " did not detach exactly its addressed variant as the first edit");
}
if (!lifecycle.emptyArrangement.detached || !lifecycle.emptyArrangement.revisionAdvanced)
  fail("arranging an empty variant scene did not persist its first-edit detachment");

await browser.close();
console.log(process.exitCode ? "FAILED" : "OK - variant state inherits until its first step edit");
