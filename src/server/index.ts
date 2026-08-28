import { Hono } from "hono";
import { routeAgentRequest } from "agents";
import { type AppEnv, appUrl, isDevAuth, isDiscordAuth } from "./env";
import { authRoutes, authenticate, issueToken } from "./auth";
import { registry } from "./registry";
import { planStub } from "./plan-agent";
import { RaidPlanMCP } from "./mcp";
import { chatRoutes } from "./chat";
import { createPlan, encounterSetup, newId } from "../shared/ops";
import { parsePublicOpsRequest, validatePublicOps } from "../shared/op-schema";
import { convertLegacyPlan } from "../shared/beat-variant-conversion";
import { guardVariants } from "./variants";
import type { PlanRole, User } from "../shared/schema";
import type { HistoryActor } from "../shared/history";
import { BackgroundUploadError, serveBackground, uploadBackground } from "./backgrounds";
import { dumpFFLogsDebuffs } from "./fflogs";
import { exchangeFFLogsAuthorizationCode } from "./fflogs-oauth";

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

function historyActor(user: User, sessionId?: string, source: HistoryActor["source"] = "editor"): HistoryActor {
  return { actorId: user.id, actorName: user.name, sessionId: sessionId?.slice(0, 128), source };
}

async function sha256(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

app.onError((err, c) => {
  const status = err instanceof HttpError ? err.status : 400;
  return c.json({ error: err.message }, status as never);
});

app.route("/auth", authRoutes);
app.route("/api/chat", chatRoutes);

app.post("/api/fflogs/debuffs", async (c) => {
  requireUser(c);
  const { url } = (await c.req.json().catch(() => ({}))) as { url?: string };
  if (!url) throw new HttpError(400, "Enter an FF Logs report URL");
  return c.json(await dumpFFLogsDebuffs(url, c.env));
});

app.get("/api/fflogs/config", (c) => {
  requireUser(c);
  if (!c.env.FFLOGS_CLIENT_ID) throw new HttpError(503, "FF Logs integration is not configured on this server");
  return c.json({
    clientId: c.env.FFLOGS_CLIENT_ID,
    redirectUrl: `${appUrl(c.env, c.req.raw)}/fflogs`,
    authorizeUrl: "https://www.fflogs.com/oauth/authorize",
    userApiUrl: "https://www.fflogs.com/api/v2/user",
  });
});

app.post("/api/fflogs/exchange", async (c) => {
  requireUser(c);
  const { code } = (await c.req.json().catch(() => ({}))) as { code?: string };
  if (!code) throw new HttpError(400, "FF Logs authorization code is missing");
  const redirectUri = `${appUrl(c.env, c.req.raw)}/fflogs`;
  return c.json(await exchangeFFLogsAuthorizationCode(code, redirectUri, c.env));
});

/* ---------------------------------------------------------------- session */

app.get("/api/me", (c) => {
  const user = c.get("user");
  return c.json({ user, devAuth: isDevAuth(c.env), discordAuth: isDiscordAuth(c.env) });
});

/* ---------------------------------------------------------- backgrounds */

app.post("/api/backgrounds", async (c) => {
  const user = requireUser(c);
  try {
    return c.json(await uploadBackground(c.req.raw, c.env, user.id), 201);
  } catch (error) {
    if (error instanceof BackgroundUploadError) throw new HttpError(error.status, error.message);
    throw error;
  }
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
    variantModel?: "beat";
  };
  const plan = createPlan({ name: body.name, encounter: body.encounter, ownerId: user.id, variantModel: body.variantModel });
  const stub = await planStub(c.env, plan.id);
  await stub.init({
    id: plan.id,
    name: body.name ?? "Untitled plan",
    encounter: body.encounter,
    ownerId: user.id,
    withParty: body.withParty ?? true,
    variantModel: body.variantModel,
  });
  await registry(c.env).registerPlan({
    id: plan.id,
    name: body.name ?? "Untitled plan",
    encounter: body.encounter,
    ownerId: user.id,
  });
  // Every plan for a fight you have already set up starts on the same floor.
  const saved = body.encounter ? await registry(c.env).getEncounter(user.id, body.encounter) : null;
  if (saved) await stub.apply({ op: "apply_encounter", setup: saved });
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
  const role = await roleOrThrow(c, id, "edit");
  const raw = await c.req.json().catch(() => {
    throw new HttpError(400, "The operation body must be valid JSON");
  });
  let body: ReturnType<typeof parsePublicOpsRequest>;
  try {
    body = parsePublicOpsRequest(raw);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid operation payload");
  }
  const stub = await planStub(c.env, id);
  // Somebody else's reading of the fight is theirs, even from an editor's hands.
  const user = requireUser(c);
  let res: Awaited<ReturnType<typeof stub.apply>> | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await stub.getPlan();
    try {
      validatePublicOps(current, body.ops);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "Invalid operation");
    }
    const ops = guardVariants(
      current,
      body.ops,
      { id: user.id, name: user.name },
      role,
      (m) => new HttpError(403, m)
    );
    const candidate = await stub.apply(ops, historyActor(user, body.sessionId), current.rev);
    if (!candidate.conflict) {
      res = candidate;
      break;
    }
  }
  if (!res) throw new HttpError(409, "The plan kept changing; try that edit again");
  await registry(c.env).touchPlan(id, { name: res.plan.name, encounter: res.plan.encounter });
  return c.json({
    rev: res.plan.rev,
    values: res.values,
    plan: res.plan,
    history: await stub.history(),
  });
});

