/**
 * The chips stand down while the floor moves — a step walk, or a token in the
 * hand. The leaders are cut at once, the plates hold the positions they already
 * had rather than reflowing after the party, and the canvas they have to
 * themselves is left alone for the rest of it. They come back on their own once
 * things settle.
 *
 *   node scripts/e2e-chips-quiet.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=chips-quiet-e2e");
const api = (path, init = {}) =>
  page.evaluate(
    async ([p, i]) => {
      const r = await fetch(p, {
        ...i,
        headers: { "content-type": "application/json", ...(i.headers ?? {}) },
      });
      const t = await r.text();
      if (!r.ok) throw new Error(p + " -> " + r.status + " " + t.slice(0, 200));
      return t ? JSON.parse(t) : null;
    },
    [path, init]
  );

const created = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "chips quiet e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);
const ops = (o) =>
  api("/api/plans/" + planId + "/ops", { method: "POST", body: JSON.stringify({ ops: [].concat(o) }) });

await ops({ op: "add_step", name: "Two" });
let doc = await load();
const [one, two] = doc.steps.map((s) => s.id);
// The party walks a long way between the steps, so a chip that followed them
// would visibly move rather than hold still.
await ops(
  doc.entities
    .filter((e) => e.type === "player")
    .flatMap((p, i) => [
      { op: "update_entity", id: p.id, patch: { x: -380 + i * 20, y: -300 }, stepId: one },
      { op: "update_entity", id: p.id, patch: { x: 380 - i * 20, y: 300 }, stepId: two },
    ])
);

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(1200);
// V puts a chip in the margin for every party member.
await page.keyboard.press("v");
await page.waitForTimeout(600);

/**
 * Count every redraw of the chips' own canvas from here on. The point of giving
 * them one is that a walk costs it nothing, so "how many times was it drawn" is
 * the assertion that actually means something.
 */
await page.evaluate(() => {
  const layer = window.Konva.stages[0].findOne(".chips").getLayer();
  window.__chipsLayer = layer;
  layer.__draws = 0;
  const drawScene = layer.drawScene.bind(layer);
  layer.drawScene = (...args) => {
    layer.__draws++;
    return drawScene(...args);
  };
});
const marker = () => page.evaluate(() => window.__chipsLayer.__draws);

/** What the readout looks like right now. */
const readout = () =>
  page.evaluate(() => {
    const stage = window.Konva.stages[0];
    const chips = stage.find(".chip");
    const group = stage.findOne(".chips");
    const canvas = window.__chipsLayer.getNativeCanvasElement();
    return {
      chips: chips.length,
      // A leader per chip, in the group that gets cut.
      leaders: group ? group.getChildren()[0]?.isVisible() === true : false,
      // The fade lives on the canvas element, not on any Konva node.
      opacity: Number(canvas.style.opacity === "" ? 1 : canvas.style.opacity),
      draws: window.__chipsLayer.__draws,
      // Which chip sits where, so "did the margin relay itself" is answerable
      // per chip rather than by a set of heights that can coincide.
      at: Object.fromEntries(chips.map((c) => [c.getAttr("entityId"), Math.round(c.y())])),
    };
  });
const sameLayout = (a, b) => JSON.stringify(a.at) === JSON.stringify(b.at);

const still = await readout();
if (still.chips !== 8) fail(`expected a chip per party member, got ${still.chips}`);
if (!still.leaders) fail("the leaders should be drawn on a still floor");
console.log(`still: ${still.chips} chips, leaders drawn`);

// Walk into the next step and look while it is still walking.
const drawnBefore = await marker();
await page.keyboard.press("s");
await page.waitForTimeout(60);
const during = await readout();
if (during.leaders) fail("the leaders should be cut the moment the floor moves");
if (during.chips !== still.chips)
  fail(`the plates should hold, not be rebuilt: ${still.chips} -> ${during.chips}`);
