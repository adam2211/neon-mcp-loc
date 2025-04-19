#!/usr/bin/env node

import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError } from 'zod';
// import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'; // Commented out stdio transport
import { NEON_HANDLERS, NEON_TOOLS, ToolHandler } from './tools.js';
import { NEON_RESOURCES } from './resources.js';
import { handleInit, parseArgs } from './initConfig.js'; // Assuming corrected parseArgs is here
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
  await handleInit({
    executablePath: executablePath || '',
    neonApiKey: neonApiKey || '',
  });
  process.exit(0);
}

export const neonClient = createApiClient({
  apiKey: neonApiKey,
  headers: {
    'User-Agent': `mcp-server-neon/${packageJson.version}`,
  },
});

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

const app = express();
const PORT: number = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

app.use(express.json());

app.get('/', (req: Request, res: Response) => {
  res.send(`MCP Server Neon (v${packageJson.version}) is running. Use API endpoints.`);
});

app.get('/api/status', (req: Request, res: Response) => {
  res.json({
    status: 'running',
    name: 'mcp-server-neon',
    version: packageJson.version,
    timestamp: new Date().toISOString(),
  });
});

// --- Endpoint Handler for executing MCP tools ---
const handleToolExecution: RequestHandler = async (req, res, next) => {
  const toolName = req.params.toolName;
  const params = req.body;

  try {
    const toolDefinition = NEON_TOOLS.find(t => t.name === toolName);
    const handler = NEON_HANDLERS[toolName as keyof typeof NEON_HANDLERS];

    if (!toolDefinition || !handler) {
      // ** MODIFICATION: Removed 'return' **
      res.status(404).json({ error: `Tool '${toolName}' not found.` });
      return; // Use simple return to exit function if needed
    }

    const validationResult = toolDefinition.inputSchema.safeParse(params);

    if (!validationResult.success) {
      console.error(`Validation error for tool '${toolName}':`, validationResult.error.errors);
      // ** MODIFICATION: Removed 'return' **
      res.status(400).json({
        error: 'Invalid input parameters.',
        details: validationResult.error.format(),
      });
      return; // Use simple return to exit function if needed
    }

    const validatedParams = validationResult.data;

    console.log(`Executing tool '${toolName}' with params:`, validatedParams);
    const result = await handler(validatedParams as any); // Keep 'as any' for now
    console.log(`Tool '${toolName}' executed successfully.`);

    // ** MODIFICATION: Removed 'return' **
    res.status(200).json(result);
    // No explicit return needed here as it's the end of the try block

  } catch (error: unknown) {
    console.error(`Error caught in handleToolExecution for tool '${toolName}':`, error);
    next(error); // Pass error to the error handling middleware
  }
};

// Use the defined handler function for the route
app.post('/api/tools/:toolName/execute', handleToolExecution);

// --- Error handling middleware (must be LAST) ---
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(`Unhandled Error: ${req.method} ${req.path}`, err);
  if (res.headersSent) {
    return next(err);
  }
  const statusCode = typeof err?.status === 'number' ? err.status : 500;
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  res.status(statusCode).json({ error: message });
});

async function main() {
  app.listen(PORT, HOST, () => {
    console.log(`HTTP server listening on http://${HOST}:${PORT}`);
    console.log(`Render service accessible via its .onrender.com URL`);
    console.log(`Using Neon API Key: ${neonApiKey ? 'Provided' : 'Not Provided/Required'}`);
  });
}

main().catch((error: unknown) => {
  console.error('Server failed to start:', error);
  process.exit(1);
});