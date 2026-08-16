/**
 * Access regression test: a signed-in user who was never given a plan must not be
 * able to read it — over HTTP *or* over the sync socket.
 *
 * The socket case is the one worth testing: the Agents SDK sends the current state
 * as soon as a connection is accepted, so rejecting inside `onConnect` leaks the
 * document anyway. The check has to happen in the Worker, before routing.
 *
 *   npm run dev
 *   npm run e2e:access -- http://localhost:5173
 */
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:5173").replace(/\/$/, "");
const browser = await chromium.launch();
let failed = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label.padEnd(28)} ${detail}`);
};

const signIn = async (name) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${base}/auth/dev?name=${name}`, { waitUntil: "domcontentloaded" });
  return page;
};

const owner = await signIn(`owner-${Date.now()}`);
const { id } = await (
  await owner.request.post(`${base}/api/plans`, { data: { name: "access probe" } })
).json();

const stranger = await signIn(`stranger-${Date.now()}`);
const http = await stranger.request.get(`${base}/api/plans/${id}`);
check(http.status() === 404, "stranger blocked over HTTP", `got ${http.status()}`);

const socket = (page) =>
  page.evaluate(
    ([url, plan]) =>
      new Promise((res) => {
        const ws = new WebSocket(`${url.replace(/^http/, "ws")}/agents/plan-agent/${plan}`);
        const t = setTimeout(() => res("silence"), 5000);
        ws.onmessage = (e) => {
          if (String(e.data).includes("entities")) {
            clearTimeout(t);
            res("state");
          }
        };
        ws.onclose = () => {
          clearTimeout(t);
          res("closed");
        };
      }),
    [base, id]
  );

check((await socket(stranger)) !== "state", "stranger blocked over socket");
check((await socket(owner)) === "state", "owner still syncs");

await owner.request.delete(`${base}/api/plans/${id}`);
await browser.close();
console.log(failed ? `${failed} check(s) failed` : "access checks pass");
process.exit(failed ? 1 : 0);