app.get("/api/plans/:id/history", async (c) => {
  const id = c.req.param("id");
  await roleOrThrow(c, id, "view");
  return c.json(await (await planStub(c.env, id)).history());
});

app.post("/api/plans/:id/history/undo", async (c) => {
  const id = c.req.param("id");
  await roleOrThrow(c, id, "own");
  const result = await (await planStub(c.env, id)).undo();
  await registry(c.env).touchPlan(id, { name: result.plan.name, encounter: result.plan.encounter });
  return c.json(result);
});

app.post("/api/plans/:id/history/redo", async (c) => {
  const id = c.req.param("id");
  await roleOrThrow(c, id, "own");
  const result = await (await planStub(c.env, id)).redo();
  await registry(c.env).touchPlan(id, { name: result.plan.name, encounter: result.plan.encounter });
  return c.json(result);
});

app.post("/api/plans/:id/history/revert", async (c) => {
  const id = c.req.param("id");
  await roleOrThrow(c, id, "own");
  const user = requireUser(c);
  const body = (await c.req.json()) as { revisionId?: string; sessionId?: string };
  if (!body.revisionId) throw new HttpError(400, "Choose a revision to restore");
  const result = await (await planStub(c.env, id)).revert(
    body.revisionId,
    historyActor(user, body.sessionId)
  );
  await registry(c.env).touchPlan(id, { name: result.plan.name, encounter: result.plan.encounter });
  return c.json(result);
});

/* The decided floor of a fight: its arena and waymarks, shared by every plan
   for that encounter. Saved per user, so two statics can disagree. */

app.get("/api/encounters", async (c) =>
  c.json(await registry(c.env).listEncounters(requireUser(c).id))
);

app.post("/api/plans/:id/encounter/save", async (c) => {
  const id = c.req.param("id");
  await roleOrThrow(c, id, "edit");
  const plan = await (await planStub(c.env, id)).getPlan();
  if (!plan.encounter) return c.json({ error: "Give the plan an encounter name first" }, 400);
  const setup = encounterSetup(plan);
  await registry(c.env).saveEncounter(requireUser(c).id, plan.encounter, setup);
  return c.json({ encounter: plan.encounter, markers: setup.markers.length });
});

