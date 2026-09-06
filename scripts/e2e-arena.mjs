/**
 * Arena customization is client-optimistic: the panel and the floor change in
 * the same paint as the click, not a round trip later.
 *
 * The proof is a held request. Playwright's route handler stalls the POST
 * before it leaves the browser, so the server neither answers nor broadcasts
 * — anything the UI shows in that window came from the local apply.
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();

try {
  await page.goto(base + "/auth/dev?name=arena-e2e");
  const api = (path, init = {}) => page.evaluate(async ([url, options]) => {
    const response = await fetch(url, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, [path, init]);

  const created = await api("/api/plans", {
    method: "POST",
    body: JSON.stringify({ name: "arena e2e", withParty: true }),
  });
  const planId = (created.plan ?? created).id;

  await page.goto(`${base}/p/${planId}`);
  await page.waitForSelector("canvas");

  const field = (label) => page.locator("div.label", { hasText: new RegExp(`^${label}$`) }).locator("xpath=..");
  const gridSelect = field("grid").locator("select");
  const backdropSelect = field("backdrop").locator("select");
  const opacity = field("backdrop opacity").locator("input");

  /** Hold every ops POST until `release()`; the server never sees them. */
  let held = [];
  await page.route("**/api/plans/*/ops", async (route) => {
    await new Promise((resolve) => held.push(resolve));
    await route.continue();
  });
  const release = async () => {
    const waiting = held;
    held = [];
    for (const resolve of waiting) resolve();
  };

  // A radial grid renames the two count fields — a label that exists only if
  // plan.arena.grid.type actually changed in local state.
  await gridSelect.selectOption("radial");
  await field("rings").waitFor({ timeout: 1500 });
  await field("spokes").waitFor({ timeout: 1500 });
  if (await gridSelect.inputValue() !== "radial") throw new Error("grid select snapped back before ack");

  // The opacity slider is disabled while there is no backdrop, so it enabling
  // proves the image landed locally too.
  await backdropSelect.selectOption("arena/arcadion12");
  await opacity.waitFor({ timeout: 1500 });
  if (await opacity.isDisabled()) throw new Error("backdrop opacity still disabled before ack");
  await opacity.fill("0.5");
  if (await opacity.inputValue() !== "0.5") throw new Error("opacity slider snapped back before ack");

  const stalled = await api(`/api/plans/${planId}`);
  if (stalled.plan.arena.grid.type === "radial" || stalled.plan.arena.image)
    throw new Error("server already had the edits — the request was not actually held");

  await release();
  await page.waitForFunction(async (id) => {
    const { plan } = await fetch(`/api/plans/${id}`).then((response) => response.json());
    return plan.arena.grid.type === "radial"
      && plan.arena.image === "arena/arcadion12"
      && plan.arena.imageOpacity === 0.5;
  }, planId, { timeout: 10000 });

  // A rejected edit rolls back rather than leaving a lie on screen.
  await page.route("**/api/plans/*/ops", (route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: "nope" }),
  }));
  await gridSelect.selectOption("none");
  await page.waitForFunction(
    () => document.querySelectorAll("div.label").length > 0
      && [...document.querySelectorAll("div.label")].some((label) => label.textContent === "rings"),
    null,
    { timeout: 5000 }
  );
  if (await gridSelect.inputValue() !== "radial") throw new Error("failed set_arena did not roll back");

  console.log("arena e2e ok");
} finally {
  await browser.close();
}
