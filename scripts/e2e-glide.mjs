/**
 * Walking the fight glides: press S and the party slides into the next step
 * rather than appearing in it. A click still snaps — a click means "show me
 * that" — and a second press abandons the walk in flight instead of queueing
 * behind it, so holding S never plays a backlog of moves.
 *
 *   node scripts/e2e-glide.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=glide-e2e");
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
  body: JSON.stringify({ name: "glide e2e", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);
const ops = (o) =>
  api("/api/plans/" + planId + "/ops", { method: "POST", body: JSON.stringify({ ops: [].concat(o) }) });

let doc = await load();
const mt = doc.entities.find((e) => e.name === "MT").id;
await ops([{ op: "add_step", name: "Two" }, { op: "add_step", name: "Three" }]);
doc = await load();
const [one, two, three] = doc.steps.map((s) => s.id);
// MT walks the width of the arena, a step at a time: a long way to be caught
// halfway down.
await ops([
  { op: "update_entity", id: mt, patch: { x: -400, y: 0 }, stepId: one },
  { op: "update_entity", id: mt, patch: { x: 0, y: 0 }, stepId: two },
  { op: "update_entity", id: mt, patch: { x: 400, y: 0 }, stepId: three },
]);

await page.goto(base + "/p/" + planId);
await page.waitForTimeout(1800);

/** Where the canvas is drawing MT this instant, in screen pixels. */
const x = () =>
  page.evaluate((id) => window.Konva.stages[0].findOne("#" + id)?.x() ?? null, mt);
/** Where MT is drawn, sampled every frame for a while. */
const track = (ms) =>
  page.evaluate(
    ([id, span]) =>
      new Promise((done) => {
        const seen = [];
        const t0 = performance.now();
        const tick = () => {
          seen.push([
            Math.round(performance.now() - t0),
            window.Konva.stages[0].findOne("#" + id)?.x() ?? null,
          ]);
          if (performance.now() - t0 < span) requestAnimationFrame(tick);
          else done(seen);
        };
        tick();
      }),
    [mt, ms]
  );

// Standing on step 1, with the canvas under the hand as it would be.
await page.mouse.click(700, 700);
await page.waitForTimeout(400);
const at1 = await x();

/* --- S glides into the next step ------------------------------------------ */

const walk = page.evaluate(() => new Promise((r) => setTimeout(r, 0))).then(() => track(700));
await page.keyboard.press("s");
const seen = await walk;
const at2 = seen[seen.length - 1][1];
const midway = seen.filter(([, px]) => px > at1 + 5 && px < at2 - 5);
if (!(at2 > at1 + 50)) fail("S did not move MT: " + at1 + " -> " + at2);
else if (midway.length < 4)
  fail("MT snapped: only " + midway.length + " frames between the two steps");
else console.log("S glides: MT crossed the floor over " + midway.length + " frames, not one");

const arrived = seen.find(([, px]) => px >= at2 - 1)[0];
if (arrived > 500) fail("the walk took " + arrived + "ms to settle");
else console.log("and it settles in " + arrived + "ms, once");

/* --- a click still snaps --------------------------------------------------- */

await page.locator("nav [data-step]").first().click();
await page.waitForTimeout(60);
const afterClick = await x();
if (Math.abs(afterClick - at1) > 2)
  fail("clicking step 1 left MT gliding: " + afterClick + " vs " + at1);
else console.log("clicking a step snaps straight there: a click means show me that");

/* --- and a second press abandons the first walk ---------------------------- */

const both = page.evaluate(() => new Promise((r) => setTimeout(r, 0))).then(() => track(900));
await page.keyboard.press("s");
await page.waitForTimeout(90);
await page.keyboard.press("s");
const run = await both;
const end = run[run.length - 1][1];
// Two steps' worth of floor, covered once: never parked on step 2 on the way.
const parked = run.filter(([t, px]) => t > 300 && Math.abs(px - at2) < 3);
const settled = run.find(([, px]) => px >= end - 1)[0];
if (Math.abs(end - (at1 + 2 * (at2 - at1))) > 4)
  fail("S then S landed at " + end + ", not on step 3");
else if (parked.length)
  fail("the first walk was played out first: MT sat on step 2 for " + parked.length + " frames");
