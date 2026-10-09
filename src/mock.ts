/** Synthetic scratch fixtures. Never calls Google or loads local clasp credentials. */
export const mockFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const body = init?.body
    ? (JSON.parse(String(init.body)) as Record<string, unknown>)
    : {};
  const files = [
    {
      name: "appsscript",
      type: "JSON",
      source: '{"timeZone":"Etc/UTC","runtimeVersion":"V8"}',
    },
    {
      name: "Code",
      type: "SERVER_JS",
      source: 'function ping() { return "pong"; }',
    },
  ];
  let data: unknown = {
    scriptId: "scratch-script",
    title: "Mock scratch",
    ...body,
  };
  if (url.pathname.endsWith("/content"))
    data = { scriptId: "scratch-script", files: body.files ?? files };
  if (url.pathname.endsWith("/versions"))
    data =
      init?.method === "POST"
        ? { versionNumber: 1, ...body }
        : { versions: [{ versionNumber: 1, description: "Mock version" }] };
  if (/\/versions\/\d+$/.test(url.pathname)) data = { versionNumber: 1 };
  if (url.pathname.endsWith("/deployments"))
    data =
      init?.method === "POST"
        ? { deploymentId: "scratch-deployment", deploymentConfig: body }
        : {
            deployments: [
              {
                deploymentId: "scratch-deployment",
                deploymentConfig: {
                  versionNumber: 1,
                  manifestFileName: "appsscript",
                },
              },
            ],
          };
  if (/\/deployments\/[^/]+$/.test(url.pathname))
    data = {
      deploymentId: "scratch-deployment",
      deploymentConfig: body.deploymentConfig ?? {
        scriptId: "scratch-script",
        versionNumber: 1,
        manifestFileName: "appsscript",
        description: "Mock",
      },
      entryPoints: [
        {
          entryPointType: "WEB_APP",
          webApp: {
            url: "https://script.google.com/macros/s/scratch-deployment/exec",
          },
        },
      ],
    };
  if (url.pathname.includes("/processes"))
    data = {
      processes: [
        {
          functionName: "ping",
          processStatus: "COMPLETED",
          processType: "EXECUTION_API",
          duration: "0.1s",
        },
      ],
    };
  if (url.pathname.endsWith("/metrics"))
    data = {
      metricsGranularity: "DAILY",
      totalExecutions: [
        {
          startTime: "2026-01-01T00:00:00Z",
          endTime: "2026-01-02T00:00:00Z",
          value: "1",
        },
      ],
    };
  if (url.pathname.endsWith("/files"))
    data = { files: [{ id: "scratch-script", name: "Mock scratch" }] };
  if (url.pathname.endsWith(":run"))
    data = { done: true, response: { result: "pong" } };
  if (init?.method === "DELETE") return new Response(null, { status: 204 });
  return Response.json(data);
};
