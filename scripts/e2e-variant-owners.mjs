/**
 * One plan, everybody's reading of the same fight.
 *
 * A variant belongs to whoever added it. What it owns — where people stand in
 * it, which casts go off in it — is theirs to change and nobody else's, even
 * from an editor's hands. Everything else about the plan stays shared: steps,
 * sections, and the shapes that happen whichever way it goes.
 *
 *   node scripts/e2e-variant-owners.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

/** A signed-in person, with their own cookie jar, talking to the API. */
async function person(name) {
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  await page.goto(base + "/auth/dev?name=" + name);
  const call = (path, init = {}) =>
    page.evaluate(
      async ([p, i]) => {
        const r = await fetch(p, {
          ...i,
          headers: { "content-type": "application/json", ...(i.headers ?? {}) },
        });
        const t = await r.text();
        return { status: r.status, body: t ? JSON.parse(t) : null };
      },
      [path, init]
    );
  return {
    name,
    page,
    call,
    async ops(planId, o) {
      return call("/api/plans/" + planId + "/ops", {
        method: "POST",
        body: JSON.stringify({ ops: [].concat(o) }),
      });
    },
    async plan(planId) {
      return (await call("/api/plans/" + planId)).body?.plan;
    },
  };
}

const kate = await person("kate");
const sam = await person("sam");

const made = await kate.call("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "the shitshow", withParty: true }),
});
const planId = made.body.id;
// Sam is an editor on the master, the way a group's plan works.
await kate.call("/api/plans/" + planId + "/share", {
  method: "POST",
  body: JSON.stringify({ userId: "local:sam", role: "editor" }),
});

let doc = await kate.plan(planId);
const mechanicId = doc.mechanics[0].id;
const step = doc.steps[0].id;
const mt = doc.entities.find((e) => e.name === "MT").id;

/* --- each of them adds their own reading ----------------------------------- */

await sam.ops(planId, { op: "add_variant", mechanicId });
doc = await kate.plan(planId);
const sams = doc.mechanics[0].variants.at(-1);
await kate.ops(planId, { op: "add_variant", mechanicId });
doc = await kate.plan(planId);
const kates = doc.mechanics[0].variants.at(-1);
const first = doc.mechanics[0].variants[0];

if (sams.ownerId !== "local:sam") fail("Sam's reading is owned by " + sams.ownerId);
else if (kates.ownerId !== "local:kate") fail("Kate's reading is owned by " + kates.ownerId);
else if (first.ownerId) fail("the reading that was already there got an owner: " + first.ownerId);
else
  console.log(
    "three readings: the plan's own, " + sams.ownerName + "'s and " + kates.ownerName + "'s"
  );

/* --- and can move people about in it --------------------------------------- */

const move = (who, variant, x) =>
  who.ops(planId, {
    op: "update_entity",
    id: mt,
    patch: { x, y: -300 },
    stepId: step,
    variant,
  });

const mine = await move(sam, sams.id, -400);
if (mine.status !== 200) fail("Sam could not move MT in his own reading: " + JSON.stringify(mine.body));
else console.log("Sam moves MT where he likes in his own reading");

/* --- but not in each other's ----------------------------------------------- */

const theirs = await move(sam, kates.id, 400);
if (theirs.status !== 403)
  fail("Sam edited Kate's reading and got " + theirs.status);
else console.log("and is refused Kate's: " + theirs.body.error);

const renamed = await sam.ops(planId, {
  op: "update_variant",
  mechanicId,
  variantId: kates.id,
  patch: { name: "Sam's way" },
});
const deleted = await sam.ops(planId, { op: "delete_variant", mechanicId, variantId: kates.id });
if (renamed.status !== 403) fail("Sam renamed Kate's reading: " + renamed.status);
else if (deleted.status !== 403) fail("Sam deleted Kate's reading: " + deleted.status);
else console.log("nor can he rename it or take it away");

/* --- a cast gated to a reading is that reading's too ------------------------ */