else if (settled > 500) fail("the two presses took " + settled + "ms — they were queued");
else console.log("S then S: the first walk is abandoned where it got to, settled in " + settled + "ms");

/* --- an AoE fades out of the step it is leaving, and into the one it joins -- */

// A puddle that goes off in step 1 — so step 2 is after it — and a second one
// that is only declared in step 2. Walking between them, one resolves as the
// other comes up.
const [first, next] = (
  await ops([
    { op: "add_mech", name: "Resolving", snap: one, boom: one },
    { op: "add_mech", name: "Landing", snap: two, boom: two },
  ])
).values.map((v) => v.id);
const puddles = await ops([
  { op: "add_entity", spec: { type: "zone", shape: "circle", radius: 150, name: "going", x: -200, y: 200, declaredIn: one, mech: first } },
  { op: "add_entity", spec: { type: "zone", shape: "circle", radius: 150, name: "coming", x: 200, y: 200, declaredIn: two, mech: next } },
]);
const [going, coming] = puddles.values.map((v) => v.id);
await page.waitForTimeout(800);
await page.locator("nav [data-step]").first().click();
await page.waitForTimeout(500);

/** How solid two shapes are drawn, sampled every frame. */
const fades = (ms) =>
  page.evaluate(
    ([a, b, span]) =>
      new Promise((done) => {
        const seen = [];
        const t0 = performance.now();
        const look = (id) => window.Konva.stages[0].findOne("#" + id);
        const tick = () => {
          // How solid the fill is at the heart of a zone: the first stop of its
          // radial gradient, which is clear until the cast goes off.
          const heart = (n) => {
            const stops = n
              ?.find("Circle")
              .map((c) => c.fillRadialGradientColorStops?.())
              .find((v) => v && v.length);
            const m = stops && /rgba\([^)]*,\s*([\d.]+)\)/.exec(String(stops[1]));
            return m ? Number(m[1]) : null;
          };
          seen.push([
            Math.round(performance.now() - t0),
            look(a) ? look(a).opacity() : null,
            look(b) ? look(b).opacity() : null,
            look(a) ? look(a).scaleX() : null,
            heart(look(a)),
          ]);
          if (performance.now() - t0 < span) requestAnimationFrame(tick);
          else done(seen);
        };
        tick();
      }),
    [going, coming, ms]
  );

await page.mouse.click(700, 700);
await page.waitForTimeout(300);
/** The puddle as it sits on the floor, before anything is asked of it. */
const rest = await page.evaluate((id) => {
  const n = window.Konva.stages[0].findOne("#" + id);
  const stops = n
    ?.find("Circle")
    .map((c) => c.fillRadialGradientColorStops?.())
    .find((v) => v && v.length);
  const m = stops && /rgba\([^)]*,\s*([\d.]+)\)/.exec(String(stops[1]));
  return { o: n?.opacity() ?? null, sx: n?.scaleX() ?? null, heart: m ? Number(m[1]) : null };
}, going);
const fade = page.evaluate(() => new Promise((r) => setTimeout(r, 0))).then(() => fades(700));
await page.keyboard.press("s");
const seenFade = await fade;
// Only the frames caught part-way: at full or at nothing it could have popped.
const out = seenFade.filter(([, o]) => o !== null && o > 0.02 && o < 0.98);
const inn = seenFade.filter(([, , o]) => o !== null && o > 0.02 && o < 0.98);
const last = seenFade[seenFade.length - 1];
// It goes off rather than fading away: brighter for a moment, and bigger, on
// its way out.
const peak = Math.max(...seenFade.map(([, o]) => o ?? 0));
const widest = Math.max(...seenFade.map(([, , , sx]) => sx ?? 0));
const flooded = Math.max(...seenFade.map(([, , , , a]) => a ?? 0));
if (out.length < 4) fail("the leaving puddle vanished in " + out.length + " frames");
// The signature of a hit landing rather than a shape being switched off: it is
// visibly bigger while it is still bright, and only then goes.
else if (!seenFade.some(([, o, , sx]) => o > 0.7 && sx > rest.sx * 1.08))
  fail("the leaving puddle never swelled while it was still bright");
else if (!(widest > rest.sx * 1.2))
  fail("the leaving puddle never swelled: " + widest + " from " + rest.sx);
else if (rest.heart !== 0)
  fail("a telegraph sitting on the floor is not clear at its heart: " + rest.heart);
