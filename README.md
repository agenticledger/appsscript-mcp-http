# Google Apps Script REST MCP

17 tools call `script.googleapis.com/v1` directly; Drive search calls `www.googleapis.com/drive/v3`. No clasp, browser login files, refresh-token exchange, or provider keys in the hosted service. Runs in cloud tenants and local MCP clients.

Release version: **3.0.0**. Offline tests use synthetic scratch fixtures. **Real Google calls and deployment behavior have not been verified with an authorized Google account.**

- HTTP repository: https://github.com/agenticledger/appsscript-mcp-http
- StreamableHTTP endpoint: https://appsscriptmcp.agenticledger.ai/mcp
- Documentation: https://financemcps.agenticledger.ai/appsscript/
- Canonical stdio source: `LIVESTDIOMCPS/appsscript/mcp-server`

## Local install and verification

Node.js 20 or later:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm test
APPS_SCRIPT_MOCK=true npm start
```

This mock mode labels every tool response `mode: "mock"`, uses deterministic scratch fixtures, never calls Google, and is not a persistent Apps Script emulator. HTTP production does not expose mock mode.

Local stdio accepts a short-lived `GOOGLE_ACCESS_TOKEN` from a secure broker/executor environment. It never reads `~/.clasprc.json` or any clasp profile. It neither stores nor refreshes the token; your broker supplies a fresh one. Do not paste live tokens into source or committed client configuration.

```json
{
  "mcpServers": {
    "appsscript": {
      "command": "node",
      "args": ["/absolute/path/to/appsscript/mcp-server/dist/index.js"],
      "env": { "APPS_SCRIPT_MOCK": "true" }
    }
  }
}
```

Set `APPS_SCRIPT_ENABLE_WRITES=true` explicitly on the server to enable create/push/version/deployment/delete/run tools. Writes default off in both transports. The authorized Railway production profile explicitly opts in through `railway.json` → `node --env-file=railway.env dist/index.js`. That file contains only the non-secret write flag. An existing Railway `APPS_SCRIPT_ENABLE_WRITES=false` variable takes precedence and remains an operator kill switch. Ordinary `npm start` does not load that profile. A timed-out write may already have completed: inspect remote state before retrying. Writes are never retried automatically.

## Hosted authentication and tenant installation

The hosted MCP has zero provider secrets. It retains the existing broker namespace **google-mcp-prod**, provider **google-appsscript** (`oauth`), and resolves credentials at tool-call time via the broker's signed `/token` contract. No OAuth callback, well-known OAuth authorization-server route, local token vault, or provider environment-token fallback exists.

The server requires `BROKER_INSTALL_BEARER`, `BROKER_JWT_KEY`, and `BROKER_CLIENT_NAMESPACE`; `/mcp` returns 503 when the install identity is missing. `/health` reports actual configuration, tool count, write enablement, and signed-principal readiness. Configure these before deploying.

Three caller modes:

1. **Platform Google Bearer passthrough:** send `Authorization: Bearer <short-lived Google OAuth access token>` on EVERY request. The platform connects Google and resolves/refreshes it securely. A platform login token is not a Google token.
2. **Broker client / signed platform identity:** the gateway sends `X-Broker-Principal: <instanceId>:<agentId>` and `X-Broker-Principal-Sig: base64url(HMAC-SHA256(BROKER_PRINCIPAL_HMAC_KEY, principal))`. The gateway and MCP operator must share that signing key securely. Never let a browser choose/sign another agent's principal. Unsigned identities and a shared default principal are rejected.
3. **Independent consumer:** generate 32 random bytes as base64url once, keep them private, and send them as `X-MCP-Caller-Key` on every request. This MCP hashes that secret into an opaque principal and resolves the account in its own broker namespace. The first tool call returns structured `connection_required` with a consent link; open it, approve, and retry with the same key. Keep one key per agent. Losing the key requires a new connection; sharing it shares the account. Do not use a human-readable agent ID as this key.

Broker modes accept `X-Broker-Account` (optional, letters/digits/underscore/dot/dash, up to 100 characters) to select several Google accounts for one agent. These replace local clasp profiles. Token custody remains with the broker.

Requests are stateless: no MCP session ID or server-side user credential cache. MCP discovery can run without a caller credential once the broker is configured; a tool call then returns `identity_required`. Provider credentials are resolved only after argument validation.

### ccn.finney.finance setup

1. Have tenant `@hub` register `appsscript` in both its MCP registry and UI catalog, URL above, HTTP transport, broker provider `google-appsscript`, broker namespace `google-mcp-prod`.
2. Have the Connections Broker owner expand the Google Apps Script consent scope set listed below. The currently inspected provider row requests only `script.projects`. Existing consent must be renewed; refresh does not add scopes.
3. Enable the **Google Apps Script API** in the OAuth client's Google Cloud project (and **Drive API** for search). In the Google account that owns/edits the scripts, open https://script.google.com/home/usersettings and turn on **Google Apps Script API**. Missing enablement can produce 403; permissions and scope failures can also produce 403.
4. In the tenant, attach the MCP to the intended agent and connect Google as that agent. Configure one caller mode above. For signed mode the connect flow must bind the OAuth grant to `google-mcp-prod` and the EXACT `<instanceId>:<agentId>` used on reads. A token granted to a different namespace/agent will not be found. For standalone mode open the MCP-generated consent link instead of a generic Google connect link.
5. The approved Railway production profile enables publishing/execution. Verify `/health` reports `writesEnabled:true`; an operator can override with `APPS_SCRIPT_ENABLE_WRITES=false`. Use signed mode only when `signedPrincipalConfigured=true`; otherwise use per-request Google Bearer passthrough or the private caller key.
6. First proof: run `project_get` and `content_get` on an owner-approved scratch project. Do not use the CCN live portal as a write test.
7. For `script_run`, separately complete API-executable and same-GCP-project requirements below. A web-app deployment alone is insufficient.

## Scopes

Scope names below are relative to `https://www.googleapis.com/auth/`:

