#!/usr/bin/env node

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

// SDK and Project Imports
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'; // Adjust path if necessary
// import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"; // Base Transport type if needed
import { NEON_HANDLERS, NEON_TOOLS, ToolHandler } from './tools.js';
import { NEON_RESOURCES } from './resources.js';
import { handleInit, parseArgs } from './initConfig.js';
import { createApiClient } from '@neondatabase/api-client';
import './polyfills.js';

// --- Environment Variable Reading ---
const EXPECTED_AUTH_TOKEN = process.env.AUTH_TOKEN;
const NEON_API_KEY_FROM_ENV = process.env.NEON_API_KEY;

if (!EXPECTED_AUTH_TOKEN) {
  console.error("FATAL ERROR: Environment variable 'AUTH_TOKEN' is not set.");
  process.exit(1);
}

// --- Initial Setup ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ** FIX: Restore fs.readFileSync inside JSON.parse **
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
);

const commands = ['init', 'start'] as const;
const { command, neonApiKey: neonApiKeyFromArgs, executablePath } = parseArgs(); // Assumes corrected parseArgs
if (!commands.includes(command as (typeof commands)[number])) {
   console.error(`Invalid command: ${command}`); process.exit(1);
}
const neonApiKey = command === 'start' ? NEON_API_KEY_FROM_ENV : neonApiKeyFromArgs; // Assumes corrected parseArgs
if (command === 'start' && !neonApiKey) {
    console.warn('Warning: NEON_API_KEY environment variable is not set.');
}
if (command === 'init') {
  await handleInit({
    executablePath: executablePath || '',
    neonApiKey: neonApiKey || '', // Assumes corrected parseArgs returns these
  });
  process.exit(0);
}

// --- Start Command Execution ---

// ** FIX: Restore arguments for createApiClient **
export const neonClient = createApiClient({
  apiKey: neonApiKey || '', // Pass the determined API key
  headers: {
    'User-Agent': `mcp-server-neon/${packageJson.version}`,
  },
});

// ** FIX: Restore arguments for McpServer constructor **
const mcpServer = new McpServer(
  { // Server Info
    name: 'mcp-server-neon',
    version: packageJson.version,
  },
  { // Options
    capabilities: {
      tools: {}, // Populated below
      resources: {}, // Populated below
    },
  },
);

// ** FIX: Restore Tool Registration Logic **
NEON_TOOLS.forEach((tool) => {
  const handler = NEON_HANDLERS[tool.name];
  if (!handler) {
    throw new Error(`Handler for tool ${tool.name} not found`);
  }
  mcpServer.tool(
    tool.name,
    tool.description,
    { params: tool.inputSchema },
    handler as ToolHandler<typeof tool.name>,
  );
});

// ** FIX: Restore Resource Registration Logic **
NEON_RESOURCES.forEach((resource) => {
  mcpServer.resource(
    resource.name,
    resource.uri,
    {
      description: resource.description,
      mimeType: resource.mimeType,
    },
    resource.handler,
  );
});
// --- End Tool/Resource Registration ---


// --- HTTP Server using SSEServerTransport ---
const PORT: number = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const activeConnections = new Map<string, SSEServerTransport>();
const MCP_POST_PATH = '/mcp-post'; // Base path for POSTs

// ** FIX: Ensure checkAuth always returns boolean **
function checkAuth(req: http.IncomingMessage): boolean {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    if (!token) {
        console.warn('Auth Warning: Missing token'); return false; // Returns false
    }
    if (token !== EXPECTED_AUTH_TOKEN) {
        console.warn('Auth Warning: Invalid token'); return false; // Returns false
    }
    return true; // Explicitly return true if checks pass
}

const httpServer = http.createServer(async (req, res) => {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Authentication Check
    if (!checkAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
    }

    // --- Routing ---
    const url = new URL(req.url || '', `http://${req.headers.host}`);

    // 1. SSE Connection Endpoint (GET /mcp-sse)
    if (url.pathname === '/mcp-sse' && req.method === 'GET') {
        console.log('Client requesting SSE connection...');
        try {
            const transport = new SSEServerTransport(MCP_POST_PATH, res);
            const sessionId = transport.sessionId;
            console.log(`Generated session ID: ${sessionId}`);
            activeConnections.set(sessionId, transport);
            console.log(`Active connections: ${activeConnections.size}`);

            // Start transport (sends headers and endpoint event)
            await transport.start();
            // Connect transport to MCP Server logic
            await mcpServer.connect(transport);
            console.log(`MCP Server connected to transport for session ${sessionId}`);

            // Handle disconnect
            req.on('close', () => {
                console.log(`Client disconnected for session ${sessionId}. Cleaning up.`);
                activeConnections.delete(sessionId);
                transport.close();
                console.log(`Active connections after close: ${activeConnections.size}`);
            });
        } catch (error) {
            console.error("Error setting up SSE connection:", error);
            if (!res.writableEnded) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Failed to establish SSE connection" }));
            }
        }
    // 2. Incoming Message Endpoint (POST /mcp-post?sessionId=...)
    } else if (url.pathname === MCP_POST_PATH && req.method === 'POST') {
        const sessionId = url.searchParams.get('sessionId');
        console.log(`Received POST on ${MCP_POST_PATH} for session ${sessionId}`);
        if (!sessionId) {
             res.writeHead(400, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ error: 'Missing sessionId query parameter' }));
             return;
        }
        const transport = activeConnections.get(sessionId);
        if (!transport) {
             console.warn(`Received POST for unknown/disconnected session: ${sessionId}`);
             res.writeHead(404, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ error: 'Session not found or inactive' }));
             return;
        }
        try {
            await transport.handlePostMessage(req, res); // Delegate to SDK transport
            console.log(`Handled POST message for session ${sessionId}`);
        } catch (error) {
            console.error(`Error handling POST message for session ${sessionId}:`, error);
            if (!res.writableEnded) {
                 res.writeHead(500, { 'Content-Type': 'application/json' });
                 res.end(JSON.stringify({ error: 'Failed to process message' }));
            }
        }
    } else {
        // Handle other paths -> 404 Not Found
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    }
});

// --- Server Start Function ---
async function main() {
  httpServer.listen(PORT, HOST, () => {
    console.log(`MCP HTTP+SSE server listening on http://${HOST}:${PORT}`);
    console.log(`SSE connections expected at /mcp-sse`);
    console.log(`Client POSTs expected at ${MCP_POST_PATH}?sessionId=...`);
    console.log(`Render service accessible via its .onrender.com URL`);
    console.log(`Using Neon API Key: ${neonApiKey ? 'Provided' : 'Not Provided/Required'}`);
    console.log(`API Authentication: Enabled (Bearer Token)`);
  });
}

// --- Run Server ---
if (command === 'start') {
  main().catch((error: unknown) => {
    console.error('Server failed to start:', error);
    process.exit(1);
  });
}