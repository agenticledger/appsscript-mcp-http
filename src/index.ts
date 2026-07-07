#!/usr/bin/env node
/**
 * Google Apps Script MCP Server — Exposed via Streamable HTTP
 *
 * Auth model: Dual-mode — supports both direct Bearer passthrough
 * and OAuth 2.0 Client Credentials grant.
 * No permanent credentials are stored on the server.
 *
 * The Bearer token must be a Google OAuth access token with Apps Script scopes.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema as _zodToJsonSchema } from 'zod-to-json-schema';
import { AppsScriptClient } from './api-client.js';
import { tools } from './tools.js';

function zodToJsonSchema(schema: any): any {
  return _zodToJsonSchema(schema);
}

const PORT = parseInt(process.env.PORT || '3100', 10);
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || `http://localhost:${PORT}`;
const SLUG = 'appsscript';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --- OAuth token store (in-memory, ephemeral) ---
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

interface OAuthToken {
  apiKey: string;
  expiresAt: number;
}

const oauthTokens = new Map<string, OAuthToken>();

// Cleanup expired tokens every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of oauthTokens) {
    if (now > data.expiresAt) oauthTokens.delete(token);
  }
}, 10 * 60 * 1000);

// --- Static assets (logo) ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/static', express.static(path.join(__dirname, 'public')));

// Health check (no auth required)
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'appsscript-mcp-http',
    version: '1.0.0',
    tools: tools.length,
    transport: 'streamable-http',
    auth: 'dual-mode',
    auth_modes: ['bearer-passthrough', 'oauth-client-credentials'],
  });
});

// --- OAuth 2.0 Discovery ---
// Claude-CLI OAuth-trap fix: OAuth Authorization Server metadata de-advertised.
// The spec discovery path /.well-known/oauth-authorization-server now 404s, so Claude CLI
// falls back to Bearer passthrough (Mode-B broker) instead of a self-hosted OAuth dance.
app.get('/_disabled/oauth-authorization-server', (_req, res) => {
  res.json({
    issuer: SERVER_BASE_URL,
    token_endpoint: `${SERVER_BASE_URL}/oauth/token`,
    revocation_endpoint: `${SERVER_BASE_URL}/oauth/revoke`,
    grant_types_supported: ['client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    response_types_supported: ['token'],
    service_documentation: `https://financemcps.agenticledger.ai/${SLUG}/`,
  });
});

// --- OAuth 2.0 Token Exchange ---
app.post('/oauth/token', (req, res) => {
  const { grant_type, client_id, client_secret } = req.body;

  if (grant_type !== 'client_credentials') {
    res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Only client_credentials is supported' });
    return;
  }

  if (client_id !== SLUG) {
    res.status(400).json({ error: 'invalid_client', error_description: `client_id must be "${SLUG}"` });
    return;
  }

  if (!client_secret) {
    res.status(400).json({ error: 'invalid_request', error_description: 'client_secret is required (your Google OAuth access token)' });
    return;
  }

  const accessToken = `mcp_${randomUUID().replace(/-/g, '')}`;
  const expiresIn = TOKEN_TTL_MS / 1000;

  oauthTokens.set(accessToken, {
    apiKey: client_secret,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });

  res.json({
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: expiresIn,
  });
});

// --- OAuth 2.0 Token Revocation ---
app.post('/oauth/revoke', (req, res) => {
  const { token } = req.body;
  if (token) oauthTokens.delete(token);
  res.status(200).json({ status: 'revoked' });
});

// --- Smart root route: content negotiation ---
app.get('/', (req, res) => {
  const accept = req.headers.accept || '';
  if (accept.includes('text/html')) {
    res.type('html').send(renderHtmlPage());
    return;
  }
  // Default: JSON self-description for AI agents
  res.json({
    name: 'Google Apps Script MCP Server',
    provider: 'AgenticLedger',
    version: '1.0.0',
    description: 'Manage Google Apps Script projects — pull/push code, create versions, deploy, run functions, view logs. Uses the Apps Script REST API directly.',
    mcpEndpoint: '/mcp',
    transport: 'streamable-http',
    tools: tools.length,
    auth: {
      type: 'dual-mode',
      description: 'Supports both direct Bearer token and OAuth 2.0 Client Credentials. The token must be a Google OAuth access token with Apps Script scopes.',
      modes: {
        bearer: {
          description: 'Pass your Google OAuth access token directly as the Bearer token',
          header: 'Authorization: Bearer <your-google-access-token>',
        },
        oauth: {
          description: 'Exchange credentials for a time-limited token',
          token_endpoint: `${SERVER_BASE_URL}/oauth/token`,
          client_id: SLUG,
          client_secret: '<your-google-access-token>',
          grant_type: 'client_credentials',
        },
      },
      requiredScopes: [
        'https://www.googleapis.com/auth/script.projects',
        'https://www.googleapis.com/auth/script.deployments',
        'https://www.googleapis.com/auth/script.processes',
        'https://www.googleapis.com/auth/drive.file',
      ],
    },
    configTemplate: {
      mcpServers: {
        appsscript: {
          url: `${SERVER_BASE_URL}/mcp`,
          headers: { Authorization: 'Bearer <your-google-access-token>' },
        },
      },
    },
    links: {
      health: '/health',
      documentation: `https://financemcps.agenticledger.ai/${SLUG}/`,
      oauth_discovery: '/.well-known/oauth-authorization-server',
    },
  });
});

// --- Dual-mode API key resolver ---
function resolveApiKey(req: express.Request): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;

  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;

  // Mode 1: OAuth-issued token
  if (token.startsWith('mcp_')) {
    const entry = oauthTokens.get(token);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      oauthTokens.delete(token);
      return null;
    }
    return entry.apiKey;
  }

  // Mode 2: Raw access token passthrough
  return token;
}

// --- Per-session state ---
interface SessionState {
  server: Server;
  transport: StreamableHTTPServerTransport;
  client: AppsScriptClient;
}

const sessions = new Map<string, SessionState>();

function createMCPServer(client: AppsScriptClient): Server {
  const server = new Server(
    { name: 'appsscript-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);

    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    try {
      const result = await tool.handler(client, args as any);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// --- Streamable HTTP endpoint ---
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  // Existing session
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session — requires Bearer token (raw Google access token or OAuth-issued)
  const apiKey = resolveApiKey(req);
  if (!apiKey) {
    res.status(401).json({
      error: 'Missing or invalid Authorization header.',
      modes: {
        bearer: 'Authorization: Bearer <your-google-access-token>',
        oauth: `POST ${SERVER_BASE_URL}/oauth/token with client_id=${SLUG}&client_secret=<your-google-access-token>&grant_type=client_credentials`,
      },
    });
    return;
  }

  // Create per-session API client with the user's credentials
  const client = new AppsScriptClient(apiKey);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const server = createMCPServer(client);

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) {
      sessions.delete(sid);
      console.log(`[mcp] Session closed: ${sid}`);
    }
  };

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);

  const newSessionId = transport.sessionId;
  if (newSessionId) {
    sessions.set(newSessionId, { server, transport, client });
    console.log(`[mcp] New session: ${newSessionId}`);
  }
});

// GET /mcp — SSE stream for server notifications
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session. Send initialization POST first.' });
    return;
  }
  const { transport } = sessions.get(sessionId)!;
  await transport.handleRequest(req, res);
});

// DELETE /mcp — close session
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const { transport, server } = sessions.get(sessionId)!;
  await transport.close();
  await server.close();
  sessions.delete(sessionId);
  res.status(200).json({ status: 'session closed' });
});

// ==================== BRANDED HTML HELPER PAGE ====================

function renderHtmlPage(): string {
  const configTemplate = JSON.stringify(
    {
      mcpServers: {
        appsscript: {
          url: `${SERVER_BASE_URL}/mcp`,
          headers: {
            Authorization: 'Bearer YOUR_GOOGLE_ACCESS_TOKEN',
          },
        },
      },
    },
    null,
    2,
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Google Apps Script MCP Server — AgenticLedger</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'DM Sans',sans-serif;background:#f8fafc;color:#1e293b;line-height:1.6}
    .header{background:#fff;border-bottom:1px solid #e2e8f0;padding:1rem 2rem;display:flex;align-items:center;gap:0.75rem}
    .header img{height:36px}
    .header span{font-weight:700;font-size:1.1rem;color:#2563EB}
    .container{max-width:720px;margin:2rem auto;padding:0 1.5rem}
    h1{font-size:1.75rem;font-weight:700;color:#0f172a;margin-bottom:0.25rem}
    .subtitle{color:#64748b;margin-bottom:2rem}
    .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem}
    .card h2{font-size:1.1rem;font-weight:600;margin-bottom:0.75rem;color:#0f172a}
    .steps{padding-left:1.25rem}
    .steps li{margin-bottom:0.5rem}
    a{color:#2563EB;text-decoration:none}
    a:hover{text-decoration:underline}
    label{display:block;font-weight:500;margin-bottom:0.4rem}
    input[type="text"]{width:100%;padding:0.6rem 0.75rem;font-size:0.95rem;font-family:inherit;border:1px solid #cbd5e1;border-radius:8px;outline:none;transition:border-color .15s}
    input[type="text"]:focus{border-color:#2563EB;box-shadow:0 0 0 3px rgba(37,99,235,.12)}
    .code-block{position:relative;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:1rem;font-family:'Fira Mono','Consolas',monospace;font-size:0.85rem;white-space:pre;overflow-x:auto;line-height:1.5;margin-top:0.75rem}
    .copy-btn{position:absolute;top:0.5rem;right:0.5rem;background:#2563EB;color:#fff;border:none;border-radius:6px;padding:0.35rem 0.75rem;font-size:0.8rem;font-family:inherit;cursor:pointer;transition:background .15s}
    .copy-btn:hover{background:#1d4ed8}
    .copy-btn.copied{background:#16a34a}
    .badges{display:flex;flex-wrap:wrap;gap:0.75rem;margin-top:0.5rem}
    .badge{display:flex;align-items:center;gap:0.4rem;background:#f0f9ff;border:1px solid #bae6fd;color:#0369a1;border-radius:999px;padding:0.3rem 0.85rem;font-size:0.82rem;font-weight:500}
    .badge svg{width:14px;height:14px;flex-shrink:0}
    .footer{text-align:center;color:#94a3b8;font-size:0.82rem;padding:2rem 0}
  </style>
</head>
<body>
  <div class="header">
    <img src="/static/logo.png" alt="AgenticLedger" onerror="this.style.display='none'" />
    <span>AgenticLedger</span>
  </div>

  <div class="container">
    <h1>Google Apps Script MCP Server</h1>
    <p class="subtitle">Pull, push, deploy, and run Google Apps Script projects via MCP tools — powered by the Apps Script REST API.</p>

    <div class="card">
      <h2>How to get your Google OAuth Access Token</h2>
      <ol class="steps">
        <li>You need a Google OAuth access token with Apps Script scopes.</li>
        <li>The easiest way: run <code>clasp login</code> locally, then extract the access_token from <code>~/.clasprc.json</code>.</li>
        <li>Or use the <a href="https://developers.google.com/oauthplayground/" target="_blank" rel="noopener">Google OAuth Playground</a> with these scopes:<br />
          <code>script.projects, script.deployments, script.processes, drive.file</code></li>
        <li>Paste the access token below to generate your MCP config.</li>
      </ol>
    </div>

    <div class="card">
      <h2>Generate your MCP config</h2>
      <label for="apiKey">Google OAuth Access Token</label>
      <input type="text" id="apiKey" placeholder="Paste your access token here…" autocomplete="off" spellcheck="false" />
      <div class="code-block" id="configBlock">${escapeHtml(configTemplate)}</div>
      <button class="copy-btn" id="copyBtn" onclick="copyConfig()">Copy</button>
    </div>

    <div class="card">
      <h2>Trust &amp; Security</h2>
      <div class="badges">
        <span class="badge">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          No credentials stored
        </span>
        <span class="badge">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          Dual-mode auth
        </span>
        <span class="badge">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          Per-session isolation
        </span>
      </div>
    </div>

    <div class="card">
      <h2>${tools.length} Tools Available</h2>
      <ul class="steps">
        <li><strong>project_create / project_get</strong> — Create and inspect script projects</li>
        <li><strong>content_get / content_update</strong> — Pull and push script files (equivalent to clasp pull/push)</li>
        <li><strong>version_create / versions_list</strong> — Create immutable snapshots</li>
        <li><strong>deployment_create / deployments_list</strong> — Deploy and manage web apps</li>
        <li><strong>script_run</strong> — Execute functions remotely</li>
        <li><strong>processes_list / script_processes_list</strong> — View execution logs</li>
        <li><strong>metrics_get</strong> — Execution stats and error rates</li>
      </ul>
    </div>

    <div class="footer">Powered by AgenticLedger &middot; ${tools.length} tools available &middot; <a href="https://financemcps.agenticledger.ai/" style="color:#2563EB;text-decoration:none">Explore Other MCPs</a></div>
  </div>

  <script>
    const apiKeyInput = document.getElementById('apiKey');
    const configBlock = document.getElementById('configBlock');
    const baseUrl = ${JSON.stringify(SERVER_BASE_URL)};

    function buildConfig(key) {
      return JSON.stringify({
        mcpServers: {
          appsscript: {
            url: baseUrl + '/mcp',
            headers: {
              Authorization: 'Bearer ' + (key || 'YOUR_GOOGLE_ACCESS_TOKEN')
            }
          }
        }
      }, null, 2);
    }

    apiKeyInput.addEventListener('input', function () {
      configBlock.textContent = buildConfig(this.value.trim());
    });

    function copyConfig() {
      const btn = document.getElementById('copyBtn');
      navigator.clipboard.writeText(configBlock.textContent).then(function () {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
      });
    }
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.listen(PORT, () => {
  console.log(`Google Apps Script MCP HTTP Server running on port ${PORT}`);
  console.log(`  MCP endpoint:   ${SERVER_BASE_URL}/mcp`);
  console.log(`  Health check:   ${SERVER_BASE_URL}/health`);
  console.log(`  Tools:          ${tools.length}`);
  console.log(`  Transport:      Streamable HTTP`);
  console.log(`  Auth:           Dual-mode (Bearer passthrough + OAuth Client Credentials)`);
});
