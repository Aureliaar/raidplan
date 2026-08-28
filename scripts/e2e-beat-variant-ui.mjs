/** Contextual Beat Variant boxes, preview/edit split, A/D and conflicts. */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:5173").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
let failed = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label.padEnd(40)} ${detail}`);
};
await page.goto(base + "/auth/dev?name=beat-variant-ui-e2e");
const request = async (path, data) => {
  const response = await page.request.post(base + path, { data });
  if (!response.ok()) throw new Error(path + " -> " + response.status() + " " + (await response.text()));
  return response.json();
};
const { id } = await request("/api/plans", {
  name: "Beat Variant UI e2e",
  withParty: true,
  variantModel: "beat",
});
let plan = (await (await page.request.get(base + "/api/plans/" + id)).json()).plan;
const step = plan.steps[0].id;
const mt = plan.entities.find((entity) => entity.name === "MT").id;
const made = await request("/api/plans/" + id + "/ops", {
  ops: [
    { op: "add_mech", name: "Explosion", snap: step, boom: step },
    { op: "add_mech", name: "Orbs", snap: step, boom: step },
  ],
});
const [explosion, orbs] = made.values.map((value) => value.id);
await request("/api/plans/" + id + "/ops", {
  ops: [
    { op: "add_entity", spec: { id: "explosion_part", type: "zone", shape: "circle", mech: explosion } },
    { op: "add_entity", spec: { id: "orbs_part", type: "zone", shape: "donut", mech: orbs, x: 120 } },
    { op: "add_beat_variant", beatId: explosion },
    { op: "add_beat_variant", beatId: orbs },
  ],
});
plan = (await (await page.request.get(base + "/api/plans/" + id)).json()).plan;
const [explosionA, explosionB] = plan.mechs.find((beat) => beat.id === explosion).variants.map((variant) => variant.id);
const [orbsA] = plan.mechs.find((beat) => beat.id === orbs).variants.map((variant) => variant.id);

await page.goto(base + "/p/" + id);
await page.locator(`[data-mech="${explosion}"]`).click();
const timelineBoxes = page.locator(`[data-timeline-variants="${explosion}"] [data-timeline-variant]`);
check((await timelineBoxes.allTextContents()).join("|").includes("A") && (await timelineBoxes.allTextContents()).join("|").includes("B"), "selected Beat exposes boxes on timeline", (await timelineBoxes.allTextContents()).join("|") );
check((await timelineBoxes.allTextContents()).every((text) => text.includes("Shared")), "fresh Variant boxes flag Shared inheritance");
const tabs = page.locator(`[data-beat-variants="${explosion}"] [role=tab]`);
check((await tabs.allTextContents()).join("|").includes("Beat|A|B"), "inspector mirrors Beat destinations", (await tabs.allTextContents()).join("|"));

await page.locator(`[data-timeline-variant="${explosionA}"]`).click();
check((await page.locator("[data-edit-destination]").innerText()).includes("Explosion › A"), "timeline box changes explicit edit destination");
const beforeEdit = await page.locator("[data-edit-destination]").innerText();
await page.keyboard.press("d");
check((await page.locator(`[data-preview-beat="${explosion}"]`).inputValue()) === explosionB, "A/D changes focused Beat preview");
check((await page.locator("[data-edit-destination]").innerText()) === beforeEdit, "A/D never changes edit destination");

// Multiple varying Beats with no selected/focused Beat: A/D does nothing and hints.
await page.locator(`[data-mech="${explosion}"]`).click();
await page.locator("body").click({ position: { x: 500, y: 30 } });
const previewBefore = await page.locator("[data-preview-beat]").evaluateAll((nodes) =>
  Object.fromEntries(nodes.map((node) => [node.getAttribute("data-preview-beat"), node.value]))
);
await page.keyboard.press("d");
const previewAfter = await page.locator("[data-preview-beat]").evaluateAll((nodes) =>
  Object.fromEntries(nodes.map((node) => [node.getAttribute("data-preview-beat"), node.value]))
);
// Focus remains a session concept after touching a chip/card; reload gives the
// true unfocused multi-Beat case without changing document preview.
await page.reload();
const unfocusedBefore = await page.locator("[data-preview-beat]").evaluateAll((nodes) =>
  Object.fromEntries(nodes.map((node) => [node.getAttribute("data-preview-beat"), node.value]))
);
await page.keyboard.press("d");
const afterReload = await page.locator("[data-preview-beat]").evaluateAll((nodes) =>
  Object.fromEntries(nodes.map((node) => [node.getAttribute("data-preview-beat"), node.value]))
);
check(JSON.stringify(afterReload) === JSON.stringify(unfocusedBefore), "multi-Beat A/D is inert without focus");

// Server-authored detached state is explained in the inspector and both reset
// domains remain independently actionable.
await request("/api/plans/" + id + "/ops", {
  ops: [
    { op: "update_entity", id: "explosion_part", patch: { x: 55 }, stepId: step, variant: explosionA },
    { op: "update_entity", id: mt, patch: { x: 210, y: 220 }, stepId: step, variant: explosionA },
    { op: "update_entity", id: mt, patch: { x: -210, y: -220 }, stepId: step, variant: orbsA },
  ],
});
await page.reload();
await page.locator(`[data-mech="${explosion}"]`).click();
await page.locator(`[data-beat-variant="${explosionA}"]`).click();
const panel = page.locator(`[data-beat-variants="${explosion}"]`);
check((await panel.innerText()).includes("Edited independently"), "inspector explains detached content");
check((await panel.innerText()).includes("Movement conflict"), "inspector explains movement conflict");
check(await page.locator("[data-movement-conflict]").isVisible(), "canvas shows prominent conflict warning");
check((await page.locator("[data-movement-conflict]").innerText()).includes("Shared Step positions"), "conflict warning states safe preview");

await browser.close();
console.log(failed ? `${failed} Beat Variant UI check(s) failed` : "Beat Variant UI checks pass");
process.exit(failed ? 1 : 0);
