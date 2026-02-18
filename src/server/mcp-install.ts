import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type InstallResult = {
  installed: boolean;
  provider: string;
  scope: 'user' | null;
  reason?: string;
};

const DEFAULT_MCP_URL = 'https://mcp.popmelt.com/mcp';

export async function installClaudeMcp(serverUrl = DEFAULT_MCP_URL): Promise<InstallResult> {
  const configPath = join(homedir(), '.claude.json');

  let config: Record<string, unknown>;
  try {
    const raw = await readFile(configPath, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    config = {};
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  const mcpServers = config.mcpServers as Record<string, unknown>;

  // Check if popmelt is already configured (case-insensitive)
  for (const key of Object.keys(mcpServers)) {
    if (/popmelt/i.test(key)) {
      return { installed: false, provider: 'claude', scope: null, reason: 'already_configured' };
    }
  }

  mcpServers.popmelt = { type: 'http', url: serverUrl };
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  return { installed: true, provider: 'claude', scope: 'user' };
}

export async function installCodexMcp(serverUrl = DEFAULT_MCP_URL): Promise<InstallResult> {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const configPath = join(codexHome, 'config.toml');

  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch {
    content = '';
  }

  // Check if [mcp_servers.popmelt] (or variant) already exists
  if (/\[mcp_servers\.[^\]]*popmelt[^\]]*\]/i.test(content)) {
    return { installed: false, provider: 'codex', scope: null, reason: 'already_configured' };
  }

  // Ensure directory exists
  await mkdir(dirname(configPath), { recursive: true });

  // Append TOML section
  const section = `\n[mcp_servers.popmelt]\nurl = "${serverUrl}"\n`;
  await writeFile(configPath, content + section, 'utf-8');

  return { installed: true, provider: 'codex', scope: 'user' };
}
