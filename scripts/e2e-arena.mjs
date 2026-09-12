/**
 * Setting up the floor before anyone stands on it.
 *
 * Waymarks are scenery: a drag aimed at the step never nudges one, and up on
 * their own layer they move for the whole plan while everything else holds
 * still. Grid and backdrop change in the same paint as the click — before the
 * server has even seen the request — and roll back if it refuses. A custom
 * background uploads and is served back. And a known encounter knows its arena
 * in yalms, applies its shape, and takes a manual override.
 */
import { fileURLToPath } from "node:url";
import { drag, fail, finish, floor, posed, session } from "./harness.mjs";

const s = await session("arena-e2e");
const { page } = s;
const plan = await s.createPlan({ name: "arena e2e", withParty: true });
await plan.ops({ op: "add_waymarks" });
await s.openPlan(plan.id);
const f = await floor(page);
/** A labelled field on the arena panel. */
const field = (label) => page.locator("div.label", { hasText: new RegExp(`^${label}$`) }).locator("xpath=..");

/* --- waymarks are scenery until you pick up their layer -------------------- */

let doc = await plan.load();
const step = doc.steps[0].id;
const markerA = doc.entities.find((e) => e.type === "marker" && e.marker === "A");
const move = (from, to) => drag(page, f.screen(from.x, from.y), f.screen(to.x, to.y), { steps: 20, settle: 600 });
await move(markerA, { x: markerA.x + 220, y: markerA.y + 220 });
let a = (await plan.load()).entities.find((e) => e.id === markerA.id);
if (a.x !== markerA.x || a.y !== markerA.y || a.overrides?.[step]) fail(`a drag on the step layer moved waymark A to ${a.x},${a.y}`);

await page.getByRole("button", { name: "move waymarks" }).click();
await page.waitForTimeout(300);
const mt = posed(doc, "MT");
await move(mt, { x: mt.x + 200, y: mt.y });
const still = posed(await plan.load(), "MT");
if (Math.hypot(still.x - mt.x, still.y - mt.y) > 1) fail("a player moved while the waymark layer was up");
const want = { x: markerA.x + 180, y: markerA.y + 140 };
await move(markerA, want);
a = (await plan.load()).entities.find((e) => e.id === markerA.id);
if (Math.hypot(a.x - want.x, a.y - want.y) > 25) fail(`waymark A did not move on its own layer: ${a.x},${a.y}`);
if (Object.keys(a.overrides ?? {}).length) fail("moving a waymark wrote a per-step override");
await page.getByRole("button", { name: "done with waymarks" }).click();
await f.deselect();
console.log("waymark A ignored a drag on the step layer; on its own layer it moved for the whole plan, and MT held still");

/* --- grid and backdrop change before the server answers -------------------- */

const grid = field("grid").locator("select");
const backdrop = field("backdrop").locator("select");
const opacity = field("backdrop opacity").locator("input");
/** Hold every ops POST until the gate opens: the server neither answers nor broadcasts. */
let open;
const gate = new Promise((resolve) => (open = resolve));
await page.route("**/api/plans/*/ops", async (route) => {
  await gate;
  await route.continue();
});
// A radial grid renames the two count fields: labels that exist only once local state changed.
await grid.selectOption("radial");
await field("rings").waitFor({ timeout: 1500 });
await field("spokes").waitFor({ timeout: 1500 });
// The opacity slider is disabled with no backdrop, so it enabling proves the image landed locally too.
await backdrop.selectOption("arena/arcadion12");
await opacity.waitFor({ timeout: 1500 });
if (await opacity.isDisabled()) fail("backdrop opacity is still disabled before the server answered");
await opacity.fill("0.5");
const stalled = await plan.load();
if (stalled.arena.grid.type === "radial" || stalled.arena.image)
  fail("the server already had the edits, so the request was not actually held");
