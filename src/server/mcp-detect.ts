import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { McpDetection } from './types';

const POPMELT_RE = /popmelt/i;

function notFound(): McpDetection {
  return { found: false, name: null, scope: null, disabled: false };
}

function found(name: string, scope: McpDetection['scope'], disabled = false): McpDetection {
  return { found: true, name, scope, disabled };
}

function findPopmeltKey(obj: Record<string, unknown>): string | null {
  for (const key of Object.keys(obj)) {
    if (POPMELT_RE.test(key)) return key;
  }
  return null;
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function detectClaudeMcp(projectRoot: string): Promise<McpDetection> {
  const home = homedir();

  // 1. Read ~/.claude.json
  const claudeConfig = await readJson(join(home, '.claude.json'));

  if (claudeConfig && typeof claudeConfig === 'object') {
    const config = claudeConfig as Record<string, unknown>;

    // Check top-level mcpServers → scope: 'user'
    if (config.mcpServers && typeof config.mcpServers === 'object') {
      const key = findPopmeltKey(config.mcpServers as Record<string, unknown>);
      if (key) return found(key, 'user');
    }

    // Check projects[projectRoot].mcpServers → scope: 'project'
    if (config.projects && typeof config.projects === 'object') {
      const projects = config.projects as Record<string, unknown>;
      const projectEntry = projects[projectRoot];
      if (projectEntry && typeof projectEntry === 'object') {
        const project = projectEntry as Record<string, unknown>;
        if (project.mcpServers && typeof project.mcpServers === 'object') {
          const key = findPopmeltKey(project.mcpServers as Record<string, unknown>);
          if (key) {
            // Check disabledMcpjsonServers in same project entry
            const disabled = Array.isArray(project.disabledMcpjsonServers)
              && (project.disabledMcpjsonServers as string[]).some(s => POPMELT_RE.test(s));
            return found(key, 'project', disabled);
          }
        }
      }
    }
  }

  // 2. Read <projectRoot>/.mcp.json
  const mcpJson = await readJson(join(projectRoot, '.mcp.json'));
  if (mcpJson && typeof mcpJson === 'object') {
    const mcp = mcpJson as Record<string, unknown>;

    // Check mcpServers wrapper
    if (mcp.mcpServers && typeof mcp.mcpServers === 'object') {
      const key = findPopmeltKey(mcp.mcpServers as Record<string, unknown>);
      if (key) {
        const disabled = await isDisabledInClaudeSettings(projectRoot, key);
        return found(key, 'mcp.json', disabled);
      }
    }

    // Check flat format (keys directly in root)
    const key = findPopmeltKey(mcp);
    if (key && key !== 'mcpServers') {
      const disabled = await isDisabledInClaudeSettings(projectRoot, key);
      return found(key, 'mcp.json', disabled);
    }
  }

  return notFound();
}

async function isDisabledInClaudeSettings(projectRoot: string, serverName: string): Promise<boolean> {
  const settingsPath = join(projectRoot, '.claude', 'settings.local.json');
  const settings = await readJson(settingsPath);
  if (settings && typeof settings === 'object') {
    const s = settings as Record<string, unknown>;
    if (Array.isArray(s.disabledMcpjsonServers)) {
      return (s.disabledMcpjsonServers as string[]).some(name => name === serverName);
    }
  }
  return false;
}

// Simple TOML section parser — no library needed.
// Matches [mcp_servers.<name>] headers and extracts section bodies.
const TOML_SECTION_RE = /^\[mcp_servers\.([^\]]+)\]/;

type TomlSection = { name: string; body: string };

function parseTomlMcpSections(content: string): TomlSection[] {
  const lines = content.split('\n');
  const sections: TomlSection[] = [];
  let current: { name: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const match = line.match(TOML_SECTION_RE);
    if (match) {
      if (current) {
        sections.push({ name: current.name, body: current.bodyLines.join('\n') });
      }
      current = { name: match[1]!, bodyLines: [] };
    } else if (line.startsWith('[')) {
      // New non-mcp_servers section — close current
      if (current) {
        sections.push({ name: current.name, body: current.bodyLines.join('\n') });
        current = null;
      }
    } else if (current) {
      current.bodyLines.push(line);
    }
  }

  if (current) {
    sections.push({ name: current.name, body: current.bodyLines.join('\n') });
  }

  return sections;
}

function isSectionDisabled(body: string): boolean {
  return /enabled\s*=\s*false/i.test(body);
}

export async function detectCodexMcp(projectRoot: string): Promise<McpDetection> {
  // 1. Global config: $CODEX_HOME/config.toml or ~/.codex/config.toml
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const globalResult = await detectCodexFromFile(join(codexHome, 'config.toml'), 'user');
  if (globalResult.found) return globalResult;

  // 2. Project config: <projectRoot>/.codex/config.toml
  const projectResult = await detectCodexFromFile(join(projectRoot, '.codex', 'config.toml'), 'project');
  if (projectResult.found) return projectResult;

  return notFound();
}

async function detectCodexFromFile(filePath: string, scope: 'user' | 'project'): Promise<McpDetection> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const sections = parseTomlMcpSections(content);

    for (const section of sections) {
      if (POPMELT_RE.test(section.name)) {
        const disabled = isSectionDisabled(section.body);
        return found(section.name, scope, disabled);
      }
    }
  } catch {
    // File doesn't exist or can't be read
  }

  return notFound();
}
