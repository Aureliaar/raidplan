// Regenerates src/shared/assets.ts from whatever is in public/assets.
// Run with `npm run assets:manifest` after adding or removing art.
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "public/assets";
const DIRS = ["actor", "marker", "marker/eden", "marker/ultimate", "mechanic", "arena"];
const OUT = "src/shared/assets.ts";
const MARKER = "/* ------------------------------------------------------------------ lookups */";

const catalog = [];
for (const dir of DIRS) {
  for (const file of readdirSync(join(ROOT, dir)).sort()) {
    if (!statSync(join(ROOT, dir, file)).isFile()) continue;
    catalog.push([`${dir}/${file.replace(/\.[^.]+$/, "")}`, `${dir}/${file}`]);
  }
}

const label = (key) => {
  const name = key.split("/").pop().replace(/[_-]+/g, " ").replace(/(\d+)$/, " $1").trim();
  return name[0].toUpperCase() + name.slice(1);
};
const keysIn = (prefix) => catalog.filter(([k]) => k.startsWith(prefix)).map(([k]) => k);
const list = (name, keys) =>
  `export const ${name}: readonly string[] = [\n${keys.map((k) => `  "${k}",`).join("\n")}\n];`;

const header = `/**
 * Bundled art catalogue — GENERATED, do not edit by hand.
 * Regenerate with \`npm run assets:manifest\` after adding files to public/assets.
 *
 * Actor, marker and arena art comes from XIVPlan (github.com/joelspadin/xivplan,
 * MIT). Mechanic telegraphs come from the FFXIV Strategy Board asset set.
 * See NOTICE.md.
 */

/** Asset key ("actor/WAR") -> file under /assets. */
export const ASSETS: Record<string, string> = {
${catalog.map(([k, v]) => `  "${k}": "${v}",`).join("\n")}
};

${list("ACTOR_KEYS", keysIn("actor/"))}

${list("MARKER_KEYS", keysIn("marker/"))}

${list("MECHANIC_KEYS", keysIn("mechanic/"))}

export const ARENA_BACKGROUNDS: readonly { key: string; label: string }[] = [
${keysIn("arena/").map((k) => `  { key: "${k}", label: "${label(k)}" },`).join("\n")}
];

`;

// Everything from the lookups marker down is hand-written; keep it.
const existing = readFileSync(OUT, "utf8");
const tail = existing.slice(existing.indexOf(MARKER));
writeFileSync(OUT, header + tail);
console.log(`assets.ts: ${catalog.length} assets, ${keysIn("arena/").length} arena backgrounds`);