open();
await page.waitForFunction(
  async (id) => {
    const { plan } = await fetch(`/api/plans/${id}`).then((r) => r.json());
    return plan.arena.grid.type === "radial" && plan.arena.image === "arena/arcadion12" && plan.arena.imageOpacity === 0.5;
  },
  plan.id,
  { timeout: 10000 }
);
// A refused edit rolls back rather than leaving a lie on screen.
await page.route("**/api/plans/*/ops", (route) =>
  route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "nope" }) })
);
await grid.selectOption("none");
await field("rings").waitFor({ timeout: 5000 });
if ((await grid.inputValue()) !== "radial") fail("a refused grid change did not roll back");
await page.unroute("**/api/plans/*/ops");
// The refusal surfaces as a page error by design; it is not a crash.
s.errors.length = 0;
console.log("grid, backdrop and opacity change before the server answers, and a refused change rolls back");

/* --- a custom background uploads and is served back ------------------------ */

await page
  .locator('input[type="file"][accept*="image/png"]')
  .setInputFiles(fileURLToPath(new URL("../hitbox.png", import.meta.url)));
// The select turns blue the moment the upload answers, but the plan is only
// carrying the new image once its op has landed: wait for the document, or the
// fetch below asks for the old preset key and gets the app shell back.
await page.waitForFunction(async (id) => {
  const { plan } = await fetch(`/api/plans/${id}?fresh=${Date.now()}`, { cache: "no-store" }).then((r) => r.json());
  return typeof plan.arena.image === "string" && plan.arena.image.startsWith("/backgrounds/");
}, plan.id);
const served = await page.evaluate(async (id) => {
  const { plan } = await fetch(`/api/plans/${id}?fresh=${Date.now()}`, { cache: "no-store" }).then((r) => r.json());
  const image = await fetch(plan.arena.image);
  const invalid = await fetch("/api/backgrounds", { method: "POST", headers: { "content-type": "image/png" }, body: "not an image" });
  return {
    status: image.status,
    type: image.headers.get("content-type"),
    bytes: (await image.arrayBuffer()).byteLength,
    invalid: invalid.status,
  };
}, plan.id);
if (served.status !== 200 || served.type !== "image/png" || served.bytes < 1000)
  fail("the uploaded background was not served back: " + JSON.stringify(served));
if (served.invalid !== 415) fail(`a file that is not an image got HTTP ${served.invalid}, not 415`);
console.log(`an uploaded background is served back (${served.bytes} bytes), and a non-image is refused with 415`);

/* --- a known encounter knows its arena in yalms ---------------------------- */

await plan.ops({ op: "set_meta", encounter: "M12S P1" });
const calibration = field("arena width \\(yalms\\)").locator("input");
await page.getByText("40×30 yalms · M12S phase 1", { exact: true }).waitFor();
if ((await calibration.inputValue()) !== "40") fail("the known M12S arena did not default to 40 yalms");
await page.getByRole("button", { name: "Apply known 40×30 shape" }).click();
await page.waitForFunction(async (id) => {
  const { plan } = await fetch(`/api/plans/${id}`).then((r) => r.json());
  return plan.arena.shape === "rect" && plan.arena.height === 750 && plan.arena.widthYalms === undefined;
}, plan.id);
await calibration.fill("50");
await calibration.press("Enter");
await page.getByText("50×37.5 yalms · manual override", { exact: true }).waitFor();
await page.getByRole("button", { name: "reset", exact: true }).click();
await page.getByText("40×30 yalms · M12S phase 1", { exact: true }).waitFor();
// The label turns before the request lands: wait for the document itself.
await page.waitForFunction(async (id) => {
  const { plan } = await fetch(`/api/plans/${id}`).then((r) => r.json());
  return plan.arena.widthYalms === undefined;
}, plan.id);
console.log("M12S knows its 40×30 arena, applies that shape, takes a 50-yalm override, and resets");

await finish(s, "OK - " + plan.url);
