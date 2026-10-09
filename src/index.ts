#!/usr/bin/env node
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AppsScriptClient } from "./api-client.js";
import { tools } from "./tools.js";
import { createServer } from "./server.js";
import { requestIdentity } from "./auth.js";
import {
  brokerConfigured,
  brokerBaseUrl,
  brokerClientNamespace,
  brokerProvider,
  resolveCredential,
} from "./broker-client.js";
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8mb" }));
const writesEnabled = process.env.APPS_SCRIPT_ENABLE_WRITES === "true";
app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    server: "appsscript-mcp-http",
    version: "3.0.0",
    tools: tools.length,
    transport: "streamable-http",
    authModel: "broker-first",
    brokerConfigured,
    brokerBaseUrl,
    brokerProvider,
    clientNamespace: brokerClientNamespace || null,
    principalHeader: "x-broker-principal",
    principalSignatureRequired: true,
    signedPrincipalConfigured: !!process.env.BROKER_PRINCIPAL_HMAC_KEY,
    standaloneCallerKeySupported: true,
    writesEnabled,
    liveProviderVerified: false,
  }),
);
app.get("/", (_req, res) =>
  res.json({
    name: "Google Apps Script MCP",
    version: "3.0.0",
    mcpEndpoint: "/mcp",
    tools: tools.length,
    documentation: "https://financemcps.agenticledger.ai/appsscript/",
    auth: {
      provider: brokerProvider,
      model: "broker-first",
      alternatives: [
        "Per-request Google OAuth Bearer",
        "Signed broker principal",
        "Private persistent X-MCP-Caller-Key (32 random bytes, base64url)",
      ],
    },
  }),
);
app.post("/mcp", async (req, res) => {
  if (!brokerConfigured) {
    res
      .status(503)
      .json({ error: "Broker install identity is not configured" });
    return;
  }
  let identity: ReturnType<typeof requestIdentity>;
  try {
    identity = requestIdentity(req);
  } catch (error) {
    res.status(401).json({
      error: error instanceof Error ? error.message : "Invalid caller identity",
    });
    return;
  }
  const server = createServer(async () => {
    if (identity.kind === "none")
      return {
        status: "identity_required",
        provider: brokerProvider,
        message:
          "Provide a Google OAuth Bearer, a gateway-signed broker principal, or a private persistent X-MCP-Caller-Key (32 random bytes encoded as base64url). Anonymous callers cannot share a broker account.",
      };
    const credential =
      identity.kind === "bearer"
        ? identity.token
        : await resolveCredential(identity.principal, identity.account);
    if (typeof credential !== "string") return credential;
    return new AppsScriptClient(credential, { writesEnabled });
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
  }
});
app.all("/mcp", (_req, res) => {
  res.set("Allow", "POST");
  res.status(405).json({ error: "Use stateless StreamableHTTP POST" });
});
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 413
        ? 413
        : 400;
    res.status(status).json({ error: "Invalid or oversized JSON request" });
  },
);
app.listen(Number(process.env.PORT ?? 3100), () =>
  console.log("Apps Script REST MCP v3.0.0 listening"),
);
