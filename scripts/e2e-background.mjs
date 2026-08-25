/** Upload a custom arena background through the editor and read it back. */
import { chromium } from "playwright";
import path from "node:path";

const base = (process.argv[2] ?? "http://localhost:59577").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();

try {
  await page.goto(base + "/auth/dev?name=background-e2e");
  const created = await page.evaluate(async () => {
    const response = await fetch("/api/plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "background e2e", withParty: false }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });

  await page.goto(`${base}/p/${created.id}`);
  await page.waitForSelector("canvas");
  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles(path.resolve("hitbox.png"));

  await page.waitForFunction(async (planId) => {
    const response = await fetch(`/api/plans/${planId}`);
    const { plan } = await response.json();
    return plan.arena.image?.startsWith("/backgrounds/");
  }, created.id);

  const result = await page.evaluate(async (planId) => {
    const { plan } = await fetch(`/api/plans/${planId}`).then((response) => response.json());
    const image = await fetch(plan.arena.image);
    const invalid = await fetch("/api/backgrounds", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: "not an image",
    });
    return {
      url: plan.arena.image,
      imageStatus: image.status,
      imageType: image.headers.get("content-type"),
      imageBytes: (await image.arrayBuffer()).byteLength,
      invalidStatus: invalid.status,
    };
  }, created.id);

  if (result.imageStatus !== 200 || result.imageType !== "image/png" || result.imageBytes < 1000) {
    throw new Error(`uploaded image was not served correctly: ${JSON.stringify(result)}`);
  }
  if (result.invalidStatus !== 415) {
    throw new Error(`invalid image returned ${result.invalidStatus}, expected 415`);
  }
  console.log(`custom background uploaded and served: ${result.url} (${result.imageBytes} bytes)`);
  console.log("invalid image rejected with HTTP 415");

  // A deliberately over-wide but lightweight PNG exercises dimension fitting
  // without committing a giant fixture to the repository.
  const oversizedBytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 9000;
    canvas.height = 16;
    const context = canvas.getContext("2d");
    context.fillStyle = "#5ad";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  const previousUrl = result.url;
  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({
    name: "over-wide.png",
    mimeType: "image/png",
    buffer: Buffer.from(oversizedBytes),
  });
  await page.waitForFunction(
    async ([planId, oldUrl]) => {
      const { plan } = await fetch(`/api/plans/${planId}`).then((response) => response.json());
      return plan.arena.image?.startsWith("/backgrounds/") && plan.arena.image !== oldUrl;
    },
    [created.id, previousUrl]
  );
  const resized = await page.evaluate(async (planId) => {
    const { plan } = await fetch(`/api/plans/${planId}`).then((response) => response.json());
    const blob = await fetch(plan.arena.image).then((response) => response.blob());
    const image = await createImageBitmap(blob);
    const dimensions = { width: image.width, height: image.height, type: blob.type };
    image.close();
    return dimensions;
  }, created.id);
  if (resized.width > 4096 || resized.height > 4096 || resized.type !== "image/webp") {
    throw new Error(`oversize image was not downscaled to WebP: ${JSON.stringify(resized)}`);
  }
  await page.getByText(/Downscaled 9000×16 to/).waitFor();
  console.log(`oversize image downscaled in-browser: 9000x16 -> ${resized.width}x${resized.height}`);
} finally {
  await browser.close();
}
