/**
 * Mechanics aimed at players. A model adds them through the MCP tools and
 * reads them back; on the canvas a beam dropped on a tether rides it out of the
 * boss, a beam swings with the player it is on and reaches the wall, a bait
 * nudged off its target keeps the nudge, a bait follows its target while the
 * target is still in the hand, an autobait re-picks who it hits as the party
 * moves, and Unbind leaves a shape where it was drawn.
 */
import { angleOff, bearing, drag, drawn, fail, finish, floor, konvaNode, mcpClient, session } from "./harness.mjs";

const s = await session("baits-e2e");
const { page } = s;
const plan = await s.createPlan({ name: "baits e2e", withParty: true });
let doc = await plan.load();
const step = doc.steps[0].id;
const ids = Object.fromEntries(doc.entities.filter((e) => e.name).map((e) => [e.name, e.id]));
const boss = { x: 0, y: 0 };
// Everybody on a spot of their own, so every gesture below lands on what it aims at.
const spots = {
  MT: [-300, 250],
  OT: [350, -250],
  H1: [-350, -250],
  H2: [-420, 420],
  M1: [380, 380],
  M2: [100, 440],
  R1: [420, 100],
  R2: [-420, 60],
};
await plan.ops([
  { op: "add_entity", spec: { id: "enemy_boss", type: "enemy", name: "boss", ...boss, size: 140 } },
  ...Object.entries(spots).map(([name, [x, y]]) => ({ op: "update_entity", id: ids[name], patch: { x, y } })),
  { op: "add_mech", id: "mech_tether", name: "Tether", snap: step, plain: true },
  {
    op: "add_entity",
    spec: { id: "tether_ot", type: "tether", from: "enemy_boss", to: ids.OT, mech: "mech_tether", declaredIn: step },
  },
]);

const call = await mcpClient(s, "e2e-baits");
await call("add_bait", { plan_id: plan.id, kind: "beam", on: "MT, M1", from: "boss", name: "Beam" });
await call("add_bait", { plan_id: plan.id, kind: "donut", on: "H1", name: "Donut" });
const described = await call("read_plan", { plan_id: plan.id });
if (!/"Beam MT" aimed from boss at MT, to the wall/.test(described)) fail("read_plan does not describe the beam:\n" + described);
if (!/"Donut H1" on H1/.test(described)) fail("read_plan does not describe the donut:\n" + described);
console.log("add_bait put beams on MT and M1 and a donut on H1, and read_plan reads them back");

await s.openPlan(plan.id);
const f = await floor(page);
/** A named shape as the canvas draws it in the first step. */
const shape = async (name) => {
  const e = (await drawn(page, plan.id)).find((x) => x.name === name);
  if (!e) fail(`nothing called ${name} is on the floor`);
  return { ...e, x: Math.round(e.x), y: Math.round(e.y), rotation: Math.round(e.rotation), length: Math.round(e.length ?? 0) };
};

/* --- a beam dropped on a tether rides it out of the boss --------------------- */

await f.drop("Beam", 175, -125, { deselect: false });
doc = await plan.load();
const rider = doc.entities.find((e) => e.type === "zone" && e.anchor?.along === "tether_ot");
if (!rider) fail("a beam dropped on the tether does not ride it");
if (rider.mech !== "mech_tether") fail(`the rider went into Beat ${rider.mech}, not its tether's`);
if (!(await page.locator("text=along tether").count())) fail("the inspector does not say the beam rides a tether");
let aim = (await konvaNode(page, rider.id))?.rotation;
if (aim == null || angleOff(aim, bearing(boss, { x: 350, y: -250 })) > 3)
  fail(`the rider is drawn at ${aim}deg, not out of the boss through OT`);
await plan.ops({ op: "update_entity", id: "tether_ot", patch: { to: ids.R1 } });
await page.waitForTimeout(700);
aim = (await konvaNode(page, rider.id))?.rotation;
if (aim == null || angleOff(aim, bearing(boss, { x: 420, y: 100 })) > 3)
  fail(`after the tether was re-paired to R1 its beam is drawn at ${aim}deg`);
console.log(`a beam dropped on the tether rides it out of the boss, and swung round to R1 with it (${aim}deg)`);
await f.deselect();

/* --- a beam swings with the player it is on, and reaches the wall ---------- */

const beamBefore = await shape("Beam MT");
await drag(page, f.screen(-300, 250), f.screen(-350, 350), { steps: 20 });
const mt = await shape("MT");
if (Math.hypot(mt.x + 350, mt.y - 350) > 30) fail(`the drag did not move MT: they are at ${mt.x},${mt.y}`);
const beam = await shape("Beam MT");
if (beam.rotation === beamBefore.rotation) fail("the beam on MT never swung");
if (angleOff(beam.rotation, bearing(boss, mt)) > 6)
  fail(`the beam is at ${beam.rotation}deg, not through MT at ~${Math.round(bearing(boss, mt))}`);
