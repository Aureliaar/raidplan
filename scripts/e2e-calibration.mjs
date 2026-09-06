/** Arena physical calibration and calibrated tether distance editing. */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();

try {
  await page.goto(base + "/auth/dev?name=calibration-e2e");
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
    body: JSON.stringify({ name: "calibration e2e", withParty: true }),
  });
  const planId = (created.plan ?? created).id;
  let plan = (await api(`/api/plans/${planId}`)).plan;
  const mt = plan.entities.find((entity) => entity.name === "MT");
  const m1 = plan.entities.find((entity) => entity.name === "M1");
  const tetherId = "tether_calibration_e2e";
  await api(`/api/plans/${planId}/ops`, {
    method: "POST",
    body: JSON.stringify({ ops: [
      { op: "set_meta", encounter: "M12S P1" },
      { op: "update_entity", id: mt.id, patch: { x: 0, y: 0 }, stepId: plan.steps[0].id },
      { op: "update_entity", id: m1.id, patch: { x: 300, y: 0 }, stepId: plan.steps[0].id },
      { op: "add_entity", spec: { id: tetherId, type: "tether", from: mt.id, to: m1.id, style: "close", range: 200 } },
    ] }),
  });

  await page.goto(`${base}/p/${planId}`);
  await page.waitForSelector("canvas");
  const calibration = page.locator("div.label", { hasText: /^arena width \(yalms\)$/ }).locator("xpath=..").locator("input");
  if (await calibration.inputValue() !== "40") throw new Error("known M12S width did not default to 40 yalms");
  await page.getByText("40×30 yalms · M12S phase 1", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Apply known 40×30 shape" }).click();
  await page.waitForFunction(async (id) => {
    const { plan } = await fetch(`/api/plans/${id}`).then((response) => response.json());
    return plan.arena.shape === "rect" && plan.arena.height === 750 && plan.arena.widthYalms === undefined;
  }, planId);
  const tetherPoint = await page.evaluate((id) => {
    const stage = window.Konva.stages[0];
    const node = stage.findOne("#" + id);
    const distance = Math.max(...node.find(".tether-guide").flatMap((line) => line.points()));
    for (let x = 35; x < distance - 35; x += 20) {
      const point = node.getAbsoluteTransform().point({ x, y: 0 });
      const other = stage.getAllIntersections(point).some((hit) => {
        const entity = hit.findAncestor(".entity", true)?.id();
        return entity && entity !== id;
      });
      if (!other) return point;
    }
    throw new Error("no unobstructed point on calibration tether");
  }, tetherId);
  const canvasBox = await page.locator("canvas").first().boundingBox();
  await page.mouse.click(canvasBox.x + tetherPoint.x, canvasBox.y + tetherPoint.y);
  const rangeField = page.locator("div.label", { hasText: /^required range$/ }).locator("xpath=..");
  await rangeField.waitFor({ timeout: 3000 });
  await page.getByText("12 ≤ 8 yalms — not satisfied", { exact: true }).waitFor();
  await rangeField.locator("select").selectOption({ label: "10 yalms" });

  await page.waitForFunction(async ([id, tether]) => {
    const { plan } = await fetch(`/api/plans/${id}`).then((response) => response.json());
    return plan.entities.find((entity) => entity.id === tether)?.range === 250;
  }, [planId, tetherId]);
  await page.getByRole("button", { name: "Close inspector" }).click();
  await calibration.fill("50");
  await calibration.press("Enter");
  await page.getByText("50×37.5 yalms · manual override", { exact: true }).waitFor();
  const group = (label) => page.locator("div", { hasText: new RegExp(`^${label}$`) }).last();
  await group("Together tether").dragTo(group("Supports"));
  await group("Go-far tether").dragTo(group("Damagers"));
  await page.waitForFunction(async (id) => {
    const { plan } = await fetch(`/api/plans/${id}`).then((response) => response.json());
    const close = plan.entities.filter((entity) => entity.type === "tether" && entity.bond && entity.style === "close");
    const far = plan.entities.filter((entity) => entity.type === "tether" && entity.bond && entity.style === "far");
    return close.length === 4 && close.every((entity) => entity.range === 160)
      && far.length === 4 && far.every((entity) => entity.range === 500);
  }, planId);
  await page.getByRole("button", { name: "reset", exact: true }).click();
  await page.getByText("40×30 yalms · M12S phase 1", { exact: true }).waitFor();
  // The label turns before the request lands: wait for the document itself.
  await page.waitForFunction(async (id) => {
    const { plan } = await fetch(`/api/plans/${id}`).then((response) => response.json());
    return plan.arena.widthYalms === undefined;
  }, planId);
  plan = (await api(`/api/plans/${planId}`)).plan;
  if (plan.arena.widthYalms !== undefined) throw new Error("reset did not clear the manual override");
  console.log("known M12S 40×30 calibration, shape application, tether conversion, manual override and reset all work");
} finally {
  await browser.close();
}
