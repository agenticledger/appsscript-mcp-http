import { createHash } from "node:crypto";

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type Query = Record<
  string,
  string | number | boolean | string[] | undefined
>;
export interface ScriptFile {
  name: string;
  type: "SERVER_JS" | "HTML" | "JSON";
  source: string;
}
export interface Content {
  files: ScriptFile[];
  scriptId?: string;
}
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}
export const MAX_BYTES = 8 * 1024 * 1024;
export function contentHash(files: ScriptFile[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        files
          .map(({ name, type, source }) => ({ name, type, source }))
          .sort(
            (a, b) =>
              a.name.localeCompare(b.name) || a.type.localeCompare(b.type),
          ),
      ),
    )
    .digest("hex");
}
export function identifier(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value))
    throw new ApiError("invalid_input", "Invalid resource identifier");
  return encodeURIComponent(value);
}
export class AppsScriptClient {
  readonly mode: "live" | "mock";
  constructor(
    private token: string,
    private options: {
      fetch?: typeof fetch;
      writesEnabled?: boolean;
      timeoutMs?: number;
      mock?: boolean;
    } = {},
  ) {
    if (!token || /[\r\n]/.test(token))
      throw new ApiError(
        "invalid_auth",
        "A valid OAuth access token is required",
      );
    this.mode = options.mock ? "mock" : "live";
  }
  assertWrites(): void {
    if (!this.options.writesEnabled)
      throw new ApiError(
        "writes_disabled",
        "Writes and script execution are disabled. Set APPS_SCRIPT_ENABLE_WRITES=true on this server to enable them.",
      );
  }
  async request<T = unknown>(
    path: string,
    method = "GET",
    body?: unknown,
    params: Query = {},
    drive = false,
  ): Promise<T> {
    if (method !== "GET") this.assertWrites();
    if (
      !/^\/(?:projects(?:\/[A-Za-z0-9_-]+(?:\/(?:content|metrics|versions(?:\/\d+)?|deployments(?:\/[A-Za-z0-9_-]+)?))?)?|processes(?::listScriptProcesses)?|scripts\/[A-Za-z0-9_-]+:run)$/.test(
        path,
      ) &&
      !(drive && path === "/files")
    ) {
      throw new ApiError("invalid_path", "Unsupported API resource");
    }
    if (drive && path !== "/files")
      throw new ApiError("invalid_path", "Unsupported Drive resource");
    const url = new URL(
      (drive
        ? "https://www.googleapis.com/drive/v3"
        : "https://script.googleapis.com/v1") + path,
    );
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value])
        url.searchParams.append(key, String(item));
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload && Buffer.byteLength(payload) > MAX_BYTES)
      throw new ApiError("request_too_large", "Request exceeds 8 MiB");
    const timeout =
      this.options.timeoutMs ?? (path.endsWith(":run") ? 370_000 : 30_000);
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await (this.options.fetch ?? fetch)(url, {
          method,
          redirect: "error",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
            ...(payload ? { "Content-Type": "application/json" } : {}),
          },
          body: payload,
        });
        if (
          method === "GET" &&
          attempt < 2 &&
          [429, 502, 503, 504].includes(response.status)
        ) {
          await response.body?.cancel();
          await new Promise((resolve) =>
            setTimeout(resolve, 100 * (attempt + 1)),
          );
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          const hint =
            response.status === 403
              ? " Check consent scopes, project permissions, Cloud API enablement, and https://script.google.com/home/usersettings."
              : "";
          throw new ApiError(
            `upstream_${response.status}`,
            `Google API returned HTTP ${response.status}.${hint}`,
            response.status,
          );
        }
        if (response.status === 204) return {} as T;
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_BYTES) {
              await reader.cancel();
              throw new ApiError(
                "response_too_large",
                "Response exceeds 8 MiB; request a smaller page",
              );
            }
            chunks.push(value);
          }
        }
        try {
          return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
        } catch {
          throw new ApiError(
            "invalid_response",
            "Google API returned malformed JSON",
          );
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          controller.signal.aborted ? "timeout" : "transport_error",
          controller.signal.aborted
            ? "Google API request timed out; a write may have completed. Inspect remote state before retrying."
            : "Google API transport unavailable",
        );
      } finally {
        clearTimeout(timer);
      }
    }
  }
  async getContent(
    scriptId: string,
    versionNumber?: number,
  ): Promise<Content & { contentHash: string }> {
    const content = await this.request<Content>(
      `/projects/${identifier(scriptId)}/content`,
      "GET",
      undefined,
      { versionNumber },
    );
    if (!Array.isArray(content.files))
      throw new ApiError(
        "invalid_response",
        "Content response is missing files",
      );
    return { ...content, contentHash: contentHash(content.files) };
  }
  async updateContent(
    scriptId: string,
    files: ScriptFile[],
    mode: "upsert" | "replace",
    expectedContentHash?: string,
  ): Promise<unknown> {
    this.assertWrites();
    let merged = files;
    if (mode === "upsert" || expectedContentHash) {
      const current = await this.getContent(scriptId);
      if (expectedContentHash && current.contentHash !== expectedContentHash)
        throw new ApiError(
          "content_conflict",
          "HEAD changed since your read. Pull again and merge before retrying.",
        );
      if (mode === "upsert") {
        const byName = new Map(
          current.files.map(({ name, type, source }) => [
            `${type}:${name}`,
            { name, type, source },
          ]),
        );
        for (const file of files) byName.set(`${file.type}:${file.name}`, file);
        merged = [...byName.values()];
      }
    }
    const manifest = merged.find(
      (file) => file.name === "appsscript" && file.type === "JSON",
    );
    if (!manifest)
      throw new ApiError(
        "invalid_manifest",
        "The final file set must contain appsscript of type JSON",
      );
    try {
      const value: unknown = JSON.parse(manifest.source);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
    } catch {
      throw new ApiError(
        "invalid_manifest",
        "appsscript source must be a JSON object",
      );
    }
    return this.request(`/projects/${identifier(scriptId)}/content`, "PUT", {
      files: merged,
    });
  }
  async updateDeployment(
    scriptId: string,
    deploymentId: string,
    versionNumber: number,
    description?: string,
    manifestFileName?: string,
  ): Promise<unknown> {
    this.assertWrites();
    const path = `/projects/${identifier(scriptId)}/deployments/${identifier(deploymentId)}`;
    const current = await this.request<{
      deploymentConfig?: { description?: string; manifestFileName?: string };
    }>(path);
    if (!current.deploymentConfig)
      throw new ApiError(
        "invalid_response",
        "Deployment response is missing deploymentConfig",
      );
    return this.request(path, "PUT", {
      deploymentConfig: {
        scriptId,
        versionNumber,
        description: description ?? current.deploymentConfig.description,
        manifestFileName:
          manifestFileName ?? current.deploymentConfig.manifestFileName,
      },
    });
  }
}
