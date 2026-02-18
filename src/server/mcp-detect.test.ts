import { describe, it, expect, vi, beforeEach } from 'vitest';

import { detectClaudeMcp, detectCodexMcp } from './mcp-detect';

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

// Mock node:os
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
}));

import { readFile } from 'node:fs/promises';

const mockReadFile = vi.mocked(readFile);

function fileMap(files: Record<string, string>) {
  mockReadFile.mockImplementation(async (path: any) => {
    const p = typeof path === 'string' ? path : String(path);
    if (p in files) return files[p]!;
    throw new Error(`ENOENT: no such file: ${p}`);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.CODEX_HOME;
});

// ─── detectClaudeMcp ───────────────────────────────────────────────

describe('detectClaudeMcp', () => {
  it('detects user-level mcpServers with "popmelt" key', async () => {
    fileMap({
      '/home/testuser/.claude.json': JSON.stringify({
        mcpServers: {
          popmelt: { url: 'http://localhost:3000', headers: { Authorization: 'Bearer secret' } },
        },
      }),
    });

    const result = await detectClaudeMcp('/projects/myapp');
    expect(result).toEqual({ found: true, name: 'popmelt', scope: 'user', disabled: false });
  });

  it('detects project-level mcpServers', async () => {
    fileMap({
      '/home/testuser/.claude.json': JSON.stringify({
        projects: {
          '/projects/myapp': {
            mcpServers: {
              '@popmelt.com/core': { url: 'https://api.popmelt.com' },
            },
          },
        },
      }),
    });

    const result = await detectClaudeMcp('/projects/myapp');
    expect(result).toEqual({ found: true, name: '@popmelt.com/core', scope: 'project', disabled: false });
  });

  it('detects disabled project-level server via disabledMcpjsonServers', async () => {
    fileMap({
      '/home/testuser/.claude.json': JSON.stringify({
        projects: {
          '/projects/myapp': {
            mcpServers: {
              popmelt: { url: 'http://localhost:3000' },
            },
            disabledMcpjsonServers: ['popmelt'],
          },
        },
      }),
    });

    const result = await detectClaudeMcp('/projects/myapp');
    expect(result).toEqual({ found: true, name: 'popmelt', scope: 'project', disabled: true });
  });

  it('detects .mcp.json flat format', async () => {
    fileMap({
      '/home/testuser/.claude.json': '{}',
      '/projects/myapp/.mcp.json': JSON.stringify({
        popmelt: { command: 'npx', args: ['@popmelt.com/core'] },
      }),
    });

    const result = await detectClaudeMcp('/projects/myapp');
    expect(result).toEqual({ found: true, name: 'popmelt', scope: 'mcp.json', disabled: false });
  });

  it('detects .mcp.json with mcpServers wrapper', async () => {
    fileMap({
      '/home/testuser/.claude.json': '{}',
      '/projects/myapp/.mcp.json': JSON.stringify({
        mcpServers: {
          'popmelt-dev': { command: 'node', args: ['server.js'] },
        },
      }),
    });

    const result = await detectClaudeMcp('/projects/myapp');
    expect(result).toEqual({ found: true, name: 'popmelt-dev', scope: 'mcp.json', disabled: false });
  });

  it('detects disabled .mcp.json server via claude settings.local.json', async () => {
    fileMap({
      '/home/testuser/.claude.json': '{}',
      '/projects/myapp/.mcp.json': JSON.stringify({
        mcpServers: {
          popmelt: { command: 'npx', args: ['@popmelt.com/core'] },
        },
      }),
      '/projects/myapp/.claude/settings.local.json': JSON.stringify({
        disabledMcpjsonServers: ['popmelt'],
      }),
    });

    const result = await detectClaudeMcp('/projects/myapp');
    expect(result).toEqual({ found: true, name: 'popmelt', scope: 'mcp.json', disabled: true });
  });

  it('returns not found when no config files exist', async () => {
    fileMap({});

    const result = await detectClaudeMcp('/projects/myapp');
    expect(result).toEqual({ found: false, name: null, scope: null, disabled: false });
  });

  it('returns not found when config exists but no popmelt entry', async () => {
    fileMap({
      '/home/testuser/.claude.json': JSON.stringify({
        mcpServers: {
          'some-other-server': { url: 'http://localhost:4000' },
        },
      }),
    });

    const result = await detectClaudeMcp('/projects/myapp');
    expect(result).toEqual({ found: false, name: null, scope: null, disabled: false });
  });

  it('matches name variations case-insensitively: "Popmelt", "@popmelt.com/core", "popmelt-dev"', async () => {
    // Test case insensitivity
    fileMap({
      '/home/testuser/.claude.json': JSON.stringify({
        mcpServers: {
          Popmelt: { url: 'http://localhost:3000' },
        },
      }),
    });
    expect((await detectClaudeMcp('/projects/myapp')).found).toBe(true);

    // Test @popmelt.com/core
    fileMap({
      '/home/testuser/.claude.json': JSON.stringify({
        mcpServers: {
          '@popmelt.com/core': { url: 'http://localhost:3000' },
        },
      }),
    });
    expect((await detectClaudeMcp('/projects/myapp')).name).toBe('@popmelt.com/core');

    // Test popmelt-dev
    fileMap({
      '/home/testuser/.claude.json': JSON.stringify({
        mcpServers: {
          'popmelt-dev': { url: 'http://localhost:3000' },
        },
      }),
    });
    expect((await detectClaudeMcp('/projects/myapp')).name).toBe('popmelt-dev');
  });

  it('user scope wins over project scope', async () => {
    fileMap({
      '/home/testuser/.claude.json': JSON.stringify({
        mcpServers: {
          popmelt: { url: 'http://user-level' },
        },
        projects: {
          '/projects/myapp': {
            mcpServers: {
              'popmelt-project': { url: 'http://project-level' },
            },
          },
        },
      }),
    });

    const result = await detectClaudeMcp('/projects/myapp');
    expect(result.scope).toBe('user');
    expect(result.name).toBe('popmelt');
  });

  it('never exposes url, headers, or credentials in result', async () => {
    fileMap({
      '/home/testuser/.claude.json': JSON.stringify({
        mcpServers: {
          popmelt: {
            url: 'https://api.popmelt.com?token=super_secret',
            headers: { Authorization: 'Bearer sk-secret-key' },
          },
        },
      }),
    });

    const result = await detectClaudeMcp('/projects/myapp');
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('secret');
    expect(resultStr).not.toContain('Bearer');
    expect(resultStr).not.toContain('url');
    expect(resultStr).not.toContain('headers');
    expect(Object.keys(result)).toEqual(['found', 'name', 'scope', 'disabled']);
  });
});

// ─── detectCodexMcp ────────────────────────────────────────────────

describe('detectCodexMcp', () => {
  it('detects global config with [mcp_servers.popmelt]', async () => {
    fileMap({
      '/home/testuser/.codex/config.toml': `
[mcp_servers.popmelt]
url = "http://localhost:3000"
`,
    });

    const result = await detectCodexMcp('/projects/myapp');
    expect(result).toEqual({ found: true, name: 'popmelt', scope: 'user', disabled: false });
  });

  it('detects project config', async () => {
    fileMap({
      '/projects/myapp/.codex/config.toml': `
[mcp_servers.popmelt]
url = "http://localhost:3000"
`,
    });

    const result = await detectCodexMcp('/projects/myapp');
    expect(result).toEqual({ found: true, name: 'popmelt', scope: 'project', disabled: false });
  });

  it('detects enabled = false as disabled', async () => {
    fileMap({
      '/home/testuser/.codex/config.toml': `
[mcp_servers.popmelt]
url = "http://localhost:3000"
enabled = false
`,
    });

    const result = await detectCodexMcp('/projects/myapp');
    expect(result).toEqual({ found: true, name: 'popmelt', scope: 'user', disabled: true });
  });

  it('returns not found when no config exists', async () => {
    fileMap({});

    const result = await detectCodexMcp('/projects/myapp');
    expect(result).toEqual({ found: false, name: null, scope: null, disabled: false });
  });

  it('respects $CODEX_HOME override', async () => {
    process.env.CODEX_HOME = '/custom/codex';
    fileMap({
      '/custom/codex/config.toml': `
[mcp_servers.popmelt]
url = "http://localhost:3000"
`,
    });

    const result = await detectCodexMcp('/projects/myapp');
    expect(result).toEqual({ found: true, name: 'popmelt', scope: 'user', disabled: false });
  });

  it('finds popmelt among multiple sections', async () => {
    fileMap({
      '/home/testuser/.codex/config.toml': `
[mcp_servers.github]
url = "http://github-mcp"

[mcp_servers.popmelt-dev]
url = "http://localhost:3000"

[mcp_servers.slack]
url = "http://slack-mcp"
`,
    });

    const result = await detectCodexMcp('/projects/myapp');
    expect(result).toEqual({ found: true, name: 'popmelt-dev', scope: 'user', disabled: false });
  });

  it('ignores non-popmelt sections', async () => {
    fileMap({
      '/home/testuser/.codex/config.toml': `
[mcp_servers.github]
url = "http://github-mcp"

[mcp_servers.slack]
url = "http://slack-mcp"
`,
    });

    const result = await detectCodexMcp('/projects/myapp');
    expect(result).toEqual({ found: false, name: null, scope: null, disabled: false });
  });

  it('global scope wins over project scope', async () => {
    fileMap({
      '/home/testuser/.codex/config.toml': `
[mcp_servers.popmelt]
url = "http://global"
`,
      '/projects/myapp/.codex/config.toml': `
[mcp_servers.popmelt-local]
url = "http://local"
`,
    });

    const result = await detectCodexMcp('/projects/myapp');
    expect(result.scope).toBe('user');
    expect(result.name).toBe('popmelt');
  });

  it('never exposes url or credentials in result', async () => {
    fileMap({
      '/home/testuser/.codex/config.toml': `
[mcp_servers.popmelt]
url = "http://api.popmelt.com?token=secret123"
api_key = "sk-super-secret"
`,
    });

    const result = await detectCodexMcp('/projects/myapp');
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('secret');
    expect(resultStr).not.toContain('api_key');
    expect(resultStr).not.toContain('url');
    expect(Object.keys(result)).toEqual(['found', 'name', 'scope', 'disabled']);
  });
});
