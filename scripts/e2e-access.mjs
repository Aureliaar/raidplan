/**
 * Who may see a plan. A signed-in user who was never given one must not be
 * able to read it — over HTTP *or* over the sync socket; an edit link makes an
 * editor, whose Ctrl+Z works like the owner's; and a public plan can be duplicated into a copy the viewer owns.
 *
 * The socket case is the one worth testing: the Agents SDK sends the current
 * state as soon as a connection is accepted, so rejecting inside `onConnect`
 * leaks the document anyway. The check has to happen in the Worker, before
 * routing.
 */
import { base, check, finish, launch, planNameField, session } from "./harness.mjs";

const browser = await launch();
const owner = await session(`owner-${Date.now()}`, { browser });
const plan = await owner.createPlan({ name: "access probe" });

/** What the sync socket hands this page: the document, silence, or a closed door. */
const socket = (page) =>
  page.evaluate(
    ([url, id]) =>
      new Promise((res) => {
        const ws = new WebSocket(`${url.replace(/^http/, "ws")}/agents/plan-agent/${id}`);
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
    [base, plan.id]
  );

const stranger = await session(`stranger-${Date.now()}`, { browser });
const http = await stranger.api.get(`/api/plans/${plan.id}`, { allowError: true });
check(http.status === 404, "stranger blocked over HTTP", `got ${http.status}`);
check((await socket(stranger.page)) !== "state", "stranger blocked over socket");
check((await socket(owner.page)) === "state", "owner still syncs");

const { url: editLink } = await owner.api.post(`/api/plans/${plan.id}/edit-link`);
const guest = await session(null, { browser });
await guest.page.goto(editLink, { waitUntil: "domcontentloaded" });
const asGuest = await guest.api.get(`/api/plans/${plan.id}`);
check(asGuest.role === "editor", "edit link grants editing");
check((await socket(guest.page)) === "state", "edit link grants sync");

// Undo is part of editing, not of owning: an editor's Ctrl+Z takes back their edit.
const beforeRename = (await owner.api.get(`/api/plans/${plan.id}`)).plan.name;
await guest.openPlan(plan.id);
const rename = await planNameField(guest.page);
await rename.fill("renamed by an editor");
await rename.press("Tab");
await guest.page.waitForTimeout(600);
check((await owner.api.get(`/api/plans/${plan.id}`)).plan.name === "renamed by an editor", "editor's rename saved");
await guest.page.mouse.click(5, 5);
await guest.page.keyboard.press("Control+z");
await guest.page.waitForTimeout(800);
check((await owner.api.get(`/api/plans/${plan.id}`)).plan.name === beforeRename, "editor's Ctrl+Z undoes their edit");

await owner.api.post(`/api/plans/${plan.id}/public`, { isPublic: true });
const { id: copyId } = await stranger.api.post(`/api/plans/${plan.id}/duplicate`);
const copy = await stranger.api.get(`/api/plans/${copyId}`);
check(copy.role === "owner", "duplicate belongs to viewer");
const same = (key) => JSON.stringify(copy.plan[key]) === JSON.stringify(asGuest.plan[key]);
check(same("entities") && same("steps") && same("mechanics"), "duplicate keeps plan contents");

await stranger.api.delete(`/api/plans/${copyId}`);
await owner.api.delete(`/api/plans/${plan.id}`);
await finish(owner, "OK - access checks pass");
