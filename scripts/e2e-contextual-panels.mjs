import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:5173").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();

try {
  await page.goto(base + "/auth/dev?name=contextual-panels-e2e");
  const created = await page.evaluate(async () => {
    const response = await fetch("/api/plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "contextual panels e2e", withParty: true }),
    });
    const text = await response.text();
    if (!response.ok || !text) {
      throw new Error(`creating plan returned ${response.status}: ${text || "empty response"}`);
    }
    return JSON.parse(text);
  });
  const planId = (created.plan ?? created).id;

  await page.goto(base + "/p/" + planId);
  await page.waitForSelector("canvas");
  await page.locator('[data-panel="palette"]').waitFor();
  if (await page.locator('[data-panel="inspector"]').count()) {
    throw new Error("the deep editor is visible with no selection");
  }

  const plan = await page.evaluate(async (id) => {
    const response = await fetch("/api/plans/" + id);
    const body = await response.json();
    return body.plan ?? body;
  }, planId);
  const player = plan.entities.find((entity) => entity.type === "player");
  const point = await page.evaluate((id) => {
    const node = window.Konva.stages[0].findOne("#" + id);
    return node?.getAbsolutePosition();
  }, player.id);
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + point.x, box.y + point.y);

  await page.locator('[data-panel="inspector"]').waitFor();
  if (await page.locator('[data-panel="palette"]').count()) {
    throw new Error("the add palette is visible while an entity is selected");
  }

  await page.locator('[data-panel="inspector"] button', { hasText: "✕" }).click();
  await page.locator('[data-panel="palette"]').waitFor();
  if (await page.locator('[data-panel="inspector"]').count()) {
    throw new Error("the deep editor remained visible after deselection");
  }

  console.log("OK - palette and deep editor follow selection context");
} finally {
  await browser.close();
}