else if (!(flooded > 0.25)) fail("the fill never flooded as it went off: " + flooded);
else if (last[1] !== null && last[1] > 0.02) fail("the leaving puddle never left: " + last[1]);
else
  console.log(
    "the puddle it walks out of goes off: holds at " +
      peak.toFixed(2) +
      " while it swells to ×" +
      (widest / rest.sx).toFixed(2) +
      ", floods its heart to " +
      flooded.toFixed(2) +
      ", gone over " +
      out.length +
      " frames"
  );

if (inn.length < 4) fail("the arriving puddle popped in: " + inn.length + " frames");
else if (!(last[2] > 0.3)) fail("the arriving puddle never arrived: " + last[2]);
else console.log("and the one it walks into comes up over " + inn.length + " frames, to " + last[2].toFixed(2));

// Nothing is left of the walk once it has settled.
const ghost = await page.evaluate((id) => !!window.Konva.stages[0].findOne("#" + id), going);
if (ghost) fail("the faded-out puddle is still on the floor");
else console.log("and nothing of it is left on the floor to click on");

/* --- walking back up, it un-happens instead of going off ------------------- */

/** One shape, sampled every frame: how solid, how big, how flooded. */
const watch = (id, ms) =>
  page.evaluate(
    ([one, span]) =>
      new Promise((done) => {
        const seen = [];
        const t0 = performance.now();
        const tick = () => {
          const n = window.Konva.stages[0].findOne("#" + one);
          const stops = n
            ?.find("Circle")
            .map((c) => c.fillRadialGradientColorStops?.())
            .find((v) => v && v.length);
          const m = stops && /rgba\([^)]*,\s*([\d.]+)\)/.exec(String(stops[1]));
          seen.push([
            Math.round(performance.now() - t0),
            n ? n.opacity() : null,
            n ? n.scaleX() : null,
            m ? Number(m[1]) : null,
          ]);
          if (performance.now() - t0 < span) requestAnimationFrame(tick);
          else done(seen);
        };
        tick();
      }),
    [id, ms]
  );

// Standing in step 2, where the second puddle is: W takes the fight back to
// before it, so that puddle should leave quietly.
await page.mouse.click(700, 700);
await page.waitForTimeout(300);
const back = page.evaluate(() => new Promise((r) => setTimeout(r, 0))).then(() => watch(coming, 700));
await page.keyboard.press("w");
const rewind = await back;
const seenBack = rewind.filter(([, o]) => o !== null);
const faded = seenBack.filter(([, o]) => o > 0.02 && o < 0.98);
if (faded.length < 3) fail("walking back, the puddle vanished in " + faded.length + " frames");
else if (seenBack.some(([, , , heart]) => heart > 0.02))
  fail("walking back still set the puddle off: its fill flooded");
else if (seenBack.some(([, , sx]) => sx > rest.sx * 1.05))
  fail("walking back still set the puddle off: it swelled");
else if (!seenBack.every(([, o], i) => i === 0 || o <= seenBack[i - 1][1] + 0.001))
  fail("walking back, the puddle did not fade steadily");
else console.log("and walking back up, it fades out instead: a hit rewound is a hit unmade");

/* --- A and D walk sideways the same way ------------------------------------ */

await page.locator("nav [data-step]").first().click();
await page.waitForTimeout(300);
await page.getByTitle(/Another way this mechanic goes/).click();
await page.waitForTimeout(900);
doc = await load();
const reading = doc.mechanics[0].variants[1].id;
await ops({ op: "update_entity", id: mt, patch: { x: 400, y: -400 }, stepId: one, variant: reading });
await page.waitForTimeout(700);
await page.mouse.click(700, 700);
await page.waitForTimeout(300);
const sideways = page.evaluate(() => new Promise((r) => setTimeout(r, 0))).then(() => track(700));
await page.keyboard.press("d");
const across = await sideways;
const crossed = across.filter(([, px]) => px > across[0][1] + 5 && px < across[across.length - 1][1] - 5);
if (crossed.length < 4) fail("D snapped to the other reading: " + crossed.length + " frames");
else console.log("D glides too: the same step, going the other way, over " + crossed.length + " frames");

await browser.close();
console.log(process.exitCode ? "FAILED" : "OK - " + base + "/p/" + planId);
