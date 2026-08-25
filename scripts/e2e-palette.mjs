/**
 * The palette: things you drag, whose meaning depends on where you let go.
 * Bare floor makes a shape you own; an enemy source makes a mechanic thrown
 * at whoever stands nearest it; the group chips give everybody one.
 *
 *   node scripts/e2e-palette.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=palette-e2e");
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
  body: JSON.stringify({ name: "palette e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

const canvas = page.locator("canvas").first();
const chip = (label) => page.locator("div", { hasText: new RegExp("^" + label + "$") }).last();

/** Arena units -> a position inside the canvas box, for dragTo. */
async function at(x, y) {
  const box = await canvas.boundingBox();
  const scale = box.width / 1000;
  return { x: box.width / 2 + x * scale, y: box.height / 2 + y * scale };
}

/** Drag a palette item onto a point of the arena. */
async function dropOnFloor(label, x, y) {
  await chip(label).dragTo(canvas, { targetPosition: await at(x, y) });
  await page.waitForTimeout(500);
}

/* --- an anchor lands where you dropped it --------------------------------- */

await dropOnFloor("Bait anchor", 200, -150);
let doc = await load();
const anchor = doc.entities.find((e) => e.type === "enemy" && e.role === "anchor");
if (!anchor) fail("dragging the bait anchor onto the floor placed nothing");
else if (Math.hypot(anchor.x - 200, anchor.y + 150) > 25)
  fail("the anchor landed at " + anchor.x + "," + anchor.y + " instead of 200,-150");
else console.log("bait anchor placed where it was dropped: " + anchor.x + "," + anchor.y);

/* --- a beam dropped ON the anchor is baited off it ------------------------- */

// Somebody has to be nearest: put M1 next to the anchor and everyone else far.
const ids = Object.fromEntries(doc.entities.filter((e) => e.name).map((e) => [e.name, e.id]));
await api("/api/plans/" + planId + "/ops", {
  method: "POST",
  body: JSON.stringify({
    ops: [
      { op: "update_entity", id: ids.M1, patch: { x: 300, y: -150 } },
      { op: "update_entity", id: ids.M2, patch: { x: 320, y: 400 } },
      { op: "update_entity", id: ids.MT, patch: { x: -400, y: 400 } },
    ],
  }),
});
await page.waitForTimeout(400);

await dropOnFloor("Beam", 200, -150);
doc = await load();
let beams = doc.entities.filter((e) => e.type === "zone" && e.shape === "rect" && e.anchor);
if (beams.length !== 1) fail("dropping a beam on the anchor made " + beams.length + " baits");
else if (beams[0].anchor.from !== anchor.id)
  fail("the beam is not fired from the anchor: " + JSON.stringify(beams[0].anchor));
else if (beams[0].anchor.pick !== "closest" || beams[0].anchor.rank !== 1)
  fail("the beam is not aimed at the closest player: " + JSON.stringify(beams[0].anchor));
else console.log("beam dropped on the anchor: " + beams[0].name + " " + JSON.stringify(beams[0].anchor));

// A second one of the same kind on the same anchor takes the second closest.
await dropOnFloor("Beam", 200, -150);
doc = await load();
beams = doc.entities.filter((e) => e.type === "zone" && e.shape === "rect" && e.anchor);
const ranks = beams.map((b) => b.anchor.rank).sort();
if (beams.length !== 2 || ranks.join() !== "1,2")
  fail("a second beam on the anchor should be rank 2, got ranks " + ranks.join());
else console.log("two beams on one anchor cover the two closest: ranks " + ranks.join());

// And they really do aim at different people.
const solved = await page.evaluate(
  ([id]) => {
    const stage = window.Konva.stages[0];
    const g = stage.findOne("#" + id);
    return g ? Math.round(g.rotation()) : null;
  },
  [beams.find((b) => b.anchor.rank === 1).id]
);
if (solved === null) fail("the rank-1 beam is not on the canvas");

/* --- a circle on the Supports chip gives each support one ----------------- */

await chip("Supports").dragTo(chip("Supports")); // no-op guard: chip must exist
const before = (await load()).entities.length;
await page.locator("div", { hasText: /^Circle$/ }).last().dragTo(chip("Supports"));
await page.waitForTimeout(700);
doc = await load();
const circles = doc.entities.filter((e) => e.type === "zone" && e.shape === "circle" && e.anchor);
const boundTo = circles.map((c) => doc.entities.find((e) => e.id === c.anchor.to)?.name).sort();
if (circles.length !== 4) fail("Supports should have taken 4 circles, got " + circles.length);
else if (boundTo.join() !== "H1,H2,MT,OT")
  fail("the circles went to " + boundTo.join() + " instead of the four supports");