await kate.ops(planId, { op: "add_mech", name: "Kate's puddle", snap: step, boom: step });
doc = await kate.plan(planId);
const cast = doc.mechs.at(-1).id;
await kate.ops(planId, { op: "gate_mech", mechId: cast, variant: kates.id });
const gatedShape = "zone_kates_gated";
await kate.ops(planId, {
  op: "add_entity",
  spec: {
    id: gatedShape,
    type: "zone",
    shape: "circle",
    radius: 100,
    mech: cast,
    steps: "all",
  },
});
const stolen = await sam.ops(planId, { op: "gate_mech", mechId: cast, variant: sams.id });
const scrapped = await sam.ops(planId, { op: "delete_mech", mechId: cast });
if (stolen.status !== 403) fail("Sam took a cast out of Kate's reading: " + stolen.status);
else if (scrapped.status !== 403) fail("Sam deleted a cast of Kate's: " + scrapped.status);
else console.log("a cast that only goes off in her reading is hers as well");

// Omitting the scene context must not turn someone else's gated entity into a
// shared edit. Target ownership is derived from the entity, not caller claims.
const globalAttacks = [
  { op: "update_entity", id: gatedShape, patch: { color: "#ffffff" } },
  { op: "clear_override", id: gatedShape, stepId: step },
  { op: "duplicate_entity", id: gatedShape },
  { op: "reorder_entity", id: gatedShape, where: "front" },
  { op: "delete_entities", ids: [gatedShape] },
  { op: "assign_mech", ids: [gatedShape], mechId: null },
  {
    op: "add_entity",
    spec: { type: "zone", shape: "circle", radius: 50, mech: cast, steps: "all" },
  },
];
for (const attack of globalAttacks) {
  const response = await sam.ops(planId, attack);
  if (response.status !== 403)
    fail("global-scope gated entity bypass for " + attack.op + ": " + response.status);
}

// Every contextual mutation is protected, including targets that live in a
// detached scene rather than the plan-wide entity list.
await kate.ops(planId, {
  op: "add_entity",
  spec: { id: "text_kate_only", type: "text", text: "Kate only", steps: [step] },
  stepId: step,
  variant: kates.id,
});
const contextualAttacks = [
  { op: "update_entity", id: "text_kate_only", patch: { x: 1 }, stepId: step, variant: kates.id },
  { op: "clear_override", id: "text_kate_only", stepId: step, variant: kates.id },
  { op: "duplicate_entity", id: "text_kate_only", stepId: step, variant: kates.id },
  { op: "reorder_entity", id: "text_kate_only", where: "front", stepId: step, variant: kates.id },
  { op: "delete_entities", ids: ["text_kate_only"], stepId: step, variant: kates.id },
  { op: "assign_mech", ids: ["text_kate_only"], mechId: null, stepId: step, variant: kates.id },
  {
    op: "add_entity",
    spec: { type: "text", text: "intrusion", steps: [step] },
    stepId: step,
    variant: kates.id,
  },
  { op: "arrange_party", stepId: step, variant: kates.id },
];
for (const attack of contextualAttacks) {
  const response = await sam.ops(planId, attack);
  if (response.status !== 403)
    fail("context ownership bypass for " + attack.op + ": " + response.status);
}

// A variant without its step, or one paired with the wrong mechanic, is an
// invalid address and is rejected before it can fall through to shared state.
const halfContext = await sam.ops(planId, {
  op: "update_entity",
  id: mt,
  patch: { x: 999 },
  variant: sams.id,
});
if (halfContext.status !== 400) fail("half-context edit returned " + halfContext.status);
await kate.ops(planId, { op: "add_mechanic", name: "Other mechanic" });
doc = await kate.plan(planId);
const otherMechanic = doc.mechanics.find((mechanic) => mechanic.name === "Other mechanic");
const otherStep = doc.steps.find((candidate) => candidate.mechanic === otherMechanic.id).id;
const wrongPair = await sam.ops(planId, {
  op: "update_entity",
  id: mt,
  patch: { x: 998 },
  stepId: otherStep,
  variant: sams.id,
});
if (wrongPair.status !== 400) fail("wrong step/variant pair returned " + wrongPair.status);

