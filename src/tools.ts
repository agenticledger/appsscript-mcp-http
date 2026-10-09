import { z } from "zod";
import { AppsScriptClient, identifier, type Query } from "./api-client.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const text = z.string().max(1024);
const version = z.number().int().positive().max(2147483647);
const page = {
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().max(4096).optional(),
};
const script = { scriptId: id };
const file = z
  .object({
    name: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (v) =>
          !/[\x00-\x1f\\]/.test(v) &&
          !v.split("/").some((p) => p === ".." || p === "." || !p),
      ),
    type: z.enum(["SERVER_JS", "HTML", "JSON"]),
    source: z.string().max(4 * 1024 * 1024),
  })
  .strict();
const files = z
  .array(file)
  .min(1)
  .max(200)
  .refine(
    (v) => new Set(v.map((f) => `${f.type}:${f.name}`)).size === v.length,
    "Duplicate file name/type pairs",
  );
const filesInput = z.union([
  files,
  z
    .string()
    .max(8 * 1024 * 1024)
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "files must be valid JSON",
        });
        return z.NEVER;
      }
    })
    .pipe(files),
]);
const status = z.enum([
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "TIMED_OUT",
  "UNKNOWN",
  "DELAYED",
]);
const filters = {
  deploymentId: id.optional(),
  functionName: text.optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  statuses: z.array(status).max(8).optional(),
};
const userFilter = z
  .object({ ...filters, scriptId: id.optional(), projectName: text.optional() })
  .strict();
const scriptFilter = z.object(filters).strict();
function filterQuery(
  prefix: string,
  f: Record<string, string | string[] | undefined> | undefined,
): Query {
  return Object.fromEntries(
    Object.entries(f ?? {}).map(([k, v]) => [`${prefix}.${k}`, v]),
  );
}
const scope = (s: string) => `https://www.googleapis.com/auth/${s}`;
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  scopes: string[];
  write: boolean;
  example: Record<string, unknown>;
  handler: (client: AppsScriptClient, args: never) => Promise<unknown>;
}
export const tools: ToolDef[] = [];
function tool<S extends z.AnyZodObject>(
  name: string,
  description: string,
  schema: S,
  scopes: string[],
  write: boolean,
  example: Record<string, unknown>,
  handler: (c: AppsScriptClient, a: z.infer<S>) => Promise<unknown>,
): void {
  tools.push({
    name,
    description: `${description} OAuth: ${scopes.join(" or ")}.${write ? " Requires APPS_SCRIPT_ENABLE_WRITES=true." : ""}`,
    inputSchema: schema.strict(),
    scopes,
    write,
    example,
    handler,
  });
}
const p = (a: { scriptId: string }) => `/projects/${identifier(a.scriptId)}`;
const projects = [scope("script.projects")],
  deployments = [scope("script.deployments")];
const readProjects = [...projects, scope("script.projects.readonly")],
  readDeployments = [...deployments, scope("script.deployments.readonly")];
