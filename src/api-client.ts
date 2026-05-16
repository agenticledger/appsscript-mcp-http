/**
 * Google Apps Script REST API Client
 * Base URL: https://script.googleapis.com/v1
 * Auth: OAuth 2.0 access token (Bearer)
 *
 * API Reference: https://developers.google.com/apps-script/api/reference/rest
 */

const BASE_URL = 'https://script.googleapis.com/v1';

export class AppsScriptClient {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async request<T>(
    endpoint: string,
    options?: {
      method?: string;
      body?: any;
      params?: Record<string, string | number | boolean | undefined>;
    }
  ): Promise<T> {
    const url = new URL(`${BASE_URL}${endpoint}`);
    const method = options?.method || 'GET';

    if (options?.params) {
      Object.entries(options.params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.append(key, String(value));
        }
      });
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Accept': 'application/json',
    };

    if (options?.body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url.toString(), {
      method,
      headers,
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 204) {
      return {} as T;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Apps Script API ${response.status}: ${text}`);
    }

    return response.json();
  }

  // === Projects ===

  /**
   * Create a new Apps Script project.
   * If parentId is provided, creates the project bound to that Google Docs/Sheets/Slides/Forms file.
   */
  async createProject(title: string, parentId?: string) {
    const body: any = { title };
    if (parentId) body.parentId = parentId;
    return this.request<any>('/projects', {
      method: 'POST',
      body,
    });
  }

  /** Get metadata for a script project. */
  async getProject(scriptId: string) {
    return this.request<any>(`/projects/${encodeURIComponent(scriptId)}`);
  }

  // === Content (pull/push) ===

  /** Get the content of a script project (all files). Equivalent to clasp pull. */
  async getContent(scriptId: string, versionNumber?: number) {
    const params: Record<string, string | number | boolean | undefined> = {};
    if (versionNumber !== undefined) params.versionNumber = versionNumber;
    return this.request<any>(`/projects/${encodeURIComponent(scriptId)}/content`, { params });
  }

  /**
   * Update the content of a script project (all files). Equivalent to clasp push.
   * files: array of { name, type, source } where type is SERVER_JS, HTML, or JSON
   */
  async updateContent(scriptId: string, files: Array<{ name: string; type: string; source: string }>) {
    return this.request<any>(`/projects/${encodeURIComponent(scriptId)}/content`, {
      method: 'PUT',
      body: { files },
    });
  }

  // === Versions ===

  /** List all versions of a script project. */
  async listVersions(scriptId: string, pageSize?: number, pageToken?: string) {
    return this.request<any>(`/projects/${encodeURIComponent(scriptId)}/versions`, {
      params: { pageSize, pageToken },
    });
  }

  /** Create a new immutable version of the script. */
  async createVersion(scriptId: string, description?: string) {
    return this.request<any>(`/projects/${encodeURIComponent(scriptId)}/versions`, {
      method: 'POST',
      body: { description },
    });
  }

  /** Get a specific version. */
  async getVersion(scriptId: string, versionNumber: number) {
    return this.request<any>(`/projects/${encodeURIComponent(scriptId)}/versions/${versionNumber}`);
  }

  // === Deployments ===

  /** List all deployments of a script project. */
  async listDeployments(scriptId: string, pageSize?: number, pageToken?: string) {
    return this.request<any>(`/projects/${encodeURIComponent(scriptId)}/deployments`, {
      params: { pageSize, pageToken },
    });
  }

  /** Create a deployment (requires a version number). */
  async createDeployment(scriptId: string, versionNumber: number, description?: string, manifestFileName?: string) {
    const config: any = {
      versionNumber,
      description: description || '',
    };
    if (manifestFileName) config.manifestFileName = manifestFileName;
    return this.request<any>(`/projects/${encodeURIComponent(scriptId)}/deployments`, {
      method: 'POST',
      body: { versionNumber: config.versionNumber, description: config.description, manifestFileName: config.manifestFileName },
    });
  }

  /** Get a specific deployment. */
  async getDeployment(scriptId: string, deploymentId: string) {
    return this.request<any>(
      `/projects/${encodeURIComponent(scriptId)}/deployments/${encodeURIComponent(deploymentId)}`
    );
  }

  /** Update a deployment to point to a new version. */
  async updateDeployment(scriptId: string, deploymentId: string, versionNumber: number, description?: string) {
    return this.request<any>(
      `/projects/${encodeURIComponent(scriptId)}/deployments/${encodeURIComponent(deploymentId)}`,
      {
        method: 'PUT',
        body: {
          deploymentConfig: {
            versionNumber,
            description: description || '',
          },
        },
      }
    );
  }

  /** Delete a deployment. */
  async deleteDeployment(scriptId: string, deploymentId: string) {
    return this.request<any>(
      `/projects/${encodeURIComponent(scriptId)}/deployments/${encodeURIComponent(deploymentId)}`,
      { method: 'DELETE' }
    );
  }

  // === Execution / Run ===

  /**
   * Run a function in a script project.
   * The script must be deployed as an API executable.
   */
  async runFunction(scriptId: string, functionName: string, parameters?: any[], devMode?: boolean) {
    return this.request<any>(`/scripts/${encodeURIComponent(scriptId)}:run`, {
      method: 'POST',
      body: {
        function: functionName,
        parameters: parameters || [],
        devMode: devMode || false,
      },
    });
  }

  // === Processes (logs) ===

  /** List recent script execution processes. */
  async listProcesses(pageSize?: number, pageToken?: string) {
    return this.request<any>('/processes', {
      params: { pageSize, pageToken },
    });
  }

  /** List processes for a specific script. */
  async listScriptProcesses(scriptId: string, pageSize?: number, pageToken?: string) {
    return this.request<any>(`/projects/${encodeURIComponent(scriptId)}/processes`, {
      params: { pageSize, pageToken },
    });
  }

  // === Metrics ===

  /** Get metrics for a script project (execution counts, errors, etc.). */
  async getMetrics(scriptId: string, metricsGranularity?: string) {
    const filter: Record<string, string | number | boolean | undefined> = {};
    if (metricsGranularity) filter['metricsGranularity'] = metricsGranularity;
    return this.request<any>(`/projects/${encodeURIComponent(scriptId)}/metrics`, {
      params: filter,
    });
  }
}
