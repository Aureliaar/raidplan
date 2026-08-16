import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { AppEnv } from "./env";
import { registry } from "./registry";
import { PLAN_PRIMER, TOOLS, type ToolContext } from "./tools";

/**
 * The remote MCP server: every tool in `TOOLS`, scoped to the user whose API
 * token opened the connection. Mounted at /mcp (streamable HTTP) and /sse.
 */

export interface McpProps extends Record<string, unknown> {
  userId: string;
  userName: string;
  appUrl: string;
}

export class RaidPlanMCP extends McpAgent<AppEnv, never, McpProps> {
  server = new McpServer(
    { name: "raidplan", version: "0.1.0" },
    { instructions: PLAN_PRIMER }
  );

  private get toolContext(): ToolContext {
    const props = this.props as McpProps | undefined;
    if (!props?.userId) throw new Error("MCP connection has no authenticated user");
    return { env: this.env, userId: props.userId, appUrl: props.appUrl };
  }

  async init() {
    for (const tool of TOOLS) {
      this.server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.schema },
        async (args: unknown) => ({
          content: [{ type: "text" as const, text: await tool.run(this.toolContext, args as never) }],
        })
      );
    }

    this.server.registerResource(
      "plans",
      "raidplan://plans",
      { description: "Every plan you can access, as JSON", mimeType: "application/json" },
      async (uri) => {
        const plans = await registry(this.env).listPlansForUser(this.toolContext.userId);
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(plans, null, 2) }],
        };
      }
    );
  }
}
