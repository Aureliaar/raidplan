import { Hono } from "hono";
import { routeAgentRequest } from "agents";
import { type AppEnv, appUrl, isDevAuth, isDiscordAuth } from "./env";
import { authRoutes, authenticate, issueToken } from "./auth";
import { registry } from "./registry";
import { planStub } from "./plan-agent";
import { RaidPlanMCP } from "./mcp";
import { chatRoutes } from "./chat";
import { createPlan } from "../shared/ops";
import type { Op } from "../shared/apply";
import type { PlanRole, User } from "../shared/schema";

export { PlanAgent } from "./plan-agent";
export { Registry } from "./registry";
export { RaidPlanMCP } from "./mcp";

type Ctx = { Bindings: AppEnv; Variables: { user: User | null } };

const app = new Hono<Ctx>();

app.use("*", async (c, next) => {
  const { user } = await authenticate(c.req.raw, c.env);
  c.set("user", user);
  await next();
});

function requireUser(c: { get: (k: "user") => User | null }): User {
  const user = c.get("user");
  if (!user) throw new HttpError(401, "Sign in first");
  return user;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

app.onError((err, c) => {
  const status = err instanceof HttpError ? err.status : 400;
  return c.json({ error: err.message }, status as never);
});

app.route("/auth", authRoutes);
app.route("/api/chat", chatRoutes);

/* ---------------------------------------------------------------- session */

app.get("/api/me", (c) => {
  const user = c.get("user");
  return c.json({ user, devAuth: isDevAuth(c.env), discordAuth: isDiscordAuth(c.env) });
});

/* ----------------------------------------------------------------- tokens */

app.get("/api/tokens", async (c) => c.json(await registry(c.env).listTokens(requireUser(c).id)));

app.post("/api/tokens", async (c) => {
  const user = requireUser(c);
  const { label } = (await c.req.json().catch(() => ({}))) as { label?: string };
  const { id, token } = await issueToken(c.env, user.id, label || "mcp");
  return c.json({
    id,
    token,
    mcpUrl: `${appUrl(c.env, c.req.raw)}/mcp`,
    hint: "Store this now — it is not shown again.",
  });
});

app.delete("/api/tokens/:id", async (c) => {
  await registry(c.env).revokeToken(requireUser(c).id, c.req.param("id"));
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ plans */

async function roleOrThrow(
  c: { env: AppEnv; get: (k: "user") => User | null },
  planId: string,
  need: "view" | "edit" | "own"
): Promise<PlanRole> {
  const user = c.get("user");
  const role = await registry(c.env).roleFor(user?.id ?? null, planId);
  if (!role) throw new HttpError(user ? 404 : 401, "No such plan, or no access");
  if (need === "edit" && role === "viewer") throw new HttpError(403, "Viewer access only");
  if (need === "own" && role !== "owner") throw new HttpError(403, "Owner only");
  return role;
}

app.get("/api/plans", async (c) => c.json(await registry(c.env).listPlansForUser(requireUser(c).id)));

app.post("/api/plans", async (c) => {
  const user = requireUser(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    encounter?: string;
    withParty?: boolean;
  };
  const plan = createPlan({ name: body.name, encounter: body.encounter, ownerId: user.id });
  const stub = await planStub(c.env, plan.id);
  await stub.init({
    id: plan.id,
    name: body.name ?? "Untitled plan",
    encounter: body.encounter,
    ownerId: user.id,
    withParty: body.withParty ?? true,
  });
  await registry(c.env).registerPlan({
    id: plan.id,
    name: body.name ?? "Untitled plan",
    encounter: body.encounter,
    ownerId: user.id,
  });
  return c.json({ id: plan.id });
});

app.get("/api/plans/:id", async (c) => {
  const id = c.req.param("id");
  const role = await roleOrThrow(c, id, "view");
  const stub = await planStub(c.env, id);
  const plan = await stub.getPlan();
  const meta = await registry(c.env).getPlanMeta(id);
  return c.json({ plan, role, meta });
});

app.post("/api/plans/:id/ops", async (c) => {
  const id = c.req.param("id");
  await roleOrThrow(c, id, "edit");
  const body = (await c.req.json()) as { ops: Op | Op[] };
  const stub = await planStub(c.env, id);
  const res = await stub.apply(body.ops);
  await registry(c.env).touchPlan(id, { name: res.plan.name, encounter: res.plan.encounter });
  return c.json({ rev: res.plan.rev, values: res.values, plan: res.plan });
});

app.delete("/api/plans/:id", async (c) => {
  const id = c.req.param("id");
  await roleOrThrow(c, id, "own");
  const stub = await planStub(c.env, id);
  await stub.destroy();
  await registry(c.env).deletePlan(id);
  return c.json({ ok: true });
});

app.get("/api/plans/:id/collaborators", async (c) => {
  const id = c.req.param("id");
  await roleOrThrow(c, id, "view");
  return c.json(await registry(c.env).listCollaborators(id));
});

app.post("/api/plans/:id/share", async (c) => {
  const id = c.req.param("id");
  await roleOrThrow(c, id, "own");
  const { userId, role, remove } = (await c.req.json()) as {
    userId: string;
    role?: PlanRole;
    remove?: boolean;
  };
  if (remove) await registry(c.env).unshare(id, userId);
  else await registry(c.env).share(id, userId, role ?? "editor");
  return c.json({ ok: true });
});

app.post("/api/plans/:id/public", async (c) => {
  const id = c.req.param("id");
  await roleOrThrow(c, id, "own");
  const { isPublic } = (await c.req.json()) as { isPublic: boolean };
  await registry(c.env).setPublic(id, isPublic);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ admin */

app.get("/api/users", async (c) => {
  const user = requireUser(c);
  if (!user.admin) throw new HttpError(403, "Admins only");
  return c.json(await registry(c.env).listUsers());
});

app.patch("/api/users/:id", async (c) => {
  const user = requireUser(c);
  if (!user.admin) throw new HttpError(403, "Admins only");
  const flags = (await c.req.json()) as { admin?: boolean; chat?: boolean };
  return c.json(await registry(c.env).setUserFlags(c.req.param("id"), flags));
});

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

/* ------------------------------------------------------------------ entry */

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Remote MCP server. Authenticated with an `rp_` API token; the resulting
    // user identity is handed to the McpAgent as props.
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/") || url.pathname.startsWith("/sse")) {
      const { user } = await authenticate(request, env);
      if (!user) {
        return new Response(
          JSON.stringify({ error: "Unauthorized. Pass an API token: Authorization: Bearer rp_…" }),
          { status: 401, headers: { "content-type": "application/json", "www-authenticate": "Bearer" } }
        );
      }
      (ctx as ExecutionContext & { props: unknown }).props = {
        userId: user.id,
        userName: user.name,
        appUrl: appUrl(env, request),
      };
      const handler = url.pathname.startsWith("/sse")
        ? RaidPlanMCP.serveSSE("/sse", { binding: "RaidPlanMCP" })
        : RaidPlanMCP.serve("/mcp", { binding: "RaidPlanMCP" });
      return handler.fetch(request, env as never, ctx);
    }

    // WebSocket state sync for the editor (PlanAgent), served at /agents/plan-agent/:planId.
    // The ACL is enforced *here*, before the socket reaches the Durable Object: the
    // Agents SDK pushes the current state on connect, so closing the connection from
    // inside `onConnect` is already too late — the plan has been sent.
    if (url.pathname.startsWith("/agents/plan-agent/")) {
      const planId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const { user } = await authenticate(request, env);
      const role = await registry(env).roleFor(user?.id ?? null, planId);
      if (!role) return new Response("Not authorised for this plan", { status: 403 });
    }

    const routed = await routeAgentRequest(request, env as never);
    if (routed) return routed;

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      return app.fetch(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<AppEnv>;