// Waymarks are shared even while another author's reading is displayed, and
// touching one must not materialize that reading.
const sharedMarker = "marker_shared_owner_test";
await kate.ops(planId, {
  op: "add_entity",
  spec: { id: sharedMarker, type: "marker", marker: "A", x: 0, y: 0 },
});
const markerEdit = await sam.ops(planId, {
  op: "update_entity",
  id: sharedMarker,
  patch: { x: 55 },
  stepId: step,
  variant: kates.id,
});
doc = await kate.plan(planId);
if (markerEdit.status !== 200) fail("shared waymark was owner-blocked: " + markerEdit.status);
else if (doc.entities.find((entity) => entity.id === sharedMarker)?.x !== 55)
  fail("shared waymark did not update globally");
// Kate's scene was already materialized above for the contextual attack setup;
// the marker itself must still never be copied into it.
else if (doc.steps.find((candidate) => candidate.id === step).variantScenes?.[kates.id]
  .some((entity) => entity.id === sharedMarker))
  fail("shared waymark was copied into a variant scene");

/* --- the public op boundary cannot smuggle broad document patches --------- */

const malformedAttacks = [
  { label: "replace_plan", op: { op: "replace_plan", plan: { ...doc, name: "stolen" } } },
  {
    label: "mechanic variants patch",
    op: { op: "update_mechanic", mechanicId, patch: { variants: [] } },
  },
  {
    label: "variant owner patch",
    op: {
      op: "update_variant",
      mechanicId,
      variantId: kates.id,
      patch: { ownerId: "local:sam" },
    },
  },
  {
    label: "mech variant patch",
    op: { op: "update_mech", mechId: cast, patch: { variant: sams.id } },
  },
  {
    label: "step id patch",
    op: { op: "update_step", stepId: step, patch: { id: "step_stolen" } },
  },
  {
    label: "step mechanic patch",
    op: { op: "update_step", stepId: step, patch: { mechanic: otherMechanic.id } },
  },
  {
    label: "entity internal patch",
    op: { op: "update_entity", id: mt, patch: { overrides: {}, mech: cast } },
  },
  {
    label: "entity internal create fields",
    op: { op: "add_entity", spec: { type: "text", text: "bad", overrides: {} } },
  },
  {
    label: "forged variant owner",
    op: { op: "add_variant", mechanicId, ownerId: "local:sam", ownerName: "Sam" },
  },
  { label: "unknown operation", op: { op: "rewrite_everything", plan: doc } },
  { label: "unknown operation field", op: { op: "set_meta", name: "bad", surprise: true } },
  {
    label: "duplicate entity id",
    op: { op: "add_entity", spec: { id: mt, type: "text", text: "collision" } },
  },
];
for (const attack of malformedAttacks) {
  const response = await sam.ops(planId, attack.op);
  if (response.status !== 400)
    fail(attack.label + " crossed the strict op boundary: " + response.status);
}
const duplicateBatch = await sam.ops(planId, [
  { op: "add_entity", spec: { id: "same_batch_id", type: "text", text: "one" } },
  { op: "add_entity", spec: { id: "same_batch_id", type: "text", text: "two" } },
]);
if (duplicateBatch.status !== 400)
  fail("duplicate ids inside one batch crossed the strict op boundary");

// Two requests may validate the same revision concurrently. Exactly one may
// introduce a caller-supplied id; the loser must revalidate against the winner.
const concurrentId = "concurrent_unique_id";
const concurrentAdds = await Promise.all([
  kate.ops(planId, { op: "add_entity", spec: { id: concurrentId, type: "text", text: "Kate" } }),
  sam.ops(planId, { op: "add_entity", spec: { id: concurrentId, type: "text", text: "Sam" } }),
]);
const concurrentStatuses = concurrentAdds.map((response) => response.status).sort();
if (JSON.stringify(concurrentStatuses) !== JSON.stringify([200, 400]))
  fail("concurrent duplicate ids were not serialized and revalidated: " + concurrentStatuses);
else if ((await kate.plan(planId)).entities.filter((entity) => entity.id === concurrentId).length !== 1)
  fail("concurrent duplicate ids persisted more than once");

