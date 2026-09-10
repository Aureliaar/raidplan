/**
 * What every e2e suite needs and nothing else: a signed-in page, a plan to work
 * in, the arena canvas measured the way the canvas draws it, and the rail and
 * palette gestures the suites keep reaching for.
 *
 * A suite stops at its first failure: `fail` throws, and the handler below
 * prints what broke, closes the browser and exits 1.
 *
 *   npm run dev                                  # in another terminal
 *   node scripts/e2e-<name>.mjs http://localhost:59577
 */
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

/** Mirrors VIEW_MARGIN in src/client/canvas/Scene.tsx: the arena is drawn inside a margin. */
const VIEW_MARGIN = 1.18;
/** Pixels per arena unit for a stage `px` wide showing an arena `span` across. */
export const viewScale = (px, span = 1000) => px / (span * VIEW_MARGIN);

export const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");

class Failure extends Error {}
const browsers = new Set();

// On a failure, show what the person was looking at: a screenshot of every open page.
process.on("uncaughtException", async (error) => {
  console.error(error instanceof Failure ? `FAIL: ${error.message}` : error);
  const suite = path.basename(process.argv[1] ?? "e2e", ".mjs");
  const pages = [...browsers].flatMap((b) => b.contexts().flatMap((c) => c.pages()));
  for (const [i, page] of pages.entries()) {
    const shot = path.join(tmpdir(), `${suite}-fail-${i + 1}.png`);
    if (await page.screenshot({ path: shot }).then(() => true, () => false)) console.error(`  screenshot: ${shot}`);
  }
  await Promise.allSettled([...browsers].map((b) => b.close()));
  process.exit(1);
});

/** Stop the suite here, saying what a person could not do. */
export const fail = (message) => {
  throw new Failure(message);
};

