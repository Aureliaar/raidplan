/**
 * What a walk and a drag cost on a slow machine, with the chips off and on.
 * Frames are only counted while something is actually moving — idle frames
 * between key presses would otherwise drown the gesture being measured.
 *
 *   node scripts/perf-canvas.mjs http://localhost:59578/p/<id> [cpuThrottle]
 *
 * Build a plan to point it at with scripts/perf-probe.mjs.
 */
import { chromium } from "playwright";

const target = process.argv[2];
const THROTTLE = Number(process.argv[3] ?? 6);
if (!target) throw new Error("usage: node scripts/perf-canvas.mjs <plan url> [throttle]");
const origin = new URL(target).origin;
const planApi = "/api/plans/" + new URL(target).pathname.split("/").pop();

// Headless Chromium rasterises with SwiftShader — on the CPU — which is not
// what anyone's browser does. HEADED=1 puts the work on the real GPU, where a
// 2D canvas actually lives.
const headless = process.env.HEADED !== "1";

// A browser per configuration. Sharing one process makes whichever runs second
// measurably slower whatever it is measuring, which is enough to invent a
// difference that is not there.
async function run(withChips) {
  const browser = await chromium.launch({ headless });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
  const cdp = await page.context().newCDPSession(page);
  await page.goto(origin + "/auth/dev?name=perf-probe");
  await page.goto(target);
  await page.waitForSelector("canvas");
  await page.waitForTimeout(1800);
  if (withChips) {
    // C and V put a chip in the margin for everything and for the party.
    await page.keyboard.press("c");
    await page.keyboard.press("v");
    await page.waitForTimeout(600);
  }

  await page.evaluate(() => {
    window.__f = [];
    window.__on = false;
    let last = performance.now();
    const tick = () => {
      const n = performance.now();
      if (window.__on) window.__f.push(n - last);
      last = n;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const arm = () => page.evaluate(() => ((window.__f = []), (window.__on = true)));
  const collect = () =>
    page.evaluate(() => {
      window.__on = false;
      const f = window.__f.slice(1).sort((a, b) => a - b);
      return { median: f[Math.floor(f.length / 2)] ?? 0, worst: f[f.length - 1] ?? 0 };
    });

  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

  // A cold page paints its first gestures on half-warm raster caches and with
  // art still arriving, which reads as a machine faster than the one anyone is
  // sitting at. Walk it a few steps first, uncounted.
  await page.locator("canvas").first().click({ position: { x: 20, y: 20 } });
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press(i % 2 === 0 ? "s" : "w");
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(600);

  // --- Step walk: only the glide after each press counts.
  await page.locator("canvas").first().click({ position: { x: 20, y: 20 } });
  await page.waitForTimeout(300);
  // A glide is only GLIDE_MS long, so frame *deltas* inside it are a sample of
  // one or two on a slow machine and say nothing. How many frames the walk got
  // to draw in a fixed window is the honest measure of how it looked.
  // A glide is only GLIDE_MS long, so frame *deltas* inside it are a sample of
  // one or two on a slow machine and say nothing; count instead how many frames
  // the walk got to draw. The window has to stop with the glide — a longer one
  // fills up with idle frames at full speed and hides the difference — so the
  // count is summed over a run of presses to get a number worth reading.
  const WINDOW = 260;
  let frames = 0;
  for (let i = 0; i < 8; i++) {
    await arm();
    await page.keyboard.press(i % 2 === 0 ? "s" : "w");
    await page.waitForTimeout(WINDOW);
    frames += await page.evaluate(() => ((window.__on = false), window.__f.length));
    await page.waitForTimeout(500);
  }
  const walk = { frames, window: WINDOW * 8 };

  // --- Drag a party token around the floor. Dragging is started by hand on
  // mousedown, so the node is picked by what it is, not by Konva's flag.
  const box = await page.locator("canvas").first().boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const pos = await page.evaluate(async ([api]) => {
    const doc = await fetch(api).then((r) => r.json());
    const plan = doc.plan ?? doc;
    const player = plan.entities.find((e) => e.type === "player");
    const node = window.Konva.stages[0].findOne("#" + player.id);
    if (!node) return null;
    const p = node.getAbsolutePosition();
    return { x: p.x, y: p.y };
  }, [planApi]);
  if (!pos) throw new Error("no party token on the floor");
  await page.mouse.move(box.x + pos.x, box.y + pos.y);
  await page.mouse.down();
  await page.mouse.move(box.x + pos.x + 8, box.y + pos.y + 8);
  await arm();
  for (let i = 1; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    await page.mouse.move(cx + Math.cos(a) * 220, cy + Math.sin(a) * 220);
    await page.waitForTimeout(16);
  }
  const drag = await collect();
  await page.mouse.up();
  await page.waitForTimeout(300);

    return { walk, drag };
}

const fps = (ms) => (ms > 0 ? (1000 / ms).toFixed(0) : "-");
const walkLine = (label, r) =>
  `${label.padEnd(18)} ${String(r.frames).padStart(3)} frames across 8 glides (${((r.frames / r.window) * 1000).toFixed(0).padStart(2)}fps)`;
const dragLine = (label, r) =>
  `${label.padEnd(18)} ${r.median.toFixed(1).padStart(6)}ms/frame (${fps(r.median).padStart(2)}fps)  worst ${r.worst.toFixed(0)}ms`;

const offRun = await run(false);
const on = await run(true);
console.log(`CPU throttle ${THROTTLE}x, ${target}\n`);
console.log(walkLine("walk, chips off", offRun.walk));
console.log(dragLine("drag, chips off", offRun.drag));
console.log(walkLine("walk, chips on", on.walk));
console.log(dragLine("drag, chips on", on.drag));
