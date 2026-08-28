/** Run every legacy and Beat Variant regression against one already-running local server. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "http://localhost:5173";
const suites = [
  "e2e-variant-inheritance.mjs",
  "e2e-variant-owners.mjs",
  "e2e-beat-variants.mjs",
  "e2e-beat-variant-ui.mjs",
  "e2e-beat-variant-conversion.mjs",
  "e2e-beat-variant-mcp.mjs",
];

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(suite, import.meta.url)), base], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\nAll ${suites.length} legacy + Beat Variant regression suites passed.`);
