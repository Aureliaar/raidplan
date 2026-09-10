/**
 * Runs every e2e suite in turn against a running dev server and names the
 * ones a person would have got stuck in.
 *
 *   npm run dev                       # in another terminal
 *   npm run e2e -- http://localhost:59577
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "http://localhost:59577";
const dir = new URL(".", import.meta.url);
const suites = readdirSync(dir).filter((f) => /^e2e-.+\.mjs$/.test(f)).sort();

const failed = [];
for (const suite of suites) {
  console.log(`\n=== ${suite}`);
  const run = spawnSync(process.execPath, [fileURLToPath(new URL(suite, dir)), base], {
    stdio: "inherit",
    timeout: 240_000,
  });
  if (run.status !== 0) failed.push(suite);
}

console.log(`\n${suites.length - failed.length}/${suites.length} suites pass`);
if (failed.length) {
  console.log("failed: " + failed.join(", "));
  process.exit(1);
}