if (!sameLayout(during, still)) fail("the plates should hold the positions they had");
if (!(during.opacity < 1)) fail(`the plates should be fading, opacity was ${during.opacity}`);
console.log(`walking: leaders cut, ${during.chips} plates held at their old heights, fading`);

// And the walk costs their canvas one redraw — the one that cut the leaders —
// however many frames the floor itself takes.
await page.waitForTimeout(250);
const after = await readout();
if (after.opacity !== 0) fail(`the chips should have faded out by mid-walk, at ${after.opacity}`);
const drew = after.draws - drawnBefore;
if (drew > 1) fail(`the chips' canvas should be left alone during a walk, drew ${drew} times`);
console.log(`mid-walk: readout invisible, its canvas drawn ${drew}x for the whole walk`);

// And back on their own once things settle.
await page.waitForTimeout(900);
const back = await readout();
if (back.chips !== 8) fail(`the chips should come back, got ${back.chips}`);
if (!back.leaders) fail("the leaders should be drawn again");
if (back.opacity !== 1) fail(`the chips should have faded all the way in, at ${back.opacity}`);
if (sameLayout(back, still))
  fail("the chips should be laid out for where the party is now, not where it was");
console.log("settled: chips back at full, laid out for the step they walked into");

// A chip is still a click target for the thing it names, canvas of its own or
// not: Konva hears the pointer on the container and hit-tests every layer.
const chipSpots = await page.evaluate(() =>
  window.Konva.stages[0]
    .find(".chip")
    .slice(0, 2)
    .map((chip) => {
      const box = chip.getClientRect();
      return { id: chip.getAttr("entityId"), x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })
);
const canvasBox = await page.locator("canvas").first().boundingBox();
const clickChip = async (spot, shift) => {
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.click(canvasBox.x + spot.x, canvasBox.y + spot.y);
  if (shift) await page.keyboard.up("Shift");
  await page.waitForTimeout(350);
};
await clickChip(chipSpots[0], false);
await clickChip(chipSpots[1], true);
// Two selected things each wear a hairline in their own colour. (One on its own
// wears the pins instead, which is why this takes two.)
const marked = await page.evaluate(() => window.Konva.stages[0].find(".selection").length);
if (marked !== 2) fail(`clicking chips should select what they name, marked ${marked}`);
console.log("chips still select the things they name");

// A token in the hand does the same thing, and for the length of the drag
// rather than a quarter of a second.
const box = await page.locator("canvas").first().boundingBox();
const mt = (await load()).entities.find((e) => e.type === "player");
const at = await page.evaluate(
  ([id]) => {
    const p = window.Konva.stages[0].findOne("#" + id).getAbsolutePosition();
    return { x: p.x, y: p.y };
  },
  [mt.id]
);
const beforeDrag = await marker();
await page.mouse.move(box.x + at.x, box.y + at.y);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(box.x + at.x + i * 14, box.y + at.y + i * 9);
  await page.waitForTimeout(20);
}
const dragging = await readout();
if (dragging.leaders) fail("the leaders should be cut while something is in the hand");
if (dragging.opacity !== 0) fail(`the chips should be out of the way, at ${dragging.opacity}`);
// Two draws for the whole gesture: one for the selection the press makes, one
// to cut the leaders. Twelve moves of the mouse buy none of their own.
const drewDragging = dragging.draws - beforeDrag;
if (drewDragging > 2)
  fail(`the chips' canvas should be left alone through a drag, drew ${drewDragging} times`);
console.log(`dragging: readout out of the way, its canvas drawn ${drewDragging}x across 12 moves`);
await page.mouse.up();

await page.waitForTimeout(1400);
const dropped = await readout();
if (dropped.opacity !== 1) fail(`the chips should come back after the drop, at ${dropped.opacity}`);
if (!dropped.leaders) fail("the leaders should be drawn again after the drop");
if (dropped.at[mt.id] === back.at[mt.id])
  fail("the dragged token's chip should be laid out for where it was dropped");
console.log("dropped: chips back, laid out for where the token landed");

if (!process.exitCode) console.log("OK - the readout stands down while the floor moves");
await browser.close();
