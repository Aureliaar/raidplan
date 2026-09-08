/** Shift-click and marquee select several entities; a drag carries the set. */
import { chromium } from "playwright";
import { viewScale } from "./view.mjs";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1900, height: 1000 } })).newPage();
const fail = (message) => {
  console.error("FAIL:", message);
  process.exitCode = 1;
};

await page.goto(`${base}/auth/dev?name=multiselect-e2e`);
const api = (path, init = {}) =>
  page.evaluate(
    async ([url, options]) => {
      const response = await fetch(url, {
        ...options,
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`${url} -> ${response.status} ${body.slice(0, 300)}`);
      return body ? JSON.parse(body) : null;
    },
    [path, init]
  );
const created = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "multiselect e2e", withParty: false }),
});
const id = (created.plan ?? created).id;
await api(`/api/plans/${id}/ops`, {
  method: "POST",
  body: JSON.stringify({
    ops: [
      { op: "add_entity", spec: { type: "enemy", name: "left", x: -180, y: -80 } },
      { op: "add_entity", spec: { type: "enemy", name: "right", x: 160, y: -60 } },
      { op: "add_entity", spec: { type: "enemy", name: "low", x: 0, y: 190 } },
    ],
  }),
});
await page.goto(`${base}/p/${id}`);
await page.waitForSelector("canvas");
await page.waitForTimeout(700);

const canvas = page.locator("canvas").first();
const box = await canvas.boundingBox();
const scale = viewScale(box.width);
const at = (x, y) => ({ x: box.x + box.width / 2 + x * scale, y: box.y + box.height / 2 + y * scale });
const plan = (await api(`/api/plans/${id}`)).plan;
// Drags land as a declaration in the step you are on, so read the step's pose.
const stepId = plan.steps[0].id;
const pose = (entity) => ({ ...entity, ...(entity.overrides?.[stepId] ?? {}) });
const at_ = (list, name) => pose(list.find((e) => e.name === name));
const left = plan.entities.find((e) => e.name === "left");
const right = plan.entities.find((e) => e.name === "right");

await page.mouse.click(at(left.x, left.y).x, at(left.x, left.y).y);
await page.keyboard.down("Shift");
await page.mouse.click(at(right.x, right.y).x, at(right.x, right.y).y);
await page.keyboard.up("Shift");
let state = await page.evaluate(() => ({
  selected: window.Konva.stages[0].find(".selection").length,
  axis: window.Konva.stages[0].find(".transform-axis").length,
}));
if (state.selected !== 2 || state.axis !== 1) fail(`shift selection state ${JSON.stringify(state)}`);
else console.log("Shift-click adds to the selection and reveals its axis");

const from = at(left.x, left.y);
const to = at(left.x + 70, left.y + 45);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(600);
const moved = (await api(`/api/plans/${id}`)).plan.entities;
const movedLeft = at_(moved, "left");
const movedRight = at_(moved, "right");
const low = at_(moved, "low");
if (Math.hypot(movedLeft.x - (left.x + 70), movedLeft.y - (left.y + 45)) > 8)
  fail(`dragged member moved to ${movedLeft.x},${movedLeft.y}`);
if (Math.hypot(movedRight.x - (right.x + 70), movedRight.y - (right.y + 45)) > 8)
  fail(`second member did not translate flat: ${movedRight.x},${movedRight.y}`);
if (low.x !== 0 || low.y !== 190) fail(`unselected member moved to ${low.x},${low.y}`);
else console.log("dragging either selected item translates the ad-hoc selection together");