tool(
  "project_get",
  "Read project metadata.",
  z.object(script),
  readProjects,
  false,
  { scriptId: "scratch-script" },
  (c, a) => c.request(p(a)),
);
tool(
  "content_get",
  "Pull all files at HEAD or an immutable version; returns contentHash for conflict checks.",
  z.object({ ...script, versionNumber: version.optional() }),
  readProjects,
  false,
  { scriptId: "scratch-script" },
  (c, a) => c.getContent(a.scriptId, a.versionNumber),
);
tool(
  "versions_list",
  "List immutable versions. Use nextPageToken for the next bounded page.",
  z.object({ ...script, ...page }),
  readProjects,
  false,
  { scriptId: "scratch-script", pageSize: 20 },
  (c, a) =>
    c.request(`${p(a)}/versions`, "GET", undefined, {
      pageSize: a.pageSize,
      pageToken: a.pageToken,
    }),
);
tool(
  "version_get",
  "Read one immutable version.",
  z.object({ ...script, versionNumber: version }),
  readProjects,
  false,
  { scriptId: "scratch-script", versionNumber: 1 },
  (c, a) => c.request(`${p(a)}/versions/${a.versionNumber}`),
);
tool(
  "deployments_list",
  "List deployments and entry-point URLs.",
  z.object({ ...script, ...page }),
  readDeployments,
  false,
  { scriptId: "scratch-script" },
  (c, a) =>
    c.request(`${p(a)}/deployments`, "GET", undefined, {
      pageSize: a.pageSize,
      pageToken: a.pageToken,
    }),
);
tool(
  "deployment_get",
  "Read a deployment and its entry points.",
  z.object({ ...script, deploymentId: id }),
  readDeployments,
  false,
  { scriptId: "scratch-script", deploymentId: "scratch-deployment" },
  (c, a) => c.request(`${p(a)}/deployments/${identifier(a.deploymentId)}`),
);
tool(
  "processes_list",
  "Execution history across projects; statuses include FAILED. This is metadata, not console logs or stack traces.",
  z.object({ ...page, filter: userFilter.optional() }),
  [scope("script.processes")],
  false,
  { filter: { statuses: ["FAILED"] } },
  (c, a) =>
    c.request("/processes", "GET", undefined, {
      ...filterQuery("userProcessFilter", a.filter),
      pageSize: a.pageSize,
      pageToken: a.pageToken,
    }),
);
tool(
  "script_processes_list",
  "Execution history for one script; metadata and error status, not full Cloud Logging messages.",
  z.object({ ...script, ...page, filter: scriptFilter.optional() }),
  [scope("script.processes")],
  false,
  { scriptId: "scratch-script", filter: { statuses: ["FAILED"] } },
  (c, a) =>
    c.request("/processes:listScriptProcesses", "GET", undefined, {
      scriptId: a.scriptId,
      ...filterQuery("scriptProcessFilter", a.filter),
      pageSize: a.pageSize,
      pageToken: a.pageToken,
    }),
);
tool(
  "metrics_get",
  "Read execution, failed-execution and active-user counts (not latency).",
  z.object({
    ...script,
    metricsGranularity: z.enum(["WEEKLY", "DAILY"]).default("DAILY"),
    deploymentId: id.optional(),
  }),
  [scope("script.metrics")],
  false,
  { scriptId: "scratch-script", metricsGranularity: "DAILY" },
  (c, a) =>
    c.request(`${p(a)}/metrics`, "GET", undefined, {
      metricsGranularity: a.metricsGranularity,
      "metricsFilter.deploymentId": a.deploymentId,
    }),
);
tool(
  "projects_search",
  "Search standalone Apps Script files in Drive; container-bound scripts are not listed. drive.file only sees app-authorized files.",
  z.object({ ...page, nameContains: z.string().max(200).optional() }),
  [scope("drive.readonly"), scope("drive.file")],
  false,
  { nameContains: "Scratch" },
  (c, a) => {
    const escaped = a.nameContains?.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return c.request(
      "/files",
      "GET",
      undefined,
      {
        q:
          "trashed = false and mimeType = 'application/vnd.google-apps.script'" +
          (escaped ? ` and name contains '${escaped}'` : ""),
        pageSize: a.pageSize ?? 50,
        pageToken: a.pageToken,
        fields:
          "nextPageToken,incompleteSearch,files(id,name,modifiedTime,webViewLink)",
        orderBy: "modifiedTime desc",
      },
      true,
    );
  },
);
tool(
  "project_create",
  "Create a standalone project, or bind it to a Sheet/Doc/Slides/Form with parentId. Creates a remote resource.",
  z.object({ title: z.string().min(1).max(256), parentId: id.optional() }),
  projects,
  true,
  { title: "MCP scratch" },
  (c, a) => c.request("/projects", "POST", a),
);
tool(
  "content_update",
  "Push files. Default upsert reads HEAD, merges by name and type and preserves omitted files. replace DELETES all omitted files and needs confirmReplace=true. Both write the complete file set; concurrent editor changes can race even with expectedContentHash. HEAD changes affect triggers immediately.",
  z.object({
    ...script,
    files: filesInput,
    mode: z.enum(["upsert", "replace"]).default("upsert"),
    confirmReplace: z.boolean().optional(),
    expectedContentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
  projects,
  true,
  {
    scriptId: "scratch-script",
    mode: "upsert",
    files: [
      {
        name: "Code",
        type: "SERVER_JS",
        source: 'function ping() { return "pong"; }',
      },
    ],
  },
  (c, a) => {
    if (a.mode === "replace" && a.confirmReplace !== true)
      throw new Error("Full replacement requires confirmReplace=true");
    return c.updateContent(a.scriptId, a.files, a.mode, a.expectedContentHash);
  },
);
tool(
  "version_create",
  "Snapshot current HEAD into a new immutable version.",
  z.object({ ...script, description: text.optional() }),
  projects,
  true,
  { scriptId: "scratch-script", description: "Scratch release" },
  (c, a) =>
    c.request(`${p(a)}/versions`, "POST", { description: a.description }),
);
tool(
  "deployment_create",
  "Create a NEW deployment URL from a saved version. For an existing web app use deployment_update to retain /exec URL.",
  z.object({
    ...script,
    versionNumber: version,
    description: text.optional(),
    manifestFileName: z.string().min(1).max(256).default("appsscript"),
  }),
  deployments,
  true,
  { scriptId: "scratch-script", versionNumber: 1 },
  (c, a) =>
    c.request(`${p(a)}/deployments`, "POST", {
      versionNumber: a.versionNumber,
      description: a.description,
      manifestFileName: a.manifestFileName,
    }),
);
tool(
  "deployment_update",
  "Point an EXISTING deployment at a saved version; retains deployment ID and web-app /exec URL. Reads and preserves omitted description/manifest fields.",
  z.object({
    ...script,
    deploymentId: id,
    versionNumber: version,
    description: text.optional(),
    manifestFileName: z.string().min(1).max(256).optional(),
  }),
  deployments,
  true,
  {
    scriptId: "scratch-script",
    deploymentId: "scratch-deployment",
    versionNumber: 2,
  },
  (c, a) =>
    c.updateDeployment(
      a.scriptId,
      a.deploymentId,
      a.versionNumber,
      a.description,
      a.manifestFileName,
    ),
);
tool(
  "deployment_delete",
  "Delete a deployment; its URL stops working. Requires confirmDelete=true.",
  z.object({ ...script, deploymentId: id, confirmDelete: z.literal(true) }),
  deployments,
  true,
  {
    scriptId: "scratch-script",
    deploymentId: "scratch-deployment",
    confirmDelete: true,
  },
  (c, a) =>
    c.request(`${p(a)}/deployments/${identifier(a.deploymentId)}`, "DELETE"),
);
const params = z.array(z.unknown()).max(100);
tool(
  "script_run",
  "Run a function; may change data. Requires an API-executable deployment and the SAME standard GCP project as the OAuth client; token must cover ALL script scopes. No service accounts. devMode is for the script owner. A run can return Operation.error despite HTTP 200.",
  z.object({
    ...script,
    functionName: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,255}$/),
    parameters: z
      .union([
        params,
        z
          .string()
          .max(1024 * 1024)
          .transform((s, ctx) => {
            try {
              return JSON.parse(s) as unknown;
            } catch {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Invalid parameters JSON",
              });
              return z.NEVER;
            }
          })
          .pipe(params),
      ])
      .optional(),
    devMode: z.boolean().default(false),
  }),
  [
    "All OAuth scopes declared/used by the target script (no universal script.run scope)",
  ],
  true,
  { scriptId: "scratch-script", functionName: "ping" },
  (c, a) =>
    c.request(`/scripts/${identifier(a.scriptId)}:run`, "POST", {
      function: a.functionName,
      parameters: a.parameters ?? [],
      devMode: a.devMode,
    }),
);
export async function executeTool(
  client: AppsScriptClient,
  name: string,
  args: unknown,
): Promise<unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error("Unknown tool");
  const validated = tool.inputSchema.safeParse(args ?? {});
  if (!validated.success)
    throw new Error("Invalid tool arguments; check the published input schema");
  if (tool.write) client.assertWrites();
  return tool.handler(client, validated.data as never);
}