else console.log("a circle on Supports bound one to each: " + boundTo.join());
if (doc.entities.length !== before + 4) fail("Supports added " + (doc.entities.length - before) + " entities");

/* --- a stack on Healers goes to the two healers, numbered ----------------- */

await page.locator("div", { hasText: /Stack ×8$/ }).last().dragTo(chip("Healers"));
await page.waitForTimeout(700);
doc = await load();
const stacks = doc.entities.filter((e) => e.type === "zone" && e.shape === "stack");
const stackOn = stacks.map((c) => doc.entities.find((e) => e.id === c.anchor.to)?.name).sort();
if (stacks.length !== 2) fail("Healers should have taken 2 stacks, got " + stacks.length);
else if (stackOn.join() !== "H1,H2") fail("the stacks went to " + stackOn.join());
else if (!stacks.every((s) => s.soak === 8)) fail("a Stack ×8 should want 8 people: " + stacks.map((s) => s.soak));
else console.log("a Stack ×8 on Healers put an 8-person stack on " + stackOn.join(" and "));

// A line stack is aimed: it comes out of the boss like a beam does.
await page.locator("div", { hasText: /^Line stack$/ }).last().dragTo(chip("Tanks"));
await page.waitForTimeout(700);
doc = await load();
const lines = doc.entities.filter((e) => e.type === "zone" && e.shape === "linestack");
const source = doc.entities.find((e) => e.id === lines[0]?.anchor?.from);
if (lines.length !== 2) fail("Tanks should have taken 2 line stacks, got " + lines.length);
else if (!source || !lines.every((l) => l.anchor.from === source.id))
  fail("the line stacks are not aimed from anything");
else console.log("a line stack on Tanks fires from " + source.name + " through each tank");

/* --- and what a shape is coloured says what kind of thing it is ------------ */

// Nobody has picked any colour: these are the defaults the canvas draws.
const painted = await page.evaluate(
  async ([id]) => {
    const d = await (await fetch("/api/plans/" + id)).json().then((p) => p.plan ?? p);
    const m = await import("/src/shared/schema.ts");
    const drawn = m.entitiesForStep(d, d.steps[0].id);
    const of = (pred) => [...new Set(drawn.filter(pred).map((e) => e.color))];
    return {
      families: m.ZONE_FAMILIES,
      stacks: of((e) => e.shape === "stack"),
      beams: of((e) => e.shape === "rect" && e.anchor),
      circles: of((e) => e.shape === "circle" && e.anchor),
    };
  },
  [planId]
);
// One drop is one shade; two separate drops of the same kind may differ, so
// long as both are of the family.
const family = (got, name) =>
  got.length && got.every((c) => painted.families[name].includes(c))
    ? true
    : (fail(name + " should be one of " + painted.families[name].join(",") + ", got " + got.join(",")), false);
if (family(painted.stacks, "stack")) console.log("a stack is yellow: " + painted.stacks[0]);
// The beams come off the bait anchor, and where a thing comes from beats what
// shape it is.
if (family(painted.beams, "bait")) console.log("a beam off the bait anchor is green: " + painted.beams.join(", "));
if (family(painted.circles, "cast")) console.log("a circle is red-orange: " + painted.circles[0]);

/* --- a protean on Party comes from the boss ------------------------------- */

await page.locator("div", { hasText: /^Protean$/ }).last().dragTo(chip("Party"));
await page.waitForTimeout(900);
doc = await load();
const cones = doc.entities.filter((e) => e.type === "zone" && e.shape === "cone" && e.anchor);
if (cones.length !== 8) fail("Party should have taken 8 proteans, got " + cones.length);
else if (new Set(cones.map((c) => c.anchor.to)).size !== 8)
  fail("the proteans are not one per player");
else if (!cones.every((c) => c.anchor.from))
  fail("proteans are thrown from somewhere: " + JSON.stringify(cones[0].anchor));
else console.log("a protean on Party gave all eight one, thrown from " + (doc.entities.find((e) => e.id === cones[0].anchor.from)?.name ?? "?"));

/* --- what a group holds is one object, not eight ------------------------- */

