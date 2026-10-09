import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import type { Request } from "express";
import { requestIdentity } from "../src/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const req = (headers: Request["headers"]) => ({ headers });
test("per-request Bearer auth, signed principal isolation, no shared default", () => {
  assert.deepEqual(requestIdentity(req({})), { kind: "none" });
  assert.deepEqual(
    requestIdentity(req({ authorization: "Bearer test-token" })),
    { kind: "bearer", token: "test-token" },
  );
  assert.throws(() => requestIdentity(req({ authorization: "Basic nope" })));
  assert.throws(() =>
    requestIdentity(req({ "x-broker-principal": "tenant:alice" }), ""),
  );
  const key = "offline-hmac-key";
  const principal = "tenant:alice";
  const sig = createHmac("sha256", key).update(principal).digest("base64url");
  assert.deepEqual(
    requestIdentity(
      req({ "x-broker-principal": principal, "x-broker-principal-sig": sig }),
      key,
    ),
    { kind: "broker", principal, account: "" },
  );
  assert.throws(() =>
    requestIdentity(
      req({
        "x-broker-principal": "tenant:bob",
        "x-broker-principal-sig": sig,
      }),
      key,
    ),
  );
  const alice = requestIdentity(req({ "x-mcp-caller-key": "a".repeat(43) }));
  const bob = requestIdentity(req({ "x-mcp-caller-key": "b".repeat(43) }));
  assert.notDeepEqual(alice, bob);
  assert(!JSON.stringify(alice).includes("a".repeat(43)));
  assert.throws(() =>
    requestIdentity(req({ "x-mcp-caller-key": "tenant:alice" })),
  );
});
test("HTTP initialize/list, stateless call, anonymous isolation, writes disabled and OAuth 404", async () => {
  const port = String(39000 + Math.floor(Math.random() * 1000));
  const child = spawn(process.execPath, ["dist/index.js"], {
    env: {
      PATH: process.env.PATH,
      PORT: port,
      BROKER_INSTALL_BEARER: "mock-install",
      BROKER_JWT_KEY: "mock-jwt",
      BROKER_CLIENT_NAMESPACE: "offline-tests",
      APPS_SCRIPT_ENABLE_WRITES: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
  const client = new Client({ name: "offline-http-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(endpoint);
  try {
    await Promise.race([
      once(child.stdout!, "data"),
      once(child, "exit").then(() => {
        throw new Error("Server exited");
      }),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error("Startup timeout")), 10000);
        t.unref();
      }),
    ]);
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 17);
    assert.equal(transport.sessionId, undefined);
    const result = await client.callTool({
      name: "project_get",
      arguments: { scriptId: "scratch" },
    });
    assert.equal(result.structuredContent?.status, "identity_required");
    assert.equal(result.isError, undefined);
    const bad = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-broker-principal": "victim",
      },
      body: "{}",
    });
    assert.equal(bad.status, 401);
    const health = (await (
      await fetch(new URL("/health", endpoint))
    ).json()) as { brokerConfigured: boolean; writesEnabled: boolean };
    assert.equal(health.brokerConfigured, true);
    assert.equal(health.writesEnabled, false);
    assert.equal(
      (
        await fetch(
          new URL("/.well-known/oauth-authorization-server", endpoint),
        )
      ).status,
      404,
    );
    const raw = new Client({ name: "raw-test", version: "1" });
    try {
      await raw.connect(
        new StreamableHTTPClientTransport(endpoint, {
          requestInit: { headers: { Authorization: "Bearer mock-token" } },
        }),
      );
      const denied = await raw.callTool({
        name: "version_create",
        arguments: { scriptId: "scratch" },
      });
      assert.equal(denied.structuredContent?.code, "writes_disabled");
    } finally {
      await raw.close();
    }
  } finally {
    await client.close();
    child.kill();
    await once(child, "exit");
  }
});
