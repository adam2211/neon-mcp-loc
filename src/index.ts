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

// --- Environment Variable Reading ---
const EXPECTED_AUTH_TOKEN = process.env.AUTH_TOKEN;
const NEON_API_KEY_FROM_ENV = process.env.NEON_API_KEY;

if (!EXPECTED_AUTH_TOKEN) {
  console.error("FATAL ERROR: Environment variable 'AUTH_TOKEN' is not set.");
  process.exit(1);
}

// --- Initial Setup ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
);

const commands = ['init', 'start'] as const;
const { command, neonApiKey: neonApiKeyFromArgs, executablePath } = parseArgs();

if (!commands.includes(command as (typeof commands)[number])) {
  console.error(`Invalid command: ${command}`);
  process.exit(1);
}

const neonApiKey = command === 'start' ? NEON_API_KEY_FROM_ENV : neonApiKeyFromArgs;

if (command === 'start' && !neonApiKey) {
     console.warn('Warning: NEON_API_KEY environment variable is not set.');
}

if (command === 'init') {
  await handleInit({
    executablePath: executablePath || '',
    neonApiKey: neonApiKey || '',
  });
  process.exit(0);
}

// --- Start Command Execution ---

export const neonClient = createApiClient({
  apiKey: neonApiKey || '',
  headers: {
    'User-Agent': `mcp-server-neon/${packageJson.version}`,
  },
});

// --- ** FIX: Restored McpServer constructor arguments ** ---
const server = new McpServer(
  {
    name: 'mcp-server-neon',
    version: packageJson.version,
  },
  {
    capabilities: {
      tools: {}, // These might be populated dynamically by server.tool below
      resources: {}, // These might be populated dynamically by server.resource below
    },
  },
);

// --- ** FIX: Restored Tool Registration Logic ** ---
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

// --- ** FIX: Restored Resource Registration Logic ** ---
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
// --- End Tool/Resource Registration ---


// --- Express App Setup ---
const app = express();
const PORT: number = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

app.use(express.json());

// --- Authentication Middleware ---
// ** FIX: Ensure no 'return' before res.status().json() **
const authenticateToken: RequestHandler = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    console.warn('Auth Warning: Missing Authorization header or Bearer prefix.');
    res.status(401).json({ error: 'Unauthorized: Missing token' }); // No return
    return; // Exit function
  }

  if (token !== EXPECTED_AUTH_TOKEN) {
    console.warn('Auth Warning: Invalid token received.');
    res.status(403).json({ error: 'Forbidden: Invalid token' }); // No return
    return; // Exit function
  }

  next(); // Token is valid
};

// --- Express Routes ---
app.get('/', (req: Request, res: Response) => {
  res.send(`MCP Server Neon (v${packageJson.version}) is running. Use API endpoints.`);
});

// Apply authentication middleware to all routes starting with /api
app.use('/api', authenticateToken);

// --- Protected API Routes ---
app.get('/api/status', (req: Request, res: Response) => {
  res.json({
    status: 'running',
    name: 'mcp-server-neon',
    version: packageJson.version,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/tools', (req: Request, res: Response, next: NextFunction) => {
  try {
    const toolList = NEON_TOOLS.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    res.status(200).json(toolList);
  } catch (error: unknown) {
     console.error("Error retrieving tool list:", error);
     next(error);
  }
});

const handleToolExecution: RequestHandler = async (req, res, next) => {
  const toolName = req.params.toolName;
  const params = req.body;
  try {
    const toolDefinition = NEON_TOOLS.find(t => t.name === toolName);
    const handler = NEON_HANDLERS[toolName as keyof typeof NEON_HANDLERS];
    if (!toolDefinition || !handler) {
      res.status(404).json({ error: `Tool '${toolName}' not found.` }); // No return
      return;
    }
    const validationResult = toolDefinition.inputSchema.safeParse(params);
    if (!validationResult.success) {
      console.error(`Validation error for tool '${toolName}':`, validationResult.error.errors);
      res.status(400).json({ // No return
        error: 'Invalid input parameters.',
        details: validationResult.error.format(),
      });
      return;
    }
    const validatedParams = validationResult.data;
    console.log(`Executing tool '${toolName}' with params:`, validatedParams);
    const result = await handler(validatedParams as any); // Keep 'as any' for now
    console.log(`Tool '${toolName}' executed successfully.`);
    res.status(200).json(result); // No return
  } catch (error: unknown) {
    console.error(`Error caught in handleToolExecution for tool '${toolName}':`, error);
    next(error);
  }
};

app.post('/api/tools/:toolName/execute', handleToolExecution);

// --- Global Error Handling Middleware (must be LAST) ---
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(`Unhandled Error: ${req.method} ${req.path}`, err);
  if (res.headersSent) {
    return next(err);
  }
  const statusCode = typeof err?.status === 'number' ? err.status : 500;
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  res.status(statusCode).json({ error: message });
});

// --- Server Start Function ---
async function main() {
  app.listen(PORT, HOST, () => {
    console.log(`HTTP server listening on http://${HOST}:${PORT}`);
    console.log(`Render service accessible via its .onrender.com URL`);
    console.log(`Using Neon API Key: ${neonApiKey ? 'Provided' : 'Not Provided/Required'}`);
    console.log(`API Authentication: Enabled`);
  });
}

// --- Run Server ---
if (command === 'start') {
  main().catch((error: unknown) => {
    console.error('Server failed to start:', error);
    process.exit(1);
  });
}