import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, appUrl } from "./env";
import { authenticate } from "./auth";
import { registry } from "./registry";
import { PLAN_PRIMER, TOOLS, TOOLS_BY_NAME, strictSchema, type ToolContext } from "./tools";
import { describePlan } from "../shared/ops";
import { planStub } from "./plan-agent";

/**
 * In-app chat: "put the tanks north and drop a donut on the boss".
 *
 * Talks to an OpenAI-compatible endpoint (Zhipu GLM by default) using the same
 * tool table as the MCP server, so the chat and an external model edit plans
 * through identical code. Gated on the per-user `chat` flag AND edit access to
 * the plan, so the shared API key is only reachable by people you've approved.
 */

const DEFAULT_BASE = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_MODEL = "glm-4.6";
const MAX_ROUNDS = 8;

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

/** Tool table → OpenAI function-calling schema. */
function toolSpecs() {
  return TOOLS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(strictSchema(t) as unknown as z.ZodType, {
        io: "input",
        target: "draft-7",
      }),
    },
  }));
}

export const chatRoutes = new Hono<{ Bindings: AppEnv }>();

chatRoutes.get("/config", async (c) => {
  const { user } = await authenticate(c.req.raw, c.env);
  return c.json({
    enabled: !!c.env.GLM_API_KEY,
    allowed: !!user?.chat,
    model: c.env.GLM_MODEL ?? DEFAULT_MODEL,
  });
});

chatRoutes.post("/:planId", async (c) => {
  const { user } = await authenticate(c.req.raw, c.env);
  if (!user) return c.json({ error: "Sign in first" }, 401);
  if (!user.chat && !user.admin) return c.json({ error: "Your account is not approved for chat" }, 403);
  if (!c.env.GLM_API_KEY) return c.json({ error: "No model API key configured (set GLM_API_KEY)" }, 501);

  const planId = c.req.param("planId");
  const role = await registry(c.env).roleFor(user.id, planId);
  if (!role || role === "viewer") return c.json({ error: "You cannot edit this plan" }, 403);

  const body = (await c.req.json()) as { messages: { role: "user" | "assistant"; content: string }[]; step?: string };
  const ctx: ToolContext = { env: c.env, userId: user.id, appUrl: appUrl(c.env, c.req.raw) };

  const stub = await planStub(c.env, planId);
  const plan = await stub.getPlan();

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `You are a raid-plan editor. ${PLAN_PRIMER}\n\n` +
        `You are working on plan ${planId}. Pass plan_id="${planId}" to every tool.\n` +
        `The user is looking at this plan right now; edits appear on their canvas instantly.\n` +
        `Be decisive: make the edits, then reply in one or two short sentences saying what you changed.\n\n` +
        `Current state:\n${describePlan(plan, undefined)}`,
    },
    ...body.messages.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
  ];

  const base = (c.env.GLM_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
  const model = c.env.GLM_MODEL ?? DEFAULT_MODEL;
  const trace: { tool: string; args: unknown; result: string }[] = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${c.env.GLM_API_KEY}` },
      body: JSON.stringify({ model, messages, tools: toolSpecs(), tool_choice: "auto", temperature: 0.3 }),
    });
    if (!res.ok) return c.json({ error: `Model call failed (${res.status}): ${await res.text()}` }, 502);

    const data = (await res.json()) as { choices: { message: ChatMessage }[] };
    const message = data.choices?.[0]?.message;
    if (!message) return c.json({ error: "Empty response from model" }, 502);
    messages.push(message);

    const calls = message.tool_calls ?? [];
    if (!calls.length) {
      const after = await stub.getPlan();
      return c.json({ reply: message.content ?? "", trace, rev: after.rev });
    }

    for (const call of calls) {
      const tool = TOOLS_BY_NAME.get(call.function.name);
      let result: string;
      try {
        if (!tool) throw new Error(`Unknown tool ${call.function.name}`);
        const args = JSON.parse(call.function.arguments || "{}");
        // Never let the model wander to another plan mid-conversation.
        if ("plan_id" in args) args.plan_id = planId;
        const parsed = (strictSchema(tool) as unknown as z.ZodType).parse(args);
        result = await tool.run(ctx, parsed as never);
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
      }
      trace.push({ tool: call.function.name, args: call.function.arguments, result });
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
    }
  }

  const after = await stub.getPlan();
  return c.json({ reply: "Stopped after too many tool rounds.", trace, rev: after.rev }, 200);
});
