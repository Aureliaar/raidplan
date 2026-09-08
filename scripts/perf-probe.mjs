/**
 * Where the frames go on a slow machine: builds a busy plan, throttles the CPU
 * the way a weak laptop is throttled, then records frame times and a CPU
 * profile across a step switch and a drag.
 *
 *   node scripts/perf-probe.mjs http://localhost:59577 [cpuThrottle]
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const THROTTLE = Number(process.argv[3] ?? 6);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const cdp = await page.context().newCDPSession(page);

await page.goto(base + "/auth/dev?name=perf-probe");
const api = (path, init = {}) =>
  page.evaluate(
    async ([p, i]) => {
      const r = await fetch(p, {
        ...i,
        headers: { "content-type": "application/json", ...(i.headers ?? {}) },
      });
      const t = await r.text();
      if (!r.ok) throw new Error(p + " -> " + r.status + " " + t.slice(0, 300));
      return t ? JSON.parse(t) : null;
    },
    [path, init]
  );

const created = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "perf probe", withParty: true }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);
const ops = (o) =>
  api("/api/plans/" + planId + "/ops", {
    method: "POST",
    body: JSON.stringify({ ops: [].concat(o) }),
  });

// A busy but ordinary fight frame: the party, a boss, a ring of telegraphs,
// baited spreads and stacks, tethers, waymarks.
await ops([
  { op: "add_step", name: "Two" },
  { op: "add_step", name: "Three" },
  { op: "add_entity", spec: { type: "enemy", name: "Boss", x: 0, y: 0, size: 120 } },
]);
let doc = await load();
const steps = doc.steps.map((s) => s.id);
const party = doc.entities.filter((e) => e.type === "player");
const zoneOps = [];
for (let i = 0; i < 12; i++) {
  const a = (i / 12) * Math.PI * 2;
  zoneOps.push({
    op: "add_entity",
    spec: {
      type: "zone",
      shape: i % 3 === 0 ? "cone" : i % 3 === 1 ? "donut" : "circle",
      x: Math.cos(a) * 260,
      y: Math.sin(a) * 260,
      radius: 120,
      innerRadius: 60,
      angle: 90,
      rotation: (a * 180) / Math.PI,
    },
  });
}
for (const p of party) {
  zoneOps.push({ op: "add_entity", spec: { type: "zone", shape: "circle", radius: 60, anchor: { on: p.id } } });
}
zoneOps.push({ op: "add_waymarks" });
await ops(zoneOps);
doc = await load();
// Movement between steps, so a step switch actually glides the whole floor.
const moves = [];
party.forEach((p, i) => {
  const a = (i / party.length) * Math.PI * 2;
  moves.push({ op: "update_entity", id: p.id, patch: { x: Math.cos(a) * 120, y: Math.sin(a) * 120 }, stepId: steps[0] });
  moves.push({ op: "update_entity", id: p.id, patch: { x: Math.cos(a) * 380, y: Math.sin(a) * 380 }, stepId: steps[1] });
  moves.push({ op: "update_entity", id: p.id, patch: { x: -Math.cos(a) * 300, y: -Math.sin(a) * 300 }, stepId: steps[2] });
});
await ops(moves);
doc = await load();
console.log(`plan: ${doc.entities.length} entities, ${doc.steps.length} steps -> ${base}/p/${planId}`);

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(1500);
// Chips on for everything: the readout state a busy plan is actually read in.
const chipSelect = page.locator("header select").first();
try {
  await chipSelect.selectOption("all", { timeout: 1500 });
} catch {
  console.log("(no chip selector found; running with defaults)");
}
await page.waitForTimeout(500);

const recorder = () =>
  page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      window.__frames.push(now - last);
      last = now;
      window.__raf = requestAnimationFrame(tick);
    };
    window.__raf = requestAnimationFrame(tick);
  });
const stop = () =>
  page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    const f = window.__frames.slice(1);
    const sorted = [...f].sort((a, b) => a - b);
    return {
      n: f.length,
      median: sorted[Math.floor(sorted.length / 2)] ?? 0,
      p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      worst: sorted[sorted.length - 1] ?? 0,
    };
  });

/** Self time by function across a profile, in ms, biggest first. */
const digest = (profile) => {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const total = profile.endTime - profile.startTime;
  const deltas = profile.timeDeltas ?? [];
  profile.samples.forEach((id, i) => {
    const node = byId.get(id);
    if (!node) return;
    const f = node.callFrame;
    const key = `${f.functionName || "(anon)"} @ ${(f.url || "").split("/").slice(-1)[0]}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (deltas[i] ?? 0) / 1000);
  });
  return { totalMs: total / 1000, top: [...self].sort((a, b) => b[1] - a[1]).slice(0, 18) };
};

const report = async (label, frames, profile) => {
  const d = digest(profile);
  console.log(`\n=== ${label} (CPU throttle ${THROTTLE}x) ===`);
  console.log(
    `frames: ${frames.n}  median ${frames.median.toFixed(1)}ms (${(1000 / frames.median).toFixed(0)}fps)  p95 ${frames.p95.toFixed(1)}ms  worst ${frames.worst.toFixed(1)}ms`
  );
  console.log(`profile span ${d.totalMs.toFixed(0)}ms; top self time:`);
  for (const [name, ms] of d.top) {
    if (ms < 1) continue;
    console.log(`  ${ms.toFixed(0).padStart(6)}ms  ${((ms / d.totalMs) * 100).toFixed(1).padStart(5)}%  ${name}`);
  }
};

await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });

// --- Step switches -------------------------------------------------------
await page.locator("canvas").first().click({ position: { x: 20, y: 20 } });
await recorder();
await cdp.send("Profiler.start");
for (let i = 0; i < 6; i++) {
  await page.keyboard.press(i % 2 === 0 ? "s" : "w");
  await page.waitForTimeout(500);
}
const stepProfile = (await cdp.send("Profiler.stop")).profile;
await report("step switch (glide)", await stop(), stepProfile);

// --- Drag ----------------------------------------------------------------
const box = await page.locator("canvas").first().boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
const fresh = await load();
const step = fresh.steps[0];
const mt = fresh.entities.find((e) => e.type === "player");
// Where MT actually is on this step, in screen pixels.
const pos = await page.evaluate(
  ([id]) => {
    const node = window.Konva.stages[0].findOne("#" + id);
    if (!node) return null;
    const p = node.getAbsolutePosition();
    return { x: p.x, y: p.y };
  },
  [mt.id]
);
if (!pos) throw new Error("could not locate a player node to drag");

await recorder();
await cdp.send("Profiler.start");
await page.mouse.move(box.x + pos.x, box.y + pos.y);
await page.mouse.down();
for (let i = 1; i <= 60; i++) {
  const a = (i / 60) * Math.PI * 2;
  await page.mouse.move(cx + Math.cos(a) * 220, cy + Math.sin(a) * 220);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.waitForTimeout(300);
const dragProfile = (await cdp.send("Profiler.stop")).profile;
await report("drag a token", await stop(), dragProfile);

console.log(`\nstep ${step.name}: probe plan left at ${base}/p/${planId}`);
await browser.close();