const ownerReplace = await kate.ops(planId, { op: "replace_plan", plan: doc });
if (ownerReplace.status !== 400)
  fail("replace_plan remained available on the public ops route to owners");

doc = await kate.plan(planId);
if (doc.name === "stolen") fail("a rejected whole-plan replacement persisted");
else if (doc.mechanics[0].variants.find((variant) => variant.id === kates.id)?.ownerId !== "local:kate")
  fail("a rejected owner patch persisted");
else if (!doc.steps.some((candidate) => candidate.id === step))
  fail("a rejected step id patch persisted");

// Copying or deleting a step copies/deletes its authors' full scene snapshots.
// An editor may not do that to another author's reading.
const copiedForeignStep = await sam.ops(planId, { op: "duplicate_step", stepId: step });
const deletedForeignStep = await sam.ops(planId, { op: "delete_step", stepId: step });
if (copiedForeignStep.status !== 403)
  fail("Sam copied Kate's authored scene with its step: " + copiedForeignStep.status);
else if (deletedForeignStep.status !== 403)
  fail("Sam deleted Kate's authored scene with its step: " + deletedForeignStep.status);

// Removing either endpoint rewrites a multi-step cast by collapsing it onto the
// survivor. That is an edit to the reading which owns the gated cast.
await kate.ops(planId, { op: "add_step", name: "Other resolve", mechanic: otherMechanic.id });
doc = await kate.plan(planId);
const otherEnd = doc.steps.find(
  (candidate) => candidate.mechanic === otherMechanic.id && candidate.id !== otherStep
).id;
await kate.ops(planId, {
  op: "add_mech",
  name: "Kate endpoint cast",
  snap: otherStep,
  boom: otherEnd,
});
await kate.ops(planId, { op: "add_variant", mechanicId: otherMechanic.id });
doc = await kate.plan(planId);
const endpointCast = doc.mechs.find((mech) => mech.name === "Kate endpoint cast").id;
const otherKate = doc.mechanics.find((mechanic) => mechanic.id === otherMechanic.id).variants.at(-1);
await kate.ops(planId, { op: "gate_mech", mechId: endpointCast, variant: otherKate.id });
const deletedSnap = await sam.ops(planId, { op: "delete_step", stepId: otherStep });
const deletedBoom = await sam.ops(planId, { op: "delete_step", stepId: otherEnd });
if (deletedSnap.status !== 403 || deletedBoom.status !== 403)
  fail("deleting a gated cast endpoint bypassed its owner: " + deletedSnap.status + "/" + deletedBoom.status);

// Deleting a different row can still rewrite a remaining authored scene by
// clearing an object's declaredIn source.
await kate.ops(planId, { op: "add_step", name: "Declaration source", mechanic: otherMechanic.id });
doc = await kate.plan(planId);
const declarationSource = doc.steps.find((candidate) => candidate.name === "Declaration source").id;
await kate.ops(planId, {
  op: "add_entity",
  spec: {
    id: "kate_declared_elsewhere",
    type: "text",
    text: "declared elsewhere",
    steps: [step],
    declaredIn: declarationSource,
  },
  stepId: step,
  variant: kates.id,
});
const deletedDeclaration = await sam.ops(planId, { op: "delete_step", stepId: declarationSource });
if (deletedDeclaration.status !== 403)
  fail("step deletion rewrote declaredIn inside Kate's scene: " + deletedDeclaration.status);

// The same cleanup runs over plan-wide entities. A gated base entity remains
// owned even when no detached scene refers to the deleted source step.
await kate.ops(planId, { op: "add_step", name: "Base declaration source", mechanic: otherMechanic.id });
doc = await kate.plan(planId);
const baseDeclarationSource = doc.steps.find(
  (candidate) => candidate.name === "Base declaration source"
).id;
await kate.ops(planId, {
  op: "add_entity",
  spec: {
    id: "kate_gated_base_declaration",
    type: "zone",
    shape: "circle",
    radius: 30,
    mech: cast,
    declaredIn: baseDeclarationSource,
  },
});
const deletedBaseDeclaration = await sam.ops(planId, {
  op: "delete_step",
  stepId: baseDeclarationSource,
});
if (deletedBaseDeclaration.status !== 403)
  fail("step deletion rewrote a gated base entity: " + deletedBaseDeclaration.status);