// A bonded shape is a face of the set, so the canvas must not let you drag it.
const ghost = circles[0];
const ghostAt = await page.evaluate(
  (id) => {
    const n = window.Konva.stages[0].findOne("#" + id);
    return n ? { x: Math.round(n.x()), y: Math.round(n.y()) } : null;
  },
  ghost.id
);
const cbox = await canvas.boundingBox();
const cscale = cbox.width / 1000;
const onScreen = (x, y) => ({ x: cbox.x + cbox.width / 2 + x * cscale, y: cbox.y + cbox.height / 2 + y * cscale });
const grab = onScreen(ghostAt.x, ghostAt.y);
await page.mouse.move(grab.x, grab.y);
await page.mouse.down();
await page.mouse.move(grab.x + 120, grab.y + 90, { steps: 15 });
await page.mouse.up();
await page.waitForTimeout(600);
doc = await load();
const stillThere = doc.entities.find((e) => e.id === ghost.id);
if (stillThere.x !== ghost.x || stillThere.y !== ghost.y || stillThere.overrides?.[doc.steps[0].id])
  fail("a bonded circle moved when dragged: " + stillThere.x + "," + stillThere.y);
else console.log("a shape owned by a group cannot be dragged out of it");

// And the group's own row is what takes the whole set away.
await page.getByTitle("Remove this circle from the supports").click();
await page.waitForTimeout(700);
doc = await load();
const left = doc.entities.filter((e) => e.bond && e.bond.group === "supports");
if (left.length) fail("removing the set from the Supports row left " + left.length + " behind");
else console.log("the Supports row removed all four at once");

/* --- a tether dropped on one player is finished by clicking another ------ */

const [m2Point, h1Point] = await page.evaluate(
  (playerIds) => playerIds.map((id) => window.Konva.stages[0].findOne("#" + id).getAbsolutePosition()),
  [ids.M2, ids.H1]
);
await page.locator("div", { hasText: /^Together tether$/ }).last().dragTo(canvas, { targetPosition: m2Point });
await page.getByText(/Click the player for the other end/).waitFor();
const tetherCanvasBox = await canvas.boundingBox();
// Hold the mutation response long enough to prove the line does not depend on
// the Worker round trip. It should be painted from the client-ID operation.
await page.route("**/api/plans/*/ops", async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await route.continue();
}, { times: 1 });
const tetherSaved = page.waitForResponse(
  (response) => response.url().includes("/ops") && response.request().method() === "POST"
);
await page.mouse.click(tetherCanvasBox.x + h1Point.x, tetherCanvasBox.y + h1Point.y);
await page.waitForFunction(
  () => window.Konva.stages[0].find(".entity").some((node) => node.id().startsWith("tether_")),
  undefined,
  { timeout: 400 }
).catch(() => fail("the tether waited for its delayed mutation response before appearing"));
await tetherSaved;
await page.waitForTimeout(200);
doc = await load();
const directTether = doc.entities.find(
  (e) => e.type === "tether" && !e.bond && e.from === ids.M2 && e.to === ids.H1 && e.style === "close"
);
if (!directTether) fail("dropping a tether on M2 then clicking H1 did not create M2-H1");
else console.log("a tether dropped on M2 binds to H1 on the next click");

// Keep the later four-link set assertions independent of this one-off link.
if (directTether) {
  await api("/api/plans/" + planId + "/ops", {
    method: "POST",
    body: JSON.stringify({ ops: [{ op: "delete_entities", ids: [directTether.id] }] }),
  });
  await page.waitForTimeout(400);
}

/* --- player tethers pair supports to damagers and report their range ------ */

await page.locator("div", { hasText: /^Together tether$/ }).last().dragTo(chip("Supports"));
await page.waitForTimeout(700);
doc = await load();
let tethers = doc.entities.filter((e) => e.type === "tether" && e.style === "close");
const tetherPairs = tethers.map((t) => {
  const from = doc.entities.find((e) => e.id === t.from)?.name;
  const to = doc.entities.find((e) => e.id === t.to)?.name;
  return `${from}-${to}`;
}).sort();
if (tethers.length !== 4) fail("Together tether should have made four links, got " + tethers.length);
else if (tetherPairs.join() !== "H1-R1,H2-R2,MT-M1,OT-M2")
  fail("Together tether made unexpected pairs: " + tetherPairs.join());
else if (!tethers.every((t) => t.range === 200 && t.bond?.id === tethers[0].bond?.id))
  fail("Together tethers did not share a 200-unit range and bond");
else console.log("Together tether paired supports to damagers: " + tetherPairs.join(", "));

