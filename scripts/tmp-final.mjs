import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:7777/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(6000);
const kids = await page.evaluate(() => {
  const p = PROJECTS.find((x) => x.name === "raidplan");
  return { live: p?.live, children: (p?.children || []).map((c) => c.port) };
});
const dotTitle = await page.locator(".row[data-name='raidplan'] .dot").getAttribute("title");
const known = await page.locator("#known > summary").innerText().catch(() => "no tab");
const childRows = await page.locator(".row.child").count();
console.log("raidplan:", JSON.stringify(kids), "| dot:", dotTitle);
console.log("child rows on whole page:", childRows, "| known tab:", known);
if (errors.length) { console.log("page errors:", errors.slice(0, 3)); process.exitCode = 1; }
await browser.close();
