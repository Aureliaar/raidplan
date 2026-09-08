/**
 * Where you are looking lives in the address bar.
 *
 * Walking to a step in a later mechanic, opening a Beat and previewing one of
 * its Variants are all things you say about a plan without editing it — and
 * until now F5 threw all three away and dropped you back at step one. They are
 * in the URL now, so a reload lands on the same frame and the link hands that
 * frame to somebody else.
 *
 *   node scripts/e2e-view-url.mjs http://localhost:59577
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=view-url-e2e");
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
  body: JSON.stringify({ name: "view url e2e", withParty: true, variantModel: "step" }),
});
const planId = (created.plan ?? created).id;
const load = () => api("/api/plans/" + planId).then((p) => p.plan ?? p);
const ops = (o) =>
  api("/api/plans/" + planId + "/ops", { method: "POST", body: JSON.stringify({ ops: [].concat(o) }) });

// Two mechanics, so the step being looked at is inside the second section: a
// reload that forgets the step forgets which section is open too.
let doc = await load();
await ops([
  { op: "update_step", stepId: doc.steps[0].id, patch: { name: "Pull" } },
  { op: "add_mechanic", name: "Wings" },
]);
doc = await load();
const wings = doc.mechanics.at(-1).id;
await ops([
  { op: "update_step", stepId: doc.steps.at(-1).id, patch: { name: "Cast" } },
  { op: "add_step", name: "Boom", mechanic: wings },
]);
doc = await load();
const boom = doc.steps.find((s) => s.name === "Boom");
if (!boom || doc.steps.length !== 3) fail("expected Pull/Cast/Boom, got " + doc.steps.map((s) => s.name).join());

await page.goto(base + "/p/" + planId);
await page.waitForSelector("canvas");
await page.waitForTimeout(900);

/* --- walk to a step, open a Beat, preview one side of a split ------------- */

// The other mechanic's rows are folded away until you open its section.
await page.locator(`[data-mechanic="${wings}"]`).click();
await page.waitForTimeout(300);
await page.locator(`[data-step="${boom.id}"]`).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "New Beat here" }).click();
await page.waitForTimeout(600);
doc = await load();
const beat = doc.mechs[0];
if (!beat) fail("New Beat here made no Beat");

// A split at that Step, then preview its second side from the timeline.
await ops({ op: "add_step_variant", stepId: boom.id, name: "Left" });
await page.waitForTimeout(700);
doc = await load();
const variants = doc.steps.find((s) => s.id === boom.id).variants ?? [];
if (variants.length < 2) fail("expected a split at Boom, got " + variants.length + " Variants");
const pick = variants.at(-1).id;
await page.locator(`[data-step-variant="${pick}"]`).click();
await page.waitForTimeout(400);

const url = new URL(page.url());
const params = url.searchParams;
if (params.get("step") !== boom.id) fail("the URL says step=" + params.get("step") + ", expected Boom");
else if (params.get("mech") !== beat.id) fail("the URL says mech=" + params.get("mech"));
else if (params.get("v") !== `${boom.id}:${pick}`) fail("the URL says v=" + params.get("v"));
else console.log("looking at it wrote it into the link: " + url.search);

/* --- and F5 lands on the same frame --------------------------------------- */

await page.reload();
await page.waitForSelector("canvas");
await page.waitForTimeout(1200);

if (!(await page.locator(`[data-step="${boom.id}"][aria-current="step"]`).count()))
  fail("the reload did not land back on Boom");
else console.log("F5 lands back on Boom, inside the second mechanic");

if (!(await page.locator("text=/Filling|Editing:/").count()))
  fail("the reload closed the open Beat");
else console.log("the Beat is still open");

const pressed = await page.locator(`[data-step-variant="${pick}"] button`).first().getAttribute("aria-pressed");
if (pressed !== "true") fail("the previewed Variant came back as aria-pressed=" + pressed);
else console.log("the previewed Variant is still the one on screen");

/* --- and the link is the frame, not just this tab ------------------------- */

const other = await page.context().newPage();
await other.goto(url.href);
await other.waitForSelector("canvas");
await other.waitForTimeout(1200);
if (!(await other.locator(`[data-step="${boom.id}"][aria-current="step"]`).count()))
  fail("a fresh tab opening the link did not land on Boom");
else if (
  (await other.locator(`[data-step-variant="${pick}"] button`).first().getAttribute("aria-pressed")) !==
  "true"
)
  fail("a fresh tab opening the link did not show the previewed Variant");
else console.log("pasting the link puts a fresh tab on the same frame");

await browser.close();
