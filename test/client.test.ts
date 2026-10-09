import test from "node:test";
import assert from "node:assert/strict";
import { AppsScriptClient, ApiError, MAX_BYTES } from "../src/api-client.js";
import { tools, executeTool } from "../src/tools.js";
import { mockFetch } from "../src/mock.js";
const fixture = [
  { name: "appsscript", type: "JSON", source: "{}" },
  { name: "Code", type: "SERVER_JS", source: "old" },
  { name: "Page", type: "HTML", source: "<h1>keep</h1>" },
];
function clientWith(f: typeof fetch, writesEnabled = true) {
  return new AppsScriptClient("test-secret-must-not-leak", {
    fetch: f,
    writesEnabled,
  });
}
test("all 17 documented examples execute against synthetic fixtures", async () => {
  const c = new AppsScriptClient("mock", {
    fetch: mockFetch,
    mock: true,
    writesEnabled: true,
  });
  assert.equal(tools.length, 17);
  for (const t of tools) {
    assert.equal(t.inputSchema.safeParse(t.example).success, true, t.name);
    await executeTool(c, t.name, t.example);
  }
});
test("script processes uses official colon route and repeated filter query", async () => {
  const c = clientWith(async (url, init) => {
    const u = new URL(String(url));
    assert.equal(u.pathname, "/v1/processes:listScriptProcesses");
    assert.equal(u.searchParams.get("scriptId"), "s_1");
    assert.deepEqual(u.searchParams.getAll("scriptProcessFilter.statuses"), [
      "FAILED",
      "TIMED_OUT",
    ]);
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer test-secret-must-not-leak",
    );
    return Response.json({ processes: [], nextPageToken: "next" });
  });
  assert.deepEqual(
    await executeTool(c, "script_processes_list", {
      scriptId: "s_1",
      filter: { statuses: ["FAILED", "TIMED_OUT"] },
    }),
    { processes: [], nextPageToken: "next" },
  );
});
test("upsert preserves omitted files and strips output-only properties", async () => {
  let put: unknown;
  const c = clientWith(async (_url, init) => {
    if (init?.method === "GET")
      return Response.json({
        files: fixture.map((f) => ({ ...f, lastModifyUser: { name: "Mock" } })),
      });
    put = JSON.parse(String(init?.body));
    return Response.json(put);
  });
  await executeTool(c, "content_update", {
    scriptId: "s",
    files: [{ name: "Code", type: "SERVER_JS", source: "new" }],
  });
  assert.deepEqual(put, {
    files: fixture.map((f) =>
      f.name === "Code" ? { ...f, source: "new" } : f,
    ),
  });
});
test("replace needs explicit confirmation and valid manifest; never fetches on rejection", async () => {
  let calls = 0;
  const c = clientWith(async () => {
    calls++;
    return Response.json({});
  });
  await assert.rejects(
    () =>
      executeTool(c, "content_update", {
        scriptId: "s",
        files: fixture,
        mode: "replace",
      }),
    /confirmReplace/,
  );
  await assert.rejects(
    () =>
      executeTool(c, "content_update", {
        scriptId: "s",
        files: [fixture[1]],
        mode: "replace",
        confirmReplace: true,
      }),
    /appsscript/,
  );
  assert.equal(calls, 0);
});
test("replace sends exactly the supplied files; legacy JSON input validated", async () => {
  let calls = 0;
  const c = clientWith(async (_url, init) => {
    calls++;
    assert.equal(init?.method, "PUT");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      files: fixture.slice(0, 2),
    });
    return Response.json({ files: fixture.slice(0, 2) });
  });
  await executeTool(c, "content_update", {
    scriptId: "s",
    files: JSON.stringify(fixture.slice(0, 2)),
    mode: "replace",
    confirmReplace: true,
  });
  assert.equal(calls, 1);
});
test("stale content hash blocks PUT", async () => {
  const c = clientWith(async (_url, init) => {
    assert.equal(init?.method, "GET");
    return Response.json({ files: fixture });
  });
  await assert.rejects(
    () =>
      executeTool(c, "content_update", {
        scriptId: "s",
        files: [fixture[1]],
        expectedContentHash: "0".repeat(64),
      }),
    /HEAD changed/,
  );
});
test("deployment update keeps same route and preserves manifest/description", async () => {
  let count = 0;
  const c = clientWith(async (url, init) => {
    assert.equal(new URL(String(url)).pathname, "/v1/projects/s/deployments/d");
    count++;
    if (init?.method === "GET")
      return Response.json({
        deploymentConfig: { manifestFileName: "custom", description: "keep" },
      });
    assert.deepEqual(JSON.parse(String(init?.body)), {
      deploymentConfig: {
        scriptId: "s",
        versionNumber: 2,
        description: "keep",
        manifestFileName: "custom",
      },
    });
    return Response.json({ deploymentId: "d" });
  });
  await executeTool(c, "deployment_update", {
    scriptId: "s",
    deploymentId: "d",
    versionNumber: 2,
  });
  assert.equal(count, 2);
});
test("Drive search quotes query values and fixes host/mimeType", async () => {
  const c = clientWith(async (url) => {
    const u = new URL(String(url));
    assert.equal(u.origin, "https://www.googleapis.com");
    assert.equal(u.pathname, "/drive/v3/files");
    assert.equal(
      u.searchParams.get("q"),
      "trashed = false and mimeType = 'application/vnd.google-apps.script' and name contains 'x\\\' or trashed = true'",
    );
    return Response.json({ files: [] });
  });
  await executeTool(c, "projects_search", {
    nameContains: "x' or trashed = true",
  });
});
test("version and page query values remain bounded, opaque page token encoded", async () => {
  const c = clientWith(async (url) => {
    const u = new URL(String(url));
    assert.equal(u.searchParams.get("pageToken"), "a&b=?");
    assert.equal(u.searchParams.size, 2);
    return Response.json({ versions: [] });
  });
  await executeTool(c, "versions_list", {
    scriptId: "s",
    pageSize: 100,
    pageToken: "a&b=?",
  });
  for (const args of [
    { scriptId: "s", pageSize: 101 },
    { scriptId: "s", pageSize: 1.5 },
    { scriptId: "s", pageSize: -1 },
  ])
    await assert.rejects(() => executeTool(c, "versions_list", args));
});
test("all writes default off and reject before any provider request", async () => {
  const c = new AppsScriptClient("mock", {
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  for (const tool of tools.filter((t) => t.write))
    await assert.rejects(
      () => executeTool(c, tool.name, tool.example),
      /disabled/,
    );
});
test("reject traversal, arbitrary hosts, duplicate files, unsafe schemas and unknown filters", async () => {
  const c = clientWith(async () => {
    throw new Error("must not fetch");
  });
  for (const scriptId of [
    "../x",
    "https://evil.test",
    "x/y",
    "x?z=2",
    "%2e%2e",
  ])
    await assert.rejects(() => executeTool(c, "project_get", { scriptId }));
  await assert.rejects(() => c.request("https://evil.test"));
  await assert.rejects(() => c.request("/projects/../s"));
  await assert.rejects(() =>
    executeTool(c, "content_update", {
      scriptId: "s",
      files: [fixture[0], fixture[0]],
    }),
  );
  await assert.rejects(() =>
    executeTool(c, "content_update", {
      scriptId: "s",
      files: '{"not":"an array"}',
    }),
  );
  await assert.rejects(() =>
    executeTool(c, "processes_list", { filter: { url: "https://evil.test" } }),
  );
  await assert.rejects(() =>
    executeTool(c, "project_get", { scriptId: "s", accessToken: "never" }),
  );
  await assert.rejects(() =>
    executeTool(c, "content_update", {
      scriptId: "s",
      files: [{ name: "../bad", type: "SERVER_JS", source: "" }],
    }),
  );
});
for (const code of [400, 401, 403, 404, 409, 429, 500])
  test(`HTTP ${code} normalized without leaking upstream body`, async () => {
    let calls = 0;
    const c = clientWith(async () => {
      calls++;
      return new Response("Authorization: Bearer test-secret-must-not-leak", {
        status: code,
      });
    });
    await assert.rejects(
      () => c.request("/projects/s"),
      (e: unknown) =>
        e instanceof ApiError &&
        e.status === code &&
        !e.message.includes("test-secret"),
    );
    assert.equal(calls, code === 429 ? 3 : 1);
  });
for (const code of [200, 201, 204])
  test(`HTTP ${code} parsed`, async () => {
    const c = clientWith(
      async () =>
        new Response(code === 204 ? null : '{"ok":true}', { status: code }),
    );
    assert.deepEqual(
      await c.request("/projects/s"),
      code === 204 ? {} : { ok: true },
    );
  });
test("transient read retries; write does not retry", async () => {
  let calls = 0;
  const c = clientWith(async () =>
    ++calls < 3
      ? new Response("", { status: 503 })
      : Response.json({ ok: true }),
  );
  await c.request("/projects/s");
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(() =>
    c.request("/projects", "POST", { title: "Scratch" }),
  );
  assert.equal(calls, 1);
});
test("malformed JSON and unavailable transport are normalized and redacted", async () => {
  await assert.rejects(
    () =>
      clientWith(async () => new Response("not JSON")).request("/projects/s"),
    /malformed JSON/,
  );
  await assert.rejects(
    () =>
      clientWith(async () => {
        throw new Error("DNS test-secret-must-not-leak");
      }).request("/projects/s"),
    (e: unknown) =>
      e instanceof ApiError &&
      e.code === "transport_error" &&
      !e.message.includes("test-secret"),
  );
});
test("timeout aborts fetch and does not leak request data", async () => {
  const c = new AppsScriptClient("mock", {
    timeoutMs: 10,
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      ),
  });
  await assert.rejects(
    () => c.request("/projects/s"),
    (e: unknown) => e instanceof ApiError && e.code === "timeout",
  );
});
test("oversized request and response rejected", async () => {
  let calls = 0;
  const c = clientWith(async () => {
    calls++;
    return new Response("x".repeat(MAX_BYTES + 1));
  });
  await assert.rejects(
    () => c.request("/projects", "POST", { source: "x".repeat(MAX_BYTES) }),
    /8 MiB/,
  );
  assert.equal(calls, 0);
  await assert.rejects(() => c.request("/projects/s"), /8 MiB/);
});

test("upsert never drops same-basename files of different types", async () => {
  const originals = [
    ...fixture,
    { name: "Code", type: "HTML", source: "keep html" },
  ];
  let result: unknown;
  const c = clientWith(async (_url, init) => {
    if (init?.method === "GET") return Response.json({ files: originals });
    result = JSON.parse(String(init?.body));
    return Response.json(result);
  });
  await executeTool(c, "content_update", {
    scriptId: "s",
    files: [{ name: "Code", type: "SERVER_JS", source: "new" }],
  });
  assert.deepEqual(result, {
    files: originals.map((f) =>
      f.name === "Code" && f.type === "SERVER_JS" ? { ...f, source: "new" } : f,
    ),
  });
});

test("scripts.run uses API-executable deployment ID and supports qualified function names", async () => {
  let calls = 0;
  const c = clientWith(async (url, init) => {
    calls++;
    assert.equal(
      new URL(String(url)).pathname,
      "/v1/scripts/api-deployment:run",
    );
    assert.equal(JSON.parse(String(init?.body)).function, "Library.ping");
    return Response.json({ done: true, response: { result: "pong" } });
  });
  await executeTool(c, "script_run", {
    deploymentId: "api-deployment",
    functionName: "Library.ping",
  });
  await executeTool(c, "script_run", {
    scriptId: "api-deployment",
    functionName: "Library.ping",
  });
  await assert.rejects(
    () => executeTool(c, "script_run", { functionName: "ping" }),
    /deploymentId/,
  );
  await assert.rejects(
    () =>
      executeTool(c, "script_run", {
        deploymentId: "api-deployment",
        scriptId: "different",
        functionName: "ping",
      }),
    /conflicts/,
  );
  assert.equal(calls, 2);
});

test("Drive search degrades on 403 without hiding authentication failures", async () => {
  const denied = clientWith(
    async () => new Response("private upstream details", { status: 403 }),
  );
  const result = await executeTool(denied, "projects_search", {});
  assert.equal((result as { status: string }).status, "search_unavailable");
  assert.match(JSON.stringify(result), /scriptId/);
  assert(!JSON.stringify(result).includes("private upstream details"));
  const unauthorized = clientWith(
    async () => new Response("", { status: 401 }),
  );
  await assert.rejects(
    () => executeTool(unauthorized, "projects_search", {}),
    (e: unknown) => e instanceof ApiError && e.status === 401,
  );
});
