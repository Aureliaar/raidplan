/**
 * The Snap marker: when a Beat's baits stop following.
 *
 * A Beat is on the floor from the step it casts in to the step it resolves in,
 * and its baits are aimed at somebody. The marker says how long "aimed at" is
 * live: up to and including the step it freezes in a bait follows its target
 * around, and from the next step to the explosion it is drawn where it stood
 * there — the telegraph on the floor, with the party walking out of it.
 *
 *   npm run dev                       # in another terminal
 *   node scripts/e2e-freeze.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=freeze-e2e");
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
  body: JSON.stringify({ name: "freeze e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);
const ops = (o) =>
  api("/api/plans/" + planId + "/ops", { method: "POST", body: JSON.stringify({ ops: [].concat(o) }) });

/** What the canvas would draw in a step — the one resolver everything reads. */
const drawn = (stepId) =>
  page.evaluate(
    async ([id, sid]) => {
      const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
      const mod = await import("/src/shared/schema.ts");
      return mod
        .entitiesForStep(d, sid)
        .map((e) => ({ id: e.id, x: Math.round(e.x), y: Math.round(e.y) }));
    },
    [planId, stepId]
  );
const at = async (stepId, entityId) => (await drawn(stepId)).find((e) => e.id === entityId);

/* --- four steps, one Beat that spans all of them -------------------------- */

let doc = await load();
const first = doc.steps[0].id;
await ops([
  { op: "update_step", stepId: first, patch: { name: "One" } },
  { op: "add_step", name: "Two" },
  { op: "add_step", name: "Three" },
  { op: "add_step", name: "Four" },
]);
doc = await load();
const steps = doc.steps.map((s) => s.id);
if (steps.length !== 4) fail("expected four steps, got " + steps.length);

// Somebody to bait, walking a straight line east: one step, one nudge.
const player = doc.entities.find((e) => e.type === "player");
const walk = [
  { x: -300, y: 0 },
  { x: -100, y: 0 },
  { x: 100, y: 0 },
  { x: 300, y: 0 },
];
await ops(
  steps.map((sid, i) => ({ op: "update_entity", id: player.id, patch: walk[i], stepId: sid })),
);

await ops({ op: "add_mech", name: "Missile", snap: steps[0], boom: steps[3] });
doc = await load();
const beat = doc.mechs[0].id;
await ops({
  op: "add_entity",
  spec: { type: "zone", shape: "spread", radius: 120, mech: beat, anchor: { to: player.id } },
});
doc = await load();
const bait = doc.entities.find((e) => e.type === "zone").id;

const where = async () => {
  const out = [];
  for (const sid of steps) out.push((await at(sid, bait)).x);
  return out;
};

// Nothing has been said about the marker yet, so it freezes at the snapshot:
// the bait marks step one and the player walks out of it.
if ((await where()).join() !== "-300,-300,-300,-300")
  fail("a Beat with no marker did not freeze at its snapshot: " + (await where()).join());
else console.log("with no marker the bait holds the snapshot pose: " + (await where()).join());

/* --- freeze in step two --------------------------------------------------- */

await ops({ op: "update_mech", mechId: beat, patch: { freeze: steps[1] } });
doc = await load();
if (doc.mechs[0].freeze !== steps[1]) fail("the marker did not stick: " + JSON.stringify(doc.mechs[0].freeze));

const frozen = await where();
if (frozen.join() !== "-300,-100,-100,-100")
  fail("freezing in step two drew the bait at " + frozen.join() + ", expected -300,-100,-100,-100");
else
  console.log(
    "frozen in step two: it follows through steps one and two (" +
      frozen.slice(0, 2).join(", ") +
      ") and holds step two's pose in three and four (" +
      frozen.slice(2).join(", ") +
      ")",
  );

// The player really did keep walking, so "it held" is a claim about the bait.
const walked = [];
for (const sid of steps) walked.push((await at(sid, player.id)).x);
if (walked.join() !== "-300,-100,100,300") fail("the player did not walk: " + walked.join());

/* --- and back to the snapshot --------------------------------------------- */

await ops({ op: "update_mech", mechId: beat, patch: { freeze: "" } });
doc = await load();
if (doc.mechs[0].freeze !== "") fail("clearing the marker left " + JSON.stringify(doc.mechs[0].freeze));
const cleared = await where();
if (cleared.join() !== "-300,-300,-300,-300")
  fail("clearing the marker drew the bait at " + cleared.join());
else console.log("clearing it puts the bait back on the snapshot from step two on");

/* --- the marker is clamped to the span it belongs to ---------------------- */

// On the explosion is no marker at all: it stops at the step before it.
await ops({ op: "update_mech", mechId: beat, patch: { freeze: steps[3] } });
doc = await load();
if (doc.mechs[0].freeze !== steps[2])
  fail("a marker dropped on the explosion was not pulled back to the step before it");
else console.log("a marker on the explosion step is clamped back to the step before it");

// Shortening the Beat until nothing is left between cast and resolve clears it.
await ops({ op: "update_mech", mechId: beat, patch: { boom: steps[1] } });
doc = await load();
if (doc.mechs[0].freeze !== "")
  fail("shortening the Beat to two steps left a marker: " + JSON.stringify(doc.mechs[0].freeze));
else console.log("shortened to two steps, the marker goes: there is nowhere to put it");

// And a step going away under the marker takes it with it.
await ops({ op: "update_mech", mechId: beat, patch: { boom: steps[3], freeze: steps[2] } });
await ops({ op: "delete_step", stepId: steps[2] });
doc = await load();
if (doc.mechs[0].freeze !== "")
  fail("deleting the step the marker sat in left it pointing at nothing: " + doc.mechs[0].freeze);
else console.log("deleting the step it sat in clears the marker");

console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
await browser.close();