/** One labelled line per claim; the first false one stops the suite. */
export const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label.padEnd(48)} ${detail}`);
  if (!ok) fail(label);
};

export async function launch() {
  const browser = await chromium.launch();
  browsers.add(browser);
  return browser;
}

/**
 * A fresh browser context, signed in through the dev-mode local sign-in when
 * given a name. `api` talks to the Worker with that context's cookie; `errors`
 * collects uncaught page errors.
 */
export async function session(name, { width = 1500, height = 950, browser } = {}) {
  browser ??= await launch();
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (name) await page.goto(`${base}/auth/dev?name=${name}`);

  const request = async (method, path, data, { allowError = false } = {}) => {
    const response = await page.request.fetch(base + path, { method, data });
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    if (!response.ok() && !allowError)
      throw new Error(`${method} ${path} -> ${response.status()} ${text.slice(0, 300)}`);
    return allowError ? { status: response.status(), body } : body;
  };
  const api = {
    get: (path, options) => request("GET", path, undefined, options),
    post: (path, data, options) => request("POST", path, data, options),
    delete: (path, options) => request("DELETE", path, undefined, options),
  };

  /** A new plan owned by this session, with its most-used verbs bound. */
  const createPlan = async (spec) => {
    const created = await api.post("/api/plans", spec);
    const id = (created.plan ?? created).id;
    return {
      id,
      url: `${base}/p/${id}`,
      load: () => api.get(`/api/plans/${id}`).then((body) => body.plan ?? body),
      ops: (list) => api.post(`/api/plans/${id}/ops`, { ops: [].concat(list) }),
    };
  };

  /** Open a plan in the editor and give the canvas a moment to settle. */
  const openPlan = async (id, settle = 900) => {
    await page.goto(`${base}/p/${id}`);
    await page.waitForSelector("canvas");
    await page.waitForTimeout(settle);
  };

  return { browser, context, page, api, errors, createPlan, openPlan };
}

/** Print the suite's closing line and let the browser go. */
export async function finish(s, message = "OK") {
  if (s.errors.length) fail("page errors: " + s.errors.slice(0, 3).join(" | "));
  await s.browser.close();
  browsers.delete(s.browser);
  console.log(message);
}

/* --- the arena canvas ------------------------------------------------------ */

/**
 * The floor, in arena units. Every palette drop adds a Beat lane to the rail
 * and the floor shrinks, so `measure()` again before aiming at anything after
 * a drop; `deselect`, `drop`, `click` and `nodeAt` do it for you.
 */
export async function floor(page) {
  const canvas = page.locator("canvas").first();
  const f = {
    canvas,
    box: null,
    scale: 1,
    async measure() {
      f.box = await canvas.boundingBox();
      f.scale = viewScale(f.box.width);
      return f;
    },
    /** Page pixels for an arena point, for page.mouse. */
    screen: (x, y) => ({
      x: f.box.x + f.box.width / 2 + x * f.scale,
      y: f.box.y + f.box.height / 2 + y * f.scale,
    }),
    /** Canvas-relative pixels for an arena point, for dragTo's targetPosition. */
    inCanvas: (x, y) => ({ x: f.box.width / 2 + x * f.scale, y: f.box.height / 2 + y * f.scale }),
    /** Click an arena point. */
    async click(x, y, options) {
      await f.measure();
      const p = f.screen(x, y);
      await page.mouse.click(p.x, p.y, options);
      await page.waitForTimeout(250);
    },
    /** Put the selection down on bare floor, so the Add palette is back. */
    async deselect() {
      await f.measure();
      await page.mouse.click(f.box.x + 8, f.box.y + 8);
      await page.waitForTimeout(200);
    },
    /** Drag a palette chip onto an arena point; the drop comes back selected. */
    async drop(label, x, y, { deselect = true } = {}) {
      await f.measure();
      await chip(page, label).dragTo(canvas, { targetPosition: f.inCanvas(x, y) });
      await page.waitForTimeout(600);
      if (deselect) await f.deselect();
    },
    /** Where the canvas draws a node right now, in page pixels. */
    async nodeAt(id) {
      await f.measure();
      const p = await page.evaluate(
        (nodeId) => window.Konva.stages[0].findOne("#" + nodeId)?.getAbsolutePosition() ?? null,
        id
      );
      return p && { x: f.box.x + p.x, y: f.box.y + p.y };
    },
  };
  return f.measure();
}

/** Press at one point, walk to another, let go — and wait for the commit. */
export async function drag(page, from, to, { steps = 12, settle = 700 } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
  await page.waitForTimeout(settle);
}

/** A Konva node's drawn pose in arena units, or null when nothing is drawn. */
export const konvaNode = (page, id) =>
  page.evaluate((nodeId) => {
    const n = window.Konva.stages[0].findOne("#" + nodeId);
    return n ? { x: Math.round(n.x()), y: Math.round(n.y()), rotation: Math.round(n.rotation()) } : null;
  }, id);

/* --- the palette and the rail --------------------------------------------- */

/** A palette chip, group chip or anything else whose whole text is `label`. */
export const chip = (page, label) => page.locator("div", { hasText: new RegExp(`^${label}$`) }).last();

/** A step row on the rail: a row is its number, in a 24px gutter. */
export const stepRow = (page, n) => page.getByRole("button", { name: `Step ${n}`, exact: true });

/** Walk to a step by its gutter — a row spans the lanes and Beat cards sit on top of it. */
export async function gotoStep(page, n) {
  await stepRow(page, n).click({ position: { x: 12, y: 14 } });
  await page.waitForTimeout(300);
}

/** The middle of step row n, measured fresh: most rail gestures move the rail. */
export async function rowMid(page, n) {
  const r = await stepRow(page, n).boundingBox();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Right-click a point, wait for the context menu, and take `item` if given. */
export async function menuAt(page, point, item) {
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.locator("[data-context-menu]").first().waitFor({ state: "visible", timeout: 3000 });
  if (item) {
    await page.locator(`[data-menu-item="${item}"]`).click();
    await page.waitForTimeout(700);
  }
}

/** The rail's row menu: right-click step row n, or "current", and take an item. */
export async function rowMenu(page, n, item) {
  const row = n === "current" ? page.locator('[data-current="true"]') : stepRow(page, n);
  const r = await row.boundingBox();
  await menuAt(page, { x: r.x + 12, y: r.y + r.height / 2 }, item);
}

/** Switch the timeline between collapsed, normal and expanded. */
export async function timelineMode(page, mode) {
  await page.locator(`[data-timeline-mode] [data-mode-option="${mode}"]`).click();
  await page.waitForTimeout(600);
}

/** The plan title reads as text until clicked; this opens it into its field. */
export async function planNameField(page) {
  const field = page.locator("header input").first();
  if (!(await field.count())) await page.locator("header [data-plan-name]").click();
  return field;
}

/** The plan's name, whether its field is open or it reads as text again. */
export async function planName(page) {
  const field = page.locator("header input").first();
  return (await field.count())
    ? field.inputValue()
    : page.locator("header [data-plan-name]").getAttribute("data-plan-name");
}

/* --- what the canvas would draw -------------------------------------------- */

/**
 * Every entity as drawn in a step (the first when none is named) by the same
 * resolver the canvas uses: Beat timing, bait solving and inheritance.
 */
export const drawn = (page, planId, stepId) =>
  page.evaluate(
    async ([id, sid]) => {
      const body = await (await fetch("/api/plans/" + id)).json();
      const plan = body.plan ?? body;
      const schema = await import("/src/shared/schema.ts");
      return schema.entitiesForStep(plan, sid ?? plan.steps[0].id);
    },
    [planId, stepId]
  );

/** An entity (by id or name) with a step's declared pose laid over its own fields. */
export const posed = (plan, key, stepId = plan.steps[0].id) => {
  const e = typeof key === "string" ? plan.entities.find((x) => x.id === key || x.name === key) : key;
  return e && { ...e, ...(e.overrides?.[stepId] ?? {}) };
};

/** Facing from one arena point to another, in degrees clockwise from north. */
export const bearing = (from, to) => (Math.atan2(to.x - from.x, -(to.y - from.y)) * 180) / Math.PI;
/** How far apart two facings are, in degrees. */
export const angleOff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/* --- the model's door ------------------------------------------------------ */

/**
 * An MCP client that does the streamable-HTTP handshake a model client does,
 * with a token minted for this session. Returns `call(tool, args)`.
 */
export async function mcpClient(s, label) {
  const { token } = await s.api.post("/api/tokens", { label });
  let sessionId;
  const rpc = async (method, params, notify = false) => {
    const body = { jsonrpc: "2.0", method, params };
    if (!notify) body.id = Math.floor(Math.random() * 1e6);
    const res = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer " + token,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    sessionId ??= res.headers.get("mcp-session-id") ?? undefined;
    if (notify) return;
    const text = await res.text();
    const line = text.split("\n").filter((l) => l.startsWith("data: ")).pop();
    if (!line) throw new Error(method + " -> " + res.status + " " + text.slice(0, 300));
    const msg = JSON.parse(line.slice(6));
    if (msg.error) throw new Error(method + ": " + msg.error.message);
    return msg.result;
  };
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: label, version: "0" } });
  await rpc("notifications/initialized", undefined, true);
  return async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r.content.map((c) => c.text).join("");
    if (r.isError) throw new Error(name + ": " + text);
    return text;
  };
}
