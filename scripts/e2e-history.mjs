/** Persistent undo/redo and timestamped revision sessions. */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:5173").replace(/\/$/, "");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const fail = (message) => {
  console.error("FAIL:", message);
  process.exitCode = 1;
};

await page.goto(base + "/auth/dev?name=history-e2e");
const api = (path, init = {}) =>
  page.evaluate(
    async ([url, options]) => {
      const response = await fetch(url, {
        ...options,
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}: ${text.slice(0, 200)}`);
      return body;
    },
    [path, init]
  );

const created = await api("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "history e2e", withParty: false }),
});
const planId = created.id;
const edit = (name) =>
  api(`/api/plans/${planId}/ops`, {
    method: "POST",
    body: JSON.stringify({ ops: { op: "set_meta", name }, sessionId: "history-e2e-tab" }),
  });

await edit("first revision");
await edit("second revision");
let history = await api(`/api/plans/${planId}/history`);
const authored = history.revisions.filter((revision) => revision.actorName === "history-e2e");
if (authored.length !== 2) fail(`expected two authored revisions, got ${authored.length}`);
else if (authored[0].sessionId !== authored[1].sessionId) fail("consecutive edits were split across sessions");
else if (!authored.every((revision) => revision.createdAt && revision.sessionStartedAt))
  fail("revision/session timestamps are missing");
else console.log("two timestamped revisions grouped into one work session");

let result = await api(`/api/plans/${planId}/history/undo`, { method: "POST" });
if (result.plan.name !== "first revision" || !result.history.canRedo) fail("server undo did not expose redo");
else console.log("server undo restored the prior snapshot");
result = await api(`/api/plans/${planId}/history/redo`, { method: "POST" });
if (result.plan.name !== "second revision") fail("server redo did not restore the edit");
else console.log("server redo restored the edit");

await page.goto(`${base}/p/${planId}`);
await page.waitForSelector("canvas");
await page.keyboard.press("Control+z");
await page.waitForTimeout(500);
let plan = await api(`/api/plans/${planId}`).then((response) => response.plan);
if (plan.name !== "first revision") fail("Ctrl+Z did not undo");
await page.keyboard.press("Control+y");
await page.waitForTimeout(500);
plan = await api(`/api/plans/${planId}`).then((response) => response.plan);
if (plan.name !== "second revision") fail("Ctrl+Y did not redo");
else console.log("Ctrl+Z and Ctrl+Y drive the persistent stack");

// Make an edit in this tab so it has both sides of the history handoff, then
// delay the network. Undo and redo should paint their cached target immediately.
// The plan title reads as text until you click it into a field, and reads as
// text again once the field commits and closes.
const nameInput = page.locator("header input").first();
const planName = async () =>
  (await nameInput.count())
    ? await nameInput.inputValue()
    : await page.locator("header [data-plan-name]").getAttribute("data-plan-name");
if (!(await nameInput.count())) await page.locator("header [data-plan-name]").click();
const saved = page.waitForResponse(
  (response) => response.url().includes(`/api/plans/${planId}/ops`) && response.request().method() === "POST"
);
await nameInput.fill("instant revision");
await nameInput.press("Tab");
await saved;

await page.route(`**/api/plans/${planId}/history/undo`, async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  await route.continue();
}, { times: 1 });
const undoSettled = page.waitForResponse(
  (response) => response.url().endsWith(`/api/plans/${planId}/history/undo`)
);
await page.getByTitle("Undo (Ctrl+Z)").click();
await page.waitForTimeout(50);
if ((await planName()) !== "second revision")
  fail("undo waited for the delayed server response before painting its known snapshot");
else console.log("undo paints its known snapshot before the server round trip");
await undoSettled;

await page.route(`**/api/plans/${planId}/history/redo`, async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  await route.continue();
}, { times: 1 });
const redoSettled = page.waitForResponse(
  (response) => response.url().endsWith(`/api/plans/${planId}/history/redo`)
);
await page.getByTitle("Redo (Ctrl+Y or Ctrl+Shift+Z)").click();
await page.waitForTimeout(50);
if ((await planName()) !== "instant revision")
  fail("redo waited for the delayed server response before painting its known snapshot");
else console.log("redo paints its known snapshot before the server round trip");
await redoSettled;

await page.getByRole("button", { name: "History" }).click();
await page.getByText("Revision history").waitFor();
if (!(await page.locator("aside").getByText("history-e2e", { exact: true }).first().isVisible())) fail("history drawer omitted actor/session");
else console.log("history drawer shows the identified work session");

history = await api(`/api/plans/${planId}/history`);
const first = [...history.revisions].reverse().find((revision) => revision.rev === authored[1].rev);
result = await api(`/api/plans/${planId}/history/revert`, {
  method: "POST",
  body: JSON.stringify({ revisionId: first.id, sessionId: "history-e2e-tab" }),
});
if (result.plan.name !== "first revision") fail("revert did not restore selected contents");
else if (result.history.revisions[0].summary !== `Restored revision ${first.rev}`)
  fail("revert did not create an audit revision");
else console.log("restore created a new audit revision without rewriting history");

// A fresh edit after undo forks from that point and invalidates the old redo lane.
await api(`/api/plans/${planId}/history/undo`, { method: "POST" });
await api(`/api/plans/${planId}/history/undo`, { method: "POST" });
result = await edit("branched revision");
if (result.history.canRedo) fail("a new edit after undo left stale redo available");
else {
  const unchanged = await api(`/api/plans/${planId}/history/redo`, { method: "POST" });
  if (unchanged.plan.name !== "branched revision") fail("redo crossed into an abandoned branch");
  else console.log("a new edit after undo clears the abandoned redo lane");
}

await browser.close();
console.log(process.exitCode ? "FAILED" : "OK - undo, redo, work sessions, and revision restore");
