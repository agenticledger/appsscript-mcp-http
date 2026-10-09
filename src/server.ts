import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AppsScriptClient, ApiError } from "./api-client.js";
import { tools, executeTool } from "./tools.js";
export type Resolution =
  | AppsScriptClient
  | { status: string; provider: string; connectUrl?: string; message: string };
export function createServer(resolve: () => Promise<Resolution>): Server {
  const server = new Server(
    { name: "appsscript-mcp", version: "3.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema) as { type: "object" },
      annotations: {
        readOnlyHint: !t.write,
        destructiveHint: t.write,
        idempotentHint: !t.write,
        openWorldHint: true,
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const tool = tools.find((t) => t.name === request.params.name);
      if (
        !tool ||
        !tool.inputSchema.safeParse(request.params.arguments ?? {}).success
      )
        throw new ApiError(
          "invalid_input",
          "Unknown tool or invalid arguments; check the published input schema",
        );
      const client = await resolve();
      if (!(client instanceof AppsScriptClient))
        return {
          content: [{ type: "text" as const, text: JSON.stringify(client) }],
          structuredContent: client,
        };
      const data = await executeTool(
        client,
        request.params.name,
        request.params.arguments,
      );
      const executionError =
        tool.name === "script_run" &&
        !!data &&
        typeof data === "object" &&
        "error" in data;
      const result = { mode: client.mode, data };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
        ...(executionError ? { isError: true } : {}),
      };
    } catch (error) {
      const result = {
        status: "error",
        code: error instanceof ApiError ? error.code : "invalid_input",
        message:
          error instanceof ApiError
            ? error.message
            : "Tool call rejected; check inputs and explicit write confirmations",
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
        isError: true,
      };
    }
  });
  return server;
}
