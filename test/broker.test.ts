import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
process.env.BROKER_INSTALL_BEARER = "mock-install-bearer";
process.env.BROKER_JWT_KEY = "mock-jwt-key";
process.env.BROKER_CLIENT_NAMESPACE = "offline-tests";
const { resolveCredential } = await import("../src/broker-client.js");
test("broker signs per-agent identity, sends provider/account and returns connect URL on 404", async () => {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async (url, init) => {
    count++;
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer mock-install-bearer");
    const token = jwt.verify(
      headers["X-Broker-Token"],
      "mock-jwt-key",
    ) as jwt.JwtPayload;
    assert.equal(token.principal, "tenant:agent");
    assert.equal(token.clientNamespace, "offline-tests");
    assert.equal(token.exp! - token.iat!, 60);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      provider: "google-appsscript",
      account: "scratch",
    });
    return String(url).endsWith("/token")
      ? new Response("", { status: 404 })
      : Response.json({
          authorizeUrl: "https://accounts.google.com/mock-consent",
        });
  };
  try {
    const result = await resolveCredential("tenant:agent", "scratch");
    assert.equal(typeof result, "object");
    assert.equal(
      typeof result === "object" && result.status,
      "connection_required",
    );
    assert.equal(count, 2);
  } finally {
    globalThis.fetch = original;
  }
});
test("broker errors never echo raw error bodies", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("mock-install-bearer", { status: 500 });
  try {
    await assert.rejects(
      () => resolveCredential("tenant:agent"),
      (e: unknown) =>
        e instanceof Error && !e.message.includes("mock-install-bearer"),
    );
  } finally {
    globalThis.fetch = original;
  }
});
