/**
 * Legacy -> Beat Variant conversion against a frozen Dark & Light export.
 * No request in this test ever reads the mutable deployed source plan.
 *
 *   node scripts/e2e-beat-variant-conversion.mjs http://localhost:5173
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:5173").replace(/\/$/, "");
const fixtureText = await readFile(new URL("./fixtures/dark-light-legacy-rev3018.json", import.meta.url), "utf8");
const fixture = JSON.parse(fixtureText);
const pinnedChecksum = (await readFile(new URL("./fixtures/dark-light-legacy-rev3018.sha256", import.meta.url), "utf8")).trim();
const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

let failures = 0;
const check = (condition, label, detail = "") => {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"} ${label.padEnd(48)} ${detail}`);
};

check(fixture.id === "plan_mMW41ylx" && fixture.rev === 3018, "fixture is exact audited source revision");
check(digest(fixture) === pinnedChecksum, "fixture canonical checksum is pinned", pinnedChecksum);

const browser = await chromium.launch();
async function person(name) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${base}/auth/dev?name=${encodeURIComponent(name)}`);
  const call = (path, init = {}) => page.evaluate(async ([url, options]) => {
    const response = await fetch(url, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }, [path, init]);
  const me = (await call("/api/me")).body.user;
  return { page, call, me };
}

const owner = await person("conversion-owner");
const editor = await person("conversion-editor");
const made = await owner.call("/api/plans", {
  method: "POST",
  body: JSON.stringify({ name: "Frozen Dark & Light conversion source", withParty: false }),
});
const sourceId = made.body.id;
const imported = await owner.call(`/api/plans/${sourceId}/import`, {
  method: "POST",
  body: JSON.stringify({ plan: fixture }),
});
check(imported.status === 200, "frozen fixture imported into disposable local copy");

await owner.call(`/api/plans/${sourceId}/share`, {
  method: "POST",
  body: JSON.stringify({ userId: editor.me.id, role: "editor" }),
});
const forbidden = await editor.call(`/api/plans/${sourceId}/beat-variants/dry-run`, { method: "POST" });
check(forbidden.status === 403, "editor cannot inspect owner-only conversion");

const sourceBefore = (await owner.call(`/api/plans/${sourceId}`)).body.plan;
const sourcePayload = JSON.stringify(sourceBefore);
const sourceChecksum = digest(sourcePayload);
const dryRun = await owner.call(`/api/plans/${sourceId}/beat-variants/dry-run`, { method: "POST" });
check(dryRun.status === 200, "owner can run conversion report");
check(dryRun.body.checksum === sourceChecksum, "report checksum identifies imported source");
check(dryRun.body.report.convertible, "frozen fixture conversion is lossless", dryRun.body.report.errors?.join(" | "));
check(
  dryRun.body.report.mismatches.length === 0,
  "all Route × Step renders are equivalent",
  dryRun.body.report.mismatches.slice(0, 4).map((mismatch) => `${mismatch.stepName}: ${mismatch.reason}`).join(" | ")
);
check(dryRun.body.report.routes >= 2, "compatibility Routes generated", `${dryRun.body.report.routes}`);
check(dryRun.body.report.compatibilityActorStates === 1, "fixture pins its one legacy actor-size detachment");

const stale = await owner.call(`/api/plans/${sourceId}/beat-variants/convert-to-copy`, {
  method: "POST",
  body: JSON.stringify({ expectedRev: sourceBefore.rev + 1, expectedChecksum: sourceChecksum }),
});
check(stale.status === 409, "stale expected revision is rejected");

const convertedResponse = await owner.call(`/api/plans/${sourceId}/beat-variants/convert-to-copy`, {
  method: "POST",
  body: JSON.stringify({ expectedRev: sourceBefore.rev, expectedChecksum: sourceChecksum }),
});
check(convertedResponse.status === 201, "owner creates an atomic converted copy", JSON.stringify(convertedResponse.body?.report?.errors ?? []));
const copyId = convertedResponse.body?.id;
const sourceAfter = (await owner.call(`/api/plans/${sourceId}`)).body.plan;
check(JSON.stringify(sourceAfter) === sourcePayload, "source document remains byte-for-byte unchanged");

if (copyId) {
  const copy = (await owner.call(`/api/plans/${copyId}`)).body.plan;
  check(copy.id !== sourceId && copy.variantModel === "beat", "copy uses Beat Variant model and fresh identity");
  check(copy.mechanics.every((section) => section.variants.length === 0), "copy has no Mechanic-wide authoring Variants");
  check(copy.variantRoutes.length === dryRun.body.report.routes, "copy persists compatibility Routes");
  check(copy.defaultVariantRoute === copy.variantRoutes[0].id, "copy persists a document default Route");
  check(copy.conversionArchive?.sourcePlanId === sourceId, "copy archives source identity and revision");
  check(copy.conversionArchive?.sha256 === sourceChecksum, "copy archives verified source checksum");
  check(!("payload" in copy.conversionArchive), "archive payload is not rebroadcast in plan state");
  const archived = await owner.call(`/api/plans/${copyId}/beat-variants/conversion-archive`);
  check(archived.status === 200 && archived.body.archive.payload === sourcePayload, "owner can recover immutable source payload");
  await owner.call(`/api/plans/${copyId}/share`, {
    method: "POST",
    body: JSON.stringify({ userId: editor.me.id, role: "editor" }),
  });
  const hiddenFromEditor = await editor.call(`/api/plans/${copyId}/beat-variants/conversion-archive`);
  check(hiddenFromEditor.status === 403, "archive payload remains owner-only for collaborators");
  const validation = await owner.page.evaluate(async ([plan, stepIds]) => {
    const schema = await import("/src/shared/schema.ts");
    return {
      routeErrors: plan.variantRoutes.flatMap((route) => schema.validateBeatVariantSelections(plan, route.selections)),
      conflicts: plan.variantRoutes.flatMap((route) =>
        stepIds.flatMap((stepId) => schema.composeBeatVariantEntities(plan, stepId, route.selections).conflicts)
      ),
    };
  }, [copy, copy.steps.map((step) => step.id)]);
  check(validation.routeErrors.length === 0, "saved compatibility Routes pass validation", validation.routeErrors.join(" | "));
  check(validation.conflicts.length === 0, "saved compatibility Routes have no movement conflicts");

  const undone = await owner.call(`/api/plans/${copyId}/history/undo`, { method: "POST" });
  check(undone.status === 200 && undone.body.plan.conversionArchive?.sha256 === sourceChecksum, "conversion provenance survives undo");
  const redone = await owner.call(`/api/plans/${copyId}/history/redo`, { method: "POST" });
  check(redone.status === 200 && redone.body.plan.variantModel === "beat", "converted document is redoable");
  check(redone.body.plan.conversionArchive?.sha256 === sourceChecksum, "redo retains immutable source archive metadata");
  const tampered = structuredClone(redone.body.plan);
  tampered.conversionArchive = {
    sourcePlanId: "tampered",
    sourceRev: 0,
    sha256: "0".repeat(64),
    payload: "{}",
    convertedAt: 0,
  };
  await owner.call(`/api/plans/${copyId}/import`, {
    method: "POST",
    body: JSON.stringify({ plan: tampered }),
  });
  const afterImport = (await owner.call(`/api/plans/${copyId}`)).body.plan;
  check(afterImport.conversionArchive?.sha256 === sourceChecksum, "later imports cannot rewrite conversion provenance");
}

await editor.page.goto(`${base}/p/${sourceId}`);
await editor.page.waitForSelector(`text=rev ${sourceBefore.rev}`);
check(
  (await editor.page.getByRole("button", { name: "Convert Variants to Beats…" }).count()) === 0,
  "editor is not offered the owner-only converter"
);

await owner.page.goto(`${base}/p/${sourceId}`);
await owner.page.getByRole("button", { name: "Convert Variants to Beats…" }).click();
const dialog = owner.page.getByRole("dialog", { name: "Convert legacy Variants to Beat boxes" });
await dialog.locator("[data-conversion-report][data-convertible=true]").waitFor();
check(
  (await dialog.getByText("The source plan stays unchanged", { exact: false }).count()) === 1,
  "conversion dialog makes copy/source behavior explicit"
);
await dialog.getByRole("button", { name: "Convert to copy" }).click();
await owner.page.waitForURL((url) => /^\/p\/plan_/.test(url.pathname) && !url.pathname.endsWith(sourceId));
const uiCopyId = owner.page.url().split("/").at(-1);
const uiCopy = (await owner.call(`/api/plans/${uiCopyId}`)).body.plan;
check(uiCopy.variantModel === "beat", "UI Convert to copy opens the new Beat plan");
check(
  JSON.stringify((await owner.call(`/api/plans/${sourceId}`)).body.plan) === sourcePayload,
  "UI conversion also leaves the only source untouched"
);

await browser.close();
if (failures) {
  console.error(`\n${failures} conversion check(s) failed`);
  process.exit(1);
}
console.log("\nBeat Variant conversion checks passed.");