| Tools                                                         | OAuth scope                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `project_get`, `content_get`, `versions_list`, `version_get`  | `script.projects.readonly` OR `script.projects`                                |
| `project_create`, `content_update`, `version_create`          | `script.projects`                                                              |
| `deployments_list`, `deployment_get`                          | `script.deployments.readonly` OR `script.deployments`                          |
| `deployment_create`, `deployment_update`, `deployment_delete` | `script.deployments`                                                           |
| `processes_list`, `script_processes_list`                     | `script.processes`                                                             |
| `metrics_get`                                                 | `script.metrics`                                                               |
| `projects_search`                                             | `drive.readonly` OR `drive.file`                                               |
| `script_run`                                                  | ALL scopes used by the target script; there is no universal `script.run` scope |

Recommended broker consent set for project management: `script.projects script.deployments script.processes script.metrics drive.readonly`. Choose `drive.file` instead when app-authorized-file-only search is sufficient. The broker must explicitly authorize any additional scopes required by `script_run` (for example `spreadsheets` or `documents`); do not request every Google scope speculatively.

## Edit → publish → inspect

1. `content_get({scriptId})` reads HEAD and returns a `contentHash`. Back up these files.
2. `content_update({scriptId, mode:"upsert", files:[{name:"Code",type:"SERVER_JS",source:"..."}], expectedContentHash})` reads HEAD again and merges files by name and type. It preserves other files and the manifest; strips output-only file metadata.
3. For intentional deletion use `mode:"replace", confirmReplace:true` and the complete desired files, including `{name:"appsscript", type:"JSON", source:"..."}`. **Google replaces ALL files.** Both modes alter HEAD immediately (including triggers, editor runs and development-mode consumers).
4. `version_create({scriptId,description})` snapshots HEAD; save its returned `versionNumber`.
5. `deployments_list({scriptId})` or `deployment_get` identifies the existing web-app `deploymentId` and `/exec` entry point.
6. `deployment_update({scriptId,deploymentId,versionNumber})` updates that SAME deployment. It reads and preserves omitted description/manifest configuration. Do not delete and recreate it: that makes a new URL. Compare the returned deployment ID and entry-point URL with the earlier read.
7. `script_processes_list({scriptId,filter:{statuses:["FAILED","TIMED_OUT"]}})` and `metrics_get({scriptId,metricsGranularity:"DAILY"})` inspect execution outcomes.

