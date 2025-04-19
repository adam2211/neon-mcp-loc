import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import chalk from 'chalk';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
);
// Determine Claude config path based on OS platform
let claudeConfigPath: string;
const platform = os.platform();

if (platform === 'win32') {
  // Windows path - using %APPDATA%
  // For Node.js, we access %APPDATA% via process.env.APPDATA
  claudeConfigPath = path.join(
    process.env.APPDATA || '',
    'Claude',
    'claude_desktop_config.json',
  );
} else {
  // macOS and Linux path (according to official docs)
  claudeConfigPath = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Claude',
    'claude_desktop_config.json',
  );
}

const MCP_NEON_SERVER = 'neon';

// Replace the entire existing parseArgs function in src/initConfig.ts with this:

export const parseArgs = () => {
  // process.argv usually looks like: ['/path/to/node', '/path/to/script.js', 'arg1', 'arg2', ...]
  const args = process.argv;
  const executablePath = args[1]; // Path to the script (e.g., 'dist/index.js')
  const command = args[2];       // Should be 'init' or 'start'

  let neonApiKey: string | undefined;

  if (command === 'start') {
    // For 'start', read API key from environment variable
    neonApiKey = process.env.NEON_API_KEY;
    if (!neonApiKey) {
      // You might want to make this an error if the key is absolutely required
      console.warn(
        'Warning: NEON_API_KEY environment variable is not set. This might be required.',
      );
    }
    // Optional: Check if extra unexpected arguments were passed to 'start'
    if (args.length > 3) {
      console.warn(`Warning: 'start' command received unexpected arguments: ${args.slice(3).join(' ')}`);
    }

  } else if (command === 'init') {
    // For 'init', expect API key as the next argument (arg[3])
    if (args.length < 4) { // Expecting 'node', 'script', 'init', 'apiKey'
      console.error(
        'Error: The "init" command requires the NEON_API_KEY as the next argument.',
      );
      console.error('Example: node dist/index.js init YOUR_API_KEY');
      process.exit(1);
    }
    neonApiKey = args[3]; // API key from command line for init

  } else {
    // Handle invalid command explicitly (although index.ts also checks)
    console.error(`Invalid command provided: "${command}". Must be 'init' or 'start'.`);
    process.exit(1);
  }

  // Return the parsed values
  // Ensure neonApiKey is returned as a string, even if undefined initially
  return {
    command: command as 'init' | 'start', // Type assertion for clarity
    neonApiKey: neonApiKey || '', // Return empty string if undefined/null
    executablePath: executablePath || '',
  };
};

export function handleInit({
  executablePath,
  neonApiKey,
}: {
  executablePath: string;
  neonApiKey: string;
}) {
  // If the executable path is a local path to the dist/index.js file, use it directly
  // Otherwise, use the name of the package to always load the latest version from remote
  const serverPath = executablePath.includes('dist/index.js')
    ? executablePath
    : packageJson.name;

  const neonConfig = {
    command: 'npx',
    args: ['-y', serverPath, 'start', neonApiKey],
  };

  const configDir = path.dirname(claudeConfigPath);
  if (!fs.existsSync(configDir)) {
    console.log(chalk.blue('Creating Claude config directory...'));
    fs.mkdirSync(configDir, { recursive: true });
  }

  const existingConfig = fs.existsSync(claudeConfigPath)
    ? JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8'))
    : { mcpServers: {} };

  if (MCP_NEON_SERVER in (existingConfig?.mcpServers || {})) {
    console.log(chalk.yellow('Replacing existing Neon MCP config...'));
  }

  const newConfig = {
    ...existingConfig,
    mcpServers: {
      ...existingConfig.mcpServers,
      [MCP_NEON_SERVER]: neonConfig,
    },
  };

  fs.writeFileSync(claudeConfigPath, JSON.stringify(newConfig, null, 2));
  console.log(chalk.green(`Config written to: ${claudeConfigPath}`));
  console.log(
    chalk.blue(
      'The Neon MCP server will start automatically the next time you open Claude.',
    ),
  );
}