app.post("/api/plans/:id/encounter/apply", async (c) => {
  const id = c.req.param("id");
  await roleOrThrow(c, id, "edit");
  const stub = await planStub(c.env, id);
  const plan = await stub.getPlan();
  const setup = plan.encounter
    ? await registry(c.env).getEncounter(requireUser(c).id, plan.encounter)
    : null;
  if (!setup) return c.json({ error: `Nothing saved for "${plan.encounter || "this encounter"}"` }, 404);
  const user = requireUser(c);
  const res = await stub.apply(
    { op: "apply_encounter", setup },
    historyActor(user, undefined, "editor")
  );
  return c.json({ rev: res.plan.rev, plan: res.plan });
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

/**
 * Take a whole plan document in, over an existing plan you own: how a fight
 * built on one instance gets to another. The document decides what is drawn;
 * this instance keeps the plan's id, its owner and who it is shared with.
 */
app.post("/api/plans/:id/import", async (c) => {
  const id = c.req.param("id");
  await roleOrThrow(c, id, "own");
  const body = (await c.req.json()) as { plan?: unknown };
  const stub = await planStub(c.env, id);
  const user = requireUser(c);
  const plan = await stub.replace(
    body.plan ?? body,
    { id, ownerId: user.id },
    historyActor(user, undefined, "editor")
  );
  await registry(c.env).registerPlan({
    id,
    name: plan.name,
    encounter: plan.encounter,
    ownerId: plan.ownerId,
  });
  return c.json({ ok: true, name: plan.name, steps: plan.steps.length });
});

/**
 * Report exactly what a legacy Mechanic-wide Variant conversion would create.
 * The source remains untouched, and the checksum identifies the precise
 * document revision that was inspected.
 */
app.post("/api/plans/:id/beat-variants/dry-run", async (c) => {
  const id = c.req.param("id");
  await roleOrThrow(c, id, "own");
  const source = await (await planStub(c.env, id)).getPlan();
  const payload = JSON.stringify(source);
  const checksum = await sha256(payload);
  return c.json({ checksum, report: convertLegacyPlan(source).report });
});

app.get("/api/plans/:id/beat-variants/conversion-archive", async (c) => {
  const id = c.req.param("id");
  await roleOrThrow(c, id, "own");
  const archive = await (await planStub(c.env, id)).getConversionArchive();
  if (!archive) throw new HttpError(404, "This plan has no legacy conversion archive");
  return c.json({ archive });
});

/**
 * Owner-only, lossless conversion into a fresh document. The old plan is
 * never mutated. Registration happens only after the complete converted copy
 * and its immutable source archive have been installed in the new PlanAgent.
 */
app.post("/api/plans/:id/beat-variants/convert-to-copy", async (c) => {
  const id = c.req.param("id");
  await roleOrThrow(c, id, "own");
  const user = requireUser(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    expectedRev?: number;
    expectedChecksum?: string;
  };
  const source = await (await planStub(c.env, id)).getPlan();
  if (body.expectedRev !== undefined && body.expectedRev !== source.rev)
    throw new HttpError(409, `The source changed from rev ${body.expectedRev} to rev ${source.rev}; run the report again`);
  const payload = JSON.stringify(source);
  const checksum = await sha256(payload);
  if (body.expectedChecksum && body.expectedChecksum !== checksum)
    throw new HttpError(409, "The source changed since the conversion report; run the report again");

  const copyId = newId("plan");
  const converted = convertLegacyPlan(source, {
    id: copyId,
    ownerId: user.id,
    archive: { payload, sha256: checksum, convertedAt: Date.now() },
  });
  if (!converted.plan)
    return c.json({ error: "This plan cannot be converted losslessly", checksum, report: converted.report }, 409);

  const copy = await planStub(c.env, copyId);
  await copy.init({
    id: copyId,
    name: converted.plan.name,
    encounter: converted.plan.encounter,
    ownerId: user.id,
    withParty: false,
    variantModel: "beat",
  });
  const plan = await copy.replaceConverted(
    converted.plan,
    { id: copyId, ownerId: user.id },
    {
      sourcePlanId: source.id,
      sourceRev: source.rev,
      payload,
      sha256: checksum,
      convertedAt: converted.plan.conversionArchive!.convertedAt,
    },
    historyActor(user, undefined, "migration")
  );
  await registry(c.env).registerPlan({
    id: copyId,
    name: plan.name,
    encounter: plan.encounter,
    ownerId: user.id,
  });
  return c.json({
    id: copyId,
    sourceId: id,
    sourceRev: source.rev,
    checksum,
    report: converted.report,
  }, 201);
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

    if (request.method === "GET" && url.pathname.startsWith("/backgrounds/")) {
      return serveBackground(request, env, ctx);
    }

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