Upsert is a read-merge-write helper, **not an atomic patch**. `expectedContentHash` detects stale content at the helper's read, but Google supplies no compare-and-swap precondition here: another editor can still race the later PUT. Serialize edits to a script. Deployment update's read/write also needs coordinated publishing.

## scripts.run preconditions and limits

Deploy the script as an **API executable**. The script and OAuth client MUST share the same **standard Google Cloud project** with the Apps Script API enabled. The caller needs access and a token covering every scope used by the script, even scopes used by functions other than the requested function. A broker OAuth client in another GCP project cannot run that script just by adding scopes: use a compatible project/client arrangement owned by the broker. Service accounts are unsupported. `devMode:true` only works for the script owner and uses HEAD. Inputs/results must be JSON-compatible values, not Apps Script objects such as a Sheet.

HTTP 200 can contain `Operation.error`; the MCP preserves the operation and sets `isError:true`. The execution timeout is 370 seconds, other calls 30 seconds; client/gateway timeouts may be shorter. The process history tools expose status, function, timing and type, **not console logs or stack traces**. Use Google Cloud Logging / Apps Script Executions UI for full logs. Metrics are execution/error/active-user counts, not latency.

Drive search lists accessible standalone script files; bound scripts are not Drive-searchable as standalone Apps Script files. Keep their script IDs from project settings. `parentId` at creation is the container's Drive ID, not another script's ID.

## Pagination, input limits and errors

All list helpers return one page and preserve Google's `nextPageToken`; supply it for the next call. Page sizes are capped at 100 by this MCP. IDs accept letters, digits, underscore and dash; unknown input keys are rejected. Files accept SERVER_JS, HTML or JSON, at most 200 files, 4 MiB of source per file, 8 MiB total JSON request/response. Larger projects need a reviewed cap change. Drive search escapes query literals and exposes no arbitrary filter or URL. Reads retry HTTP 429/502/503/504 at most twice; writes never retry. Upstream error bodies and transport error messages are not echoed, avoiding credential leaks.

`connection_required` is a normal connect result. `writes_disabled` needs the operator flag. `upstream_401` needs a refreshed access token; `upstream_403` needs scope/permission/API checks. A timeout does not prove a write failed. No live token, customer data, or clasp profile is bundled.

## Future live acceptance test (owner approval required)

Ask Ore for a scratch project and secure broker connection first. Verify read calls. Enable writes explicitly; push a harmless `ping` function into the scratch project only, create a version, create a scratch web-app deployment, record its URL, change the function, create a second version, update the same deployment, and compare ID/URL. Read processes/metrics. Run `ping` only after API-executable and same-GCP preconditions are satisfied. Retain evidence with secrets redacted. Never write to the live CCN portal or its sheet-bound menu for testing.

## Official references

- [REST resources](https://developers.google.com/apps-script/api/reference/rest)
- [Content replacement semantics](https://developers.google.com/apps-script/api/reference/rest/v1/projects/updateContent)
- [Update an existing deployment](https://developers.google.com/apps-script/api/reference/rest/v1/projects.deployments/update)
- [Script execution history](https://developers.google.com/apps-script/api/reference/rest/v1/processes/listScriptProcesses)
- [Execute a function and prerequisites](https://developers.google.com/apps-script/api/how-tos/execute)
- [Enable API access](https://developers.google.com/apps-script/api/how-tos/enable)
- [Drive search](https://developers.google.com/drive/api/guides/search-files)

## Tool schemas and examples

See `docs/tools.json` for the generated input schemas, required scopes and examples for all 17 tools. `docs/index.html` provides searchable, expandable reference documentation and mock examples. `agenthub-bundle.json` is a portable handoff descriptor; its presence does not mean it is published to AgentHub or PlatformAuth.
