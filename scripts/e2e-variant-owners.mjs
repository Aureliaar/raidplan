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
const stolen = await sam.ops(planId, { op: "gate_mech", mechId: cast, variant: sams.id });
const scrapped = await sam.ops(planId, { op: "delete_mech", mechId: cast });
if (stolen.status !== 403) fail("Sam took a cast out of Kate's reading: " + stolen.status);
else if (scrapped.status !== 403) fail("Sam deleted a cast of Kate's: " + scrapped.status);
else console.log("a cast that only goes off in her reading is hers as well");

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