// Rotate mode is a rigid orbit around the arena centre, even with symmetry Off.
await page.keyboard.press("q");
const orbitFrom = at(movedLeft.x, movedLeft.y);
const orbitTo = at(-movedLeft.y, movedLeft.x);
await page.mouse.move(orbitFrom.x, orbitFrom.y);
await page.mouse.down();
await page.mouse.move(orbitTo.x, orbitTo.y, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(600);
const orbited = (await api(`/api/plans/${id}`)).plan.entities;
const orbitLeft = at_(orbited, "left");
const orbitRight = at_(orbited, "right");
if (Math.hypot(orbitLeft.x + movedLeft.y, orbitLeft.y - movedLeft.x) > 8)
  fail(`rotate mode translated the grabbed member to ${orbitLeft.x},${orbitLeft.y}`);
if (Math.hypot(orbitRight.x + movedRight.y, orbitRight.y - movedRight.x) > 8)
  fail(`rotate mode did not orbit the second member: ${orbitRight.x},${orbitRight.y}`);
else console.log("Rotate mode orbits the whole selection rigidly around arena centre");

// Radial pointer movement is part of the same polar transform; the guide is
// informative, not a radius constraint.
const radialFrom = at(orbitLeft.x, orbitLeft.y);
const radialTo = at(orbitLeft.x * 1.5, orbitLeft.y * 1.5);
await page.mouse.move(radialFrom.x, radialFrom.y);
await page.mouse.down();
await page.mouse.move(radialTo.x, radialTo.y, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(600);
const scaled = (await api(`/api/plans/${id}`)).plan.entities;
const scaledLeft = at_(scaled, "left");
const scaledRight = at_(scaled, "right");
if (Math.hypot(scaledLeft.x - orbitLeft.x * 1.5, scaledLeft.y - orbitLeft.y * 1.5) > 8)
  fail(`radial adjustment snapped back to ${scaledLeft.x},${scaledLeft.y}`);
if (Math.hypot(scaledRight.x - orbitRight.x * 1.5, scaledRight.y - orbitRight.y * 1.5) > 8)
  fail(`radial adjustment did not scale the group: ${scaledRight.x},${scaledRight.y}`);
else console.log("Rotate mode keeps radial adjustments and scales the selection from centre");
await page.keyboard.press("q");

// Start and finish on empty floor around all three objects.
const cornerA = at(-310, -220);
const cornerB = at(300, 400);
await page.mouse.move(cornerA.x, cornerA.y);
await page.mouse.down();
await page.mouse.move(cornerB.x, cornerB.y, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(100);
state = await page.evaluate(() => ({
  selected: window.Konva.stages[0].find(".selection").length,
  axis: window.Konva.stages[0].find(".transform-axis").length,
}));
if (state.selected !== 3 || state.axis !== 1) fail(`marquee selection state ${JSON.stringify(state)}`);
else console.log("drag-box replaces the selection and keeps the axis visible");

/* --- a selection carries only what can move ------------------------------- */
// A tether has no pose of its own and a bait rides whoever it is aimed at, so
// sweeping either into a selection must leave it exactly as authored: nudging
// the bait here would stack on the movement it already inherits from its
// target, and the spread would end up twice as far as the player it marks.
const clearedIds = (await api(`/api/plans/${id}`)).plan.entities.map((e) => e.id);
await api(`/api/plans/${id}/ops`, {
  method: "POST",
  body: JSON.stringify({
    ops: [
      { op: "delete_entities", ids: clearedIds },
      { op: "add_entity", spec: { type: "player", name: "A", x: -120, y: 300 } },
      { op: "add_entity", spec: { type: "player", name: "B", x: 120, y: 300 } },
    ],
  }),
});
const withParty = (await api(`/api/plans/${id}`)).plan.entities;
const aId = withParty.find((e) => e.name === "A").id;
const bId = withParty.find((e) => e.name === "B").id;
await api(`/api/plans/${id}/ops`, {
  method: "POST",
  body: JSON.stringify({
    ops: [
      {
        op: "add_entity",
        spec: {
          type: "zone",
          shape: "spread",
          name: "spread A",
          radius: 90,
          x: 0,
          y: 0,
          anchor: { to: aId },
        },
      },
      { op: "add_entity", spec: { type: "tether", name: "A-B", from: aId, to: bId } },
    ],
  }),
});
await page.reload();
await page.waitForSelector("canvas");
await page.waitForTimeout(700);

// A marquee over the pair sweeps up the spread and the tether with them.
const partyA = at(-330, 190);
const partyB = at(330, 400);
await page.mouse.move(partyA.x, partyA.y);
await page.mouse.down();
await page.mouse.move(partyB.x, partyB.y, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(100);
// Three rings for the two players and the spread; a tether shows its selection
// by thickening its own line rather than by wearing a ring.
const swept = await page.evaluate(() => window.Konva.stages[0].find(".selection").length);
if (swept !== 3) fail(`marquee over the party ringed ${swept} things, expected 3`);

const grabA = at(-120, 300);
const dropA = at(-120 + 90, 300 - 60);
await page.mouse.move(grabA.x, grabA.y);
await page.mouse.down();
await page.mouse.move(dropA.x, dropA.y, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(700);
const carried = (await api(`/api/plans/${id}`)).plan.entities;
const aAfter = at_(carried, "A");
const bAfter = at_(carried, "B");
const spreadAfter = at_(carried, "spread A");
const tetherAfter = at_(carried, "A-B");
if (Math.hypot(aAfter.x - -30, aAfter.y - 240) > 8)
  fail(`grabbed player landed at ${aAfter.x},${aAfter.y}`);
if (Math.hypot(bAfter.x - 210, bAfter.y - 240) > 8)
  fail(`the other player did not come along: ${bAfter.x},${bAfter.y}`);
if (spreadAfter.x !== 0 || spreadAfter.y !== 0)
  fail(`the bait took a nudge on top of its target: ${spreadAfter.x},${spreadAfter.y}`);
if (!spreadAfter.anchor || spreadAfter.anchor.to !== aId) fail("the bait lost its anchor");
if (tetherAfter.x !== 0 || tetherAfter.y !== 0)
  fail(`the tether was moved to ${tetherAfter.x},${tetherAfter.y}`);
else console.log("a selection holding a bait and a tether moves only the movable members");

await browser.close();
if (!process.exitCode) console.log("OK - multi-selection gestures and shared movement");