// Put one pair inside and then outside its threshold. The persisted positions
// arrive through the live socket and the line itself should change status.
const mtTether = tethers.find((t) => doc.entities.find((e) => e.id === t.from)?.name === "MT");
const mt = doc.entities.find((e) => e.name === "MT");
const m1 = doc.entities.find((e) => e.name === "M1");
await api("/api/plans/" + planId + "/ops", {
  method: "POST",
  body: JSON.stringify({ ops: [
    { op: "update_entity", id: mt.id, patch: { x: 0, y: 0 }, stepId: doc.steps[0].id },
    { op: "update_entity", id: m1.id, patch: { x: 100, y: 0 }, stepId: doc.steps[0].id },
  ] }),
});
await page.waitForFunction(
  (id) => window.Konva.stages[0].findOne("#" + id)?.findOne(".tether-guide")?.stroke() === "#54d68b",
  mtTether.id,
  { timeout: 3000 }
).catch(() => {});
let tetherStroke = await page.evaluate((id) => window.Konva.stages[0].findOne("#" + id)?.findOne(".tether-guide")?.stroke(), mtTether.id);
if (tetherStroke !== "#54d68b") {
  const live = await load();
  const liveMt = live.entities.find((e) => e.id === mt.id);
  const liveM1 = live.entities.find((e) => e.id === m1.id);
  fail("satisfied Together tether was " + tetherStroke + " instead of green at " + JSON.stringify([liveMt, liveM1]));
}
else console.log("Together tether turns green inside its configured range");

await api("/api/plans/" + planId + "/ops", {
  method: "POST",
  body: JSON.stringify({ ops: [{ op: "update_entity", id: m1.id, patch: { x: 300, y: 0 }, stepId: doc.steps[0].id }] }),
});
await page.waitForTimeout(600);
tetherStroke = await page.evaluate((id) => window.Konva.stages[0].findOne("#" + id)?.findOne(".tether-guide")?.stroke(), mtTether.id);
if (tetherStroke !== "#f05b67") fail("failed Together tether was " + tetherStroke + " instead of red");
else console.log("Together tether turns red outside its configured range");

const chevrons = await page.evaluate(() => window.Konva.stages[0].find(".tether-chevron").length);
if (chevrons < 4) fail("directional tether chevrons were not drawn");
else console.log("directional tether chevrons are drawn on the links");
const tetherWeights = await page.evaluate((id) => ({
  line: window.Konva.stages[0].findOne("#" + id)?.findOne(".tether-guide")?.strokeWidth(),
  chevron: window.Konva.stages[0].findOne("#" + id)?.findOne(".tether-chevron")?.strokeWidth(),
}), mtTether.id);
if (!(tetherWeights.line < tetherWeights.chevron))
  fail("the tether guide should be quieter than its chevrons: " + JSON.stringify(tetherWeights));
else if (tetherWeights.chevron > mtTether.width / 2)
  fail("the tether chevrons should stay slim: " + JSON.stringify(tetherWeights));
else console.log("the thin tether guide leaves the chevrons visually dominant");

const shortChevrons = await page.evaluate(
  (id) => window.Konva.stages[0].findOne("#" + id)?.find(".tether-chevron").length ?? 0,
  mtTether.id
);
await api("/api/plans/" + planId + "/ops", {
  method: "POST",
  body: JSON.stringify({ ops: [{ op: "update_entity", id: m1.id, patch: { x: 450, y: 0 }, stepId: doc.steps[0].id }] }),
});
await page.waitForTimeout(600);
const longTether = await page.evaluate((id) => {
  const tether = window.Konva.stages[0].findOne("#" + id);
  return {
    chevrons: tether?.find(".tether-chevron").length ?? 0,
    guides: tether?.find(".tether-guide").map((line) => line.points()) ?? [],
  };
}, mtTether.id);
if (longTether.chevrons <= shortChevrons)
  fail("a longer tether did not gain chevrons: " + shortChevrons + " -> " + longTether.chevrons);
else if (longTether.guides.length !== 2 || !(longTether.guides[0][2] < longTether.guides[1][0]))
  fail("the guide was not cut away around the chevrons: " + JSON.stringify(longTether.guides));
else console.log("long tethers gain chevrons and the guide clears their field");
await api("/api/plans/" + planId + "/ops", {
  method: "POST",
  body: JSON.stringify({ ops: [{ op: "update_entity", id: m1.id, patch: { x: 300, y: 0 }, stepId: doc.steps[0].id }] }),
});
await page.waitForTimeout(600);

// The wheel changes the mechanic's required range, not the line's visual
// weight. Because these four links are bonded, one link updates all four.
const tetherProbe = onScreen(50, 0);
await page.mouse.move(tetherProbe.x, tetherProbe.y);
await page.mouse.wheel(0, -120);
await page.waitForTimeout(700);
doc = await load();
const wheelSet = doc.entities.filter((e) => e.type === "tether" && e.bond?.id === mtTether.bond?.id);
if (wheelSet.length !== 4 || !wheelSet.every((t) => t.range === 216))
  fail("scrolling a tether did not update the set's required range: " + wheelSet.map((t) => t.range).join());
else if (!wheelSet.every((t) => t.width === 8))
  fail("scrolling a tether changed its visual width: " + wheelSet.map((t) => t.width).join());
else console.log("scrolling a tether changes required range, not visual width");

// A bonded tether stays selectable (it cannot be dragged), and editing its
// threshold updates the whole four-link set.
const rangeSelect = page.locator("div.label", { hasText: /^required range$/ }).locator("xpath=..").locator("select");
for (const x of [50, 75, 100, 125, 175, 200, 225, 250]) {
  const point = onScreen(x, 0);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(100);
  if (await rangeSelect.count()) break;
}
if (!(await rangeSelect.count())) fail("selecting a bonded tether did not expose its range dropdown");
else {
  await rangeSelect.selectOption("250");
  await page.waitForTimeout(700);
  doc = await load();
  const closeSet = doc.entities.filter((e) => e.type === "tether" && e.bond?.id === mtTether.bond?.id);
  if (closeSet.length !== 4 || !closeSet.every((t) => t.range === 250))
    fail("range dropdown did not update the whole tether set");
  else console.log("the range dropdown updates all four links in the tether set");

  // An individual link can use arbitrary players, and the ordinary step/all
  // scope controls whether that pairing is temporary or structural.
  const nameInput = page.locator("div.label", { hasText: /^name$/ }).locator("xpath=..").locator("input");
  const selectedName = await nameInput.inputValue();
  const selectedLink = doc.entities.find((e) => e.type === "tether" && e.name === selectedName);
  const fromSelect = page.locator("div.label", { hasText: /^from player$/ }).locator("xpath=..").locator("select");
  const toSelect = page.locator("div.label", { hasText: /^to player$/ }).locator("xpath=..").locator("select");
  await fromSelect.selectOption(ids.M2);
  await toSelect.selectOption(ids.H1);
  await page.waitForTimeout(700);
  doc = await load();
  const retargeted = doc.entities.find((e) => e.id === selectedLink?.id);
  const stepPair = retargeted?.overrides?.[doc.steps[0].id];
  if (!retargeted || retargeted.from === ids.M2 || retargeted.to === ids.H1)
    fail("step-scoped tether retarget changed the base pairing");
  else if (stepPair?.from !== ids.M2 || stepPair?.to !== ids.H1)
    fail("tether did not retarget to arbitrary players in this step: " + JSON.stringify(stepPair));
  else console.log("an individual tether retargets to arbitrary players in the current step");
}

await page.locator("div", { hasText: /^Go-far tether$/ }).last().dragTo(chip("Damagers"));
await page.waitForTimeout(700);
doc = await load();
tethers = doc.entities.filter((e) => e.type === "tether" && e.style === "far");
if (tethers.length !== 4 || !tethers.every((t) => t.range === 200))
  fail("Go-far tether on Damagers did not make four ranged links");
else console.log("Go-far tether works from the Damagers card too");

/* --- bare floor makes a shape of your own --------------------------------- */

await dropOnFloor("Circle", -300, 300);
doc = await load();
const free = doc.entities.find(
  (e) => e.type === "zone" && e.shape === "circle" && !e.anchor && Math.hypot(e.x + 300, e.y - 300) < 25
);
if (!free) fail("a circle dropped on bare floor did not land there unbound");
else console.log("a circle on bare floor is yours to move: " + free.x + "," + free.y);

/* --- bosses and adds are enemy sources, not reticle anchors --------------- */

await dropOnFloor("Boss", -300, -300);
await dropOnFloor("Add", 300, 300);
doc = await load();
const boss = doc.entities.find((e) => e.name === "boss 1");
const add = doc.entities.find((e) => e.name === "add 1");
if (!boss || boss.type !== "enemy" || boss.role === "anchor" || boss.icon !== "actor/boss")
  fail("Boss did not create a large, ordinary enemy: " + JSON.stringify(boss));
if (!add || add.type !== "enemy" || add.role === "anchor" || add.icon !== "actor/enemy")
  fail("Add did not create a medium, ordinary enemy: " + JSON.stringify(add));

await dropOnFloor("Beam", -300, -300);
await dropOnFloor("Beam", 300, 300);
doc = await load();
const sourced = doc.entities.filter(
  (e) => e.type === "zone" && e.shape === "rect" && (e.anchor?.from === boss?.id || e.anchor?.from === add?.id)
);
if (sourced.length !== 2)
  fail("Boss and Add did not accept mechanics as sources: " + JSON.stringify(sourced.map((e) => e.anchor)));
else console.log("Boss and Add are droppable mechanic sources without becoming bait anchors");

console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
await browser.close();
