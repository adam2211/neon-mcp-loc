#!/usr/bin/env node

import express from 'express';
// import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'; // Commented out stdio transport
import { NEON_HANDLERS, NEON_TOOLS, ToolHandler } from './tools.js';
import { NEON_RESOURCES } from './resources.js';
import { handleInit, parseArgs } from './initConfig.js';
import { createApiClient } from '@neondatabase/api-client';
import './polyfills.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
);

const commands = ['init', 'start'] as const;
const { command, neonApiKey, executablePath } = parseArgs();
if (!commands.includes(command as (typeof commands)[number])) {
  console.error(`Invalid command: ${command}`);
  process.exit(1);
}

if (command === 'init') {
  // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression, @typescript-eslint/await-thenable
  await handleInit({
    executablePath,
    neonApiKey,
  });
  process.exit(0);
}

// "start" command from here
// ----------------------------

// --- Neon API Client Setup (Existing) ---
export const neonClient = createApiClient({
  apiKey: neonApiKey, // Make sure neonApiKey is available via env var or other means on Render
  headers: {
    'User-Agent': `mcp-server-neon/${packageJson.version}`,
  },
});

// --- MCP Server Setup (Existing) ---
const server = new McpServer(
  {
    name: 'mcp-server-neon',
    version: packageJson.version,
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  },
);

// Register tools (Existing)
NEON_TOOLS.forEach((tool) => {
  const handler = NEON_HANDLERS[tool.name];
  if (!handler) {
    throw new Error(`Handler for tool ${tool.name} not found`);
  }

  server.tool(
    tool.name,
    tool.description,
    { params: tool.inputSchema },
    handler as ToolHandler<typeof tool.name>,
  );
});

// Register resources (Existing)
NEON_RESOURCES.forEach((resource) => {
  server.resource(
    resource.name,
    resource.uri,
    {
      description: resource.description,
      mimeType: resource.mimeType,
    },
    resource.handler,
  );
});

// --- Express HTTP Server Setup ---
const app = express();
// ** FIX: Ensure PORT is a number using parseInt **
const PORT: number = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0'; // Listen on all interfaces for Render compatibility

// Middleware (optional: add body parsing, cors, etc. if needed)
app.use(express.json());

// --- Define Your HTTP API Routes Here ---
app.get('/', (req, res) => {
  res.send(`MCP Server Neon (v${packageJson.version}) is running. Use API endpoints.`);
});

app.get('/api/status', (req, res) => {
  // ** FIX: Use known name and version from packageJson directly **
  res.json({
    status: 'running',
    name: 'mcp-server-neon',          // Use the known name directly
    version: packageJson.version,      // Use the version from package.json
    timestamp: new Date().toISOString(),
  });
});

// Add more routes (GET, POST, etc.) as needed.

/**
 * Start the HTTP server.
 */
async function main() {
  // Start Express server
  app.listen(PORT, HOST, () => { // PORT is now guaranteed to be a number
    console.log(`HTTP server listening on http://${HOST}:${PORT}`);
    console.log(`Render service accessible via its .onrender.com URL`);
    console.log(`Using Neon API Key: ${neonApiKey ? 'Provided' : 'Not Provided'}`);
  });
}

main().catch((error: unknown) => {
  console.error('Server failed to start:', error);
  process.exit(1);
});