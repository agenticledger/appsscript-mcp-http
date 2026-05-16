import { z } from 'zod';
import { AppsScriptClient } from './api-client.js';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodType<any>;
  handler: (client: AppsScriptClient, args: any) => Promise<any>;
}

export const tools: ToolDef[] = [
  // === Projects ===
  {
    name: 'project_create',
    description: 'Create a new Apps Script project. Optionally bind it to a Google Docs/Sheets/Slides/Forms file by providing parentId.',
    inputSchema: z.object({
      title: z.string().describe('Project title'),
      parentId: z.string().optional().describe('Google Drive file ID to bind the script to (Sheets, Docs, etc.)'),
    }),
    handler: async (client, args) => client.createProject(args.title, args.parentId),
  },
  {
    name: 'project_get',
    description: 'Get metadata for a script project (title, scriptId, createTime, updateTime, creator)',
    inputSchema: z.object({
      scriptId: z.string().describe('The script project ID'),
    }),
    handler: async (client, args) => client.getProject(args.scriptId),
  },

  // === Content (pull/push) ===
  {
    name: 'content_get',
    description: 'Get the content (all files) of a script project. Equivalent to clasp pull. Returns array of files with name, type, and source code.',
    inputSchema: z.object({
      scriptId: z.string().describe('The script project ID'),
      versionNumber: z.number().optional().describe('Specific version to retrieve (omit for HEAD)'),
    }),
    handler: async (client, args) => client.getContent(args.scriptId, args.versionNumber),
  },
  {
    name: 'content_update',
    description: 'Update the content (all files) of a script project. Equivalent to clasp push. Send the complete file set — any file not included will be deleted.',
    inputSchema: z.object({
      scriptId: z.string().describe('The script project ID'),
      files: z.string().describe('JSON array of files: [{"name":"Code","type":"SERVER_JS","source":"function myFunction() {}"},{"name":"appsscript","type":"JSON","source":"{\\"timeZone\\":\\"America/New_York\\"}"}]. Types: SERVER_JS, HTML, JSON'),
    }),
    handler: async (client, args) => client.updateContent(args.scriptId, JSON.parse(args.files)),
  },

  // === Versions ===
  {
    name: 'versions_list',
    description: 'List all saved (immutable) versions of a script project',
    inputSchema: z.object({
      scriptId: z.string().describe('The script project ID'),
      pageSize: z.number().optional().describe('Max results per page'),
      pageToken: z.string().optional().describe('Pagination token'),
    }),
    handler: async (client, args) => client.listVersions(args.scriptId, args.pageSize, args.pageToken),
  },
  {
    name: 'version_create',
    description: 'Create a new immutable version of the script (snapshot current content)',
    inputSchema: z.object({
      scriptId: z.string().describe('The script project ID'),
      description: z.string().optional().describe('Version description'),
    }),
    handler: async (client, args) => client.createVersion(args.scriptId, args.description),
  },
  {
    name: 'version_get',
    description: 'Get details of a specific version',
    inputSchema: z.object({
      scriptId: z.string().describe('The script project ID'),
      versionNumber: z.number().describe('Version number'),
    }),
    handler: async (client, args) => client.getVersion(args.scriptId, args.versionNumber),
  },

  // === Deployments ===
  {
    name: 'deployments_list',
    description: 'List all deployments of a script project',
    inputSchema: z.object({
      scriptId: z.string().describe('The script project ID'),
      pageSize: z.number().optional().describe('Max results per page'),
      pageToken: z.string().optional().describe('Pagination token'),
    }),
    handler: async (client, args) => client.listDeployments(args.scriptId, args.pageSize, args.pageToken),
  },
  {
    name: 'deployment_create',
    description: 'Create a new deployment. Requires a version number — create a version first.',
    inputSchema: z.object({
      scriptId: z.string().describe('The script project ID'),
      versionNumber: z.number().describe('Version number to deploy'),
      description: z.string().optional().describe('Deployment description'),
    }),
    handler: async (client, args) => client.createDeployment(args.scriptId, args.versionNumber, args.description),
  },
  {
    name: 'deployment_get',
    description: 'Get details of a specific deployment',
    inputSchema: z.object({
      scriptId: z.string().describe('The script project ID'),
      deploymentId: z.string().describe('Deployment ID'),
    }),
    handler: async (client, args) => client.getDeployment(args.scriptId, args.deploymentId),
  },
  {
    name: 'deployment_update',
    description: 'Update a deployment to point to a different version',
    inputSchema: z.object({
      scriptId: z.string().describe('The script project ID'),
      deploymentId: z.string().describe('Deployment ID'),
      versionNumber: z.number().describe('New version number'),
      description: z.string().optional().describe('Updated description'),
    }),
    handler: async (client, args) => client.updateDeployment(args.scriptId, args.deploymentId, args.versionNumber, args.description),
  },
  {
    name: 'deployment_delete',
    description: 'Delete a deployment',
    inputSchema: z.object({
      scriptId: z.string().describe('The script project ID'),
      deploymentId: z.string().describe('Deployment ID'),
    }),
    handler: async (client, args) => client.deleteDeployment(args.scriptId, args.deploymentId),
  },

  // === Execution ===
  {
    name: 'script_run',
    description: 'Run a function in a script project. The script must be deployed as an API executable. Returns the function result or execution error.',
    inputSchema: z.object({
      scriptId: z.string().describe('The script project ID'),
      functionName: z.string().describe('Name of the function to run'),
      parameters: z.string().optional().describe('JSON array of parameters to pass to the function'),
      devMode: z.boolean().optional().describe('Run in dev mode (uses most recent saved code, not deployed version)'),
    }),
    handler: async (client, args) =>
      client.runFunction(args.scriptId, args.functionName, args.parameters ? JSON.parse(args.parameters) : undefined, args.devMode),
  },

  // === Processes (logs) ===
  {
    name: 'processes_list',
    description: 'List recent script execution processes across all projects',
    inputSchema: z.object({
      pageSize: z.number().optional().describe('Max results per page'),
      pageToken: z.string().optional().describe('Pagination token'),
    }),
    handler: async (client, args) => client.listProcesses(args.pageSize, args.pageToken),
  },
  {
    name: 'script_processes_list',
    description: 'List recent execution processes for a specific script project',
    inputSchema: z.object({
      scriptId: z.string().describe('The script project ID'),
      pageSize: z.number().optional().describe('Max results per page'),
      pageToken: z.string().optional().describe('Pagination token'),
    }),
    handler: async (client, args) => client.listScriptProcesses(args.scriptId, args.pageSize, args.pageToken),
  },

  // === Metrics ===
  {
    name: 'metrics_get',
    description: 'Get execution metrics for a script project (execution counts, errors, latency)',
    inputSchema: z.object({
      scriptId: z.string().describe('The script project ID'),
      metricsGranularity: z.enum(['UNSPECIFIED_GRANULARITY', 'WEEKLY', 'DAILY']).optional().describe('Granularity of metrics'),
    }),
    handler: async (client, args) => client.getMetrics(args.scriptId, args.metricsGranularity),
  },
];