// A global party arrangement also edits players assigned to gated casts; their
// cast owner must be included even though no variant context was claimed.
const gatedPlayer = "player_kate_gated";
await kate.ops(planId, {
  op: "add_entity",
  spec: { id: gatedPlayer, type: "player", name: "Kate gated", job: "any", steps: "all" },
});
await kate.ops(planId, { op: "assign_mech", ids: [gatedPlayer], mechId: cast });
const arrangedForeignPlayer = await sam.ops(planId, { op: "arrange_party" });
if (arrangedForeignPlayer.status !== 403)
  fail("global arrange moved a player in Kate's gated cast: " + arrangedForeignPlayer.status);

// Gating and editing the same object concurrently must serialize authorization.
await kate.ops(planId, { op: "add_mech", name: "Race cast", snap: step, boom: step });
doc = await kate.plan(planId);
const raceCast = doc.mechs.find((mech) => mech.name === "Race cast").id;
const raceEntity = "zone_gate_race";
await kate.ops(planId, {
  op: "add_entity",
  spec: { id: raceEntity, type: "zone", shape: "circle", radius: 40, mech: raceCast },
});
const [gatedRace, editedRace] = await Promise.all([
  kate.ops(planId, { op: "gate_mech", mechId: raceCast, variant: kates.id }),
  sam.ops(planId, { op: "update_entity", id: raceEntity, patch: { radius: 41 } }),
]);
if (gatedRace.status !== 200 || ![200, 403].includes(editedRace.status))
  fail("gate/update concurrency returned unexpected statuses: " + gatedRace.status + "/" + editedRace.status);
else if (
  editedRace.status === 200 &&
  !(editedRace.body.rev < gatedRace.body.rev)
)
  fail("Sam's edit applied after Kate's gate despite stale authorization");

const history = await sam.call("/api/plans/" + planId + "/history");
const revisionId = history.body?.revisions?.[0]?.id;
const historyAttacks = [
  await sam.call("/api/plans/" + planId + "/history/undo", { method: "POST" }),
  await sam.call("/api/plans/" + planId + "/history/redo", { method: "POST" }),
  await sam.call("/api/plans/" + planId + "/history/revert", {
    method: "POST",
    body: JSON.stringify({ revisionId }),
  }),
];
if (historyAttacks.some((response) => response.status !== 403))
  fail("an editor restored whole-plan history: " + historyAttacks.map((response) => response.status));

/* --- while the fight itself stays everybody's ------------------------------ */

const shared = await sam.ops(planId, [
  { op: "add_step", name: "Sam's step" },
  { op: "update_entity", id: mt, patch: { x: 0, y: 0 }, stepId: step },
]);
if (shared.status !== 200)
  fail("Sam could not edit the plan's own things: " + JSON.stringify(shared.body));
else console.log("but the steps, and where people stand whichever way it goes, are still shared");

/* --- and the plan's owner is not shut out of her own plan ------------------- */

const owner = await move(kate, sams.id, 250);
if (owner.status !== 200) fail("the plan's owner was refused Sam's reading: " + owner.status);
else console.log("the owner of the plan can still reach into any of it — it is her plan");

/* --- the pill says whose it is --------------------------------------------- */

await sam.page.goto(base + "/p/" + planId);
await sam.page.waitForTimeout(2000);
const pills = await sam.page.locator("nav [data-variant]").allInnerTexts();
const owners = await Promise.all(
  (await sam.page.locator("nav [data-variant]").all()).map((el) => el.getAttribute("data-owner"))
);
if (!pills.some((t) => /kate/i.test(t))) fail("the rail does not say whose reading is whose: " + JSON.stringify(pills));
else console.log("and the rail says so: " + JSON.stringify(pills.map((p) => p.replace(/\n/g, " "))));
if (owners.filter(Boolean).length !== 2) fail("the readings' owners are " + JSON.stringify(owners));

await browser.close();
console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
