import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://localhost:7777/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const kids = await page.evaluate(() => {
  const p = PROJECTS.find((x) => x.name === "raidplan");
  return { managed: p, children: (p?.children || []).map((c) => ({ port: c.port, pid: c.pid, proc: c.proc, label: c.label, cmd: (c.cmd || "").slice(-90) })) };
});
console.log(JSON.stringify(kids, null, 1));
await browser.close();