if (beam.length < 400) fail(`the beam stops short of the wall: length ${beam.length}`);
console.log(`dragging MT swung their beam ${beamBefore.rotation} -> ${beam.rotation}deg, still reaching the wall`);

/* --- a bait nudged off its target keeps the nudge as they walk ------------- */

const donut = await shape("Donut H1");
const ring = (donut.radius + donut.innerRadius) / 2;
// Grab the ring north of H1, where nothing else is drawn, and pull it south.
await drag(page, f.screen(donut.x, donut.y - ring), f.screen(donut.x, donut.y - ring + 160), { steps: 20 });
const nudged = await shape("Donut H1");
const offset = { x: nudged.x - donut.x, y: nudged.y - donut.y };
if (Math.abs(offset.y - 160) > 25 || Math.abs(offset.x) > 25) fail(`dragging the donut moved it by ${offset.x},${offset.y}`);
if (!(await plan.load()).entities.find((e) => e.name === "Donut H1").anchor) fail("dragging the donut unbound it from H1");
await plan.ops({ op: "update_entity", id: ids.H1, patch: { x: -250, y: -380 } });
const h1 = await shape("H1");
const walked = await shape("Donut H1");
if (Math.abs(walked.x - h1.x - offset.x) > 3 || Math.abs(walked.y - h1.y - offset.y) > 3)
  fail(`the donut lost its nudge when H1 walked: ${walked.x - h1.x},${walked.y - h1.y}`);
console.log(`the donut nudged ${offset.x},${offset.y} off H1 kept that offset when H1 walked`);

/* --- a bait follows its target while the target is still in the hand ------- */

// Held with Alt: this exact free-hand spot is the point, and Alt is the radial snap's escape hatch.
const dropAt = { x: 30, y: -60 };
const before = await konvaNode(page, walked.id);
await page.keyboard.down("Alt");
await page.mouse.move(...Object.values(f.screen(h1.x, h1.y)));
await page.mouse.down();
await page.mouse.move(...Object.values(f.screen(dropAt.x, dropAt.y)), { steps: 25 });
await page.waitForTimeout(250);
const mid = await konvaNode(page, walked.id);
const server = await shape("H1");
if (Math.hypot(server.x - h1.x, server.y - h1.y) > 1) fail("the drag committed before the mouse came up, so this proves nothing");
if (Math.hypot(mid.x - before.x - (dropAt.x - h1.x), mid.y - before.y - (dropAt.y - h1.y)) > 20)
  fail(`mid-drag the donut is at ${mid.x},${mid.y}: it did not follow H1`);
await page.mouse.up();
await page.keyboard.up("Alt");
await page.waitForTimeout(700);
const dropped = await shape("H1");
if (Math.hypot(dropped.x - dropAt.x, dropped.y - dropAt.y) > 25) fail(`the drop did not commit: H1 is at ${dropped.x},${dropped.y}`);
const settled = await konvaNode(page, walked.id);
if (Math.hypot(settled.x - mid.x, settled.y - mid.y) > 5) fail("the donut jumped between the drop and the commit");
console.log("mid-drag the donut was already on H1's new spot while the server still had the old one");

/* --- an autobait picks by rule, and re-picks as the party moves ------------- */

await call("add_bait", { plan_id: plan.id, kind: "beam", pick: "closest", from: "boss", name: "Auto" });
let auto = await shape("Auto");
if (angleOff(auto.rotation, bearing(boss, dropped)) > 6) fail(`the autobait is at ${auto.rotation}deg, not on H1, the closest`);
await plan.ops({ op: "update_entity", id: ids.R2, patch: { x: -20, y: 0 } });
auto = await shape("Auto");
if (angleOff(auto.rotation, bearing(boss, { x: -20, y: 0 })) > 6)
  fail(`R2 walked in closest and the autobait stayed at ${auto.rotation}deg`);
console.log(`an autobait on the closest took H1, then R2 when they walked in closer (${auto.rotation}deg)`);

/* --- Unbind leaves the donut where it was drawn ----------------------------- */

const shown = await shape("Donut H1");
await f.click(shown.x, shown.y + ring);
const unbind = page.getByRole("button", { name: /Unbind from H1/ });
if (!(await unbind.count())) fail("selecting the donut offers no Unbind button");
await unbind.click();
await page.waitForTimeout(700);
if ((await plan.load()).entities.find((e) => e.id === shown.id).anchor) fail("Unbind left the donut anchored");
await plan.ops({ op: "update_entity", id: ids.H1, patch: { x: 300, y: -300 }, stepId: step });
const stayed = (await drawn(page, plan.id)).find((e) => e.id === shown.id);
if (Math.hypot(stayed.x - shown.x, stayed.y - shown.y) > 2)
  fail(`the unbound donut moved to ${Math.round(stayed.x)},${Math.round(stayed.y)} when H1 walked off`);
console.log("Unbind dropped the rule, and the donut stayed put when H1 walked off");

await finish(s, "OK - " + plan.url);
