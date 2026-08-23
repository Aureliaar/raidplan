/**
 * Push a plan from one instance to another — usually local dev up to the
 * deployed worker, which is the only way a fight built here gets there: every
 * instance has its own Durable Objects, so a deploy carries code and no plans.
 *
 * It replaces the target's whole document. The target keeps its own id, its
 * owner and who it is shared with; everything drawn on it comes from the source.
 *
 *   RP_TOKEN=rp_… node scripts/push-plan.mjs <local-plan-id> <remote-plan-id>
 *
 * The token is the remote's, from the Tokens panel, and must own the target.
 * --from and --to override the two hosts.
 */
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const [source, target] = args;
const from = flag("from", "http://localhost:59577").replace(/\/$/, "");
const to = flag("to", "https://raidplan.jacopo-sinigaglia.workers.dev").replace(/\/$/, "");
const token = process.env.RP_TOKEN;

if (!source || !target) {
  console.error("usage: RP_TOKEN=rp_… node scripts/push-plan.mjs <source-plan-id> <target-plan-id>");
  process.exit(2);
}
if (!token) {
  console.error("RP_TOKEN is not set — mint one on the target from the Tokens panel");
  process.exit(2);
}

/** Read the source. Local dev needs a session; the dev sign-in is one request. */
const jar = await fetch(`${from}/auth/dev?name=${process.env.RP_USER ?? "luca"}`, { redirect: "manual" });
const cookie = (jar.headers.get("set-cookie") ?? "").split(";")[0];
const read = await fetch(`${from}/api/plans/${source}`, { headers: cookie ? { cookie } : {} });
if (!read.ok) {
  console.error(`could not read ${source} from ${from}: ${read.status} ${await read.text()}`);
  process.exit(1);
}
const plan = (await read.json()).plan;
console.log(
  `${plan.name}: ${plan.steps.length} steps, ${plan.entities.length} shapes, ${plan.mechs.length} casts`
);

const wrote = await fetch(`${to}/api/plans/${target}/import`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ plan }),
});
const body = await wrote.text();
if (!wrote.ok) {
  console.error(`import refused: ${wrote.status} ${body}`);
  process.exit(1);
}
console.log(`pushed to ${to}/p/${target} — ${body}`);
