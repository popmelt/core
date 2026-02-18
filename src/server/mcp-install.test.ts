import { describe, it, expect, vi, beforeEach } from 'vitest';

import { installClaudeMcp, installCodexMcp } from './mcp-install';

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

// Mock node:os
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
}));

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);

beforeEach(() => {
  vi.resetAllMocks();
  mockWriteFile.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined as any);
  delete process.env.CODEX_HOME;
});

// ─── installClaudeMcp ─────────────────────────────────────────────

describe('installClaudeMcp', () => {
  it('writes to ~/.claude.json with correct structure', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ existingKey: true }));

    const result = await installClaudeMcp('https://mcp.popmelt.com/mcp');

    expect(result).toEqual({ installed: true, provider: 'claude', scope: 'user' });
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [path, content] = mockWriteFile.mock.calls[0]!;
    expect(path).toBe('/home/testuser/.claude.json');
    const written = JSON.parse(content as string);
    expect(written.existingKey).toBe(true);
    expect(written.mcpServers.popmelt).toEqual({ type: 'http', url: 'https://mcp.popmelt.com/mcp' });
  });

  it('creates file if it does not exist', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    const result = await installClaudeMcp('https://mcp.popmelt.com/mcp');

    expect(result.installed).toBe(true);
    const written = JSON.parse(mockWriteFile.mock.calls[0]![1] as string);
    expect(written.mcpServers.popmelt).toEqual({ type: 'http', url: 'https://mcp.popmelt.com/mcp' });
  });

  it('merges into existing mcpServers without clobbering other entries', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({
      mcpServers: {
        github: { url: 'https://github-mcp.example.com' },
      },
    }));

    await installClaudeMcp('https://mcp.popmelt.com/mcp');

    const written = JSON.parse(mockWriteFile.mock.calls[0]![1] as string);
    expect(written.mcpServers.github).toEqual({ url: 'https://github-mcp.example.com' });
    expect(written.mcpServers.popmelt).toEqual({ type: 'http', url: 'https://mcp.popmelt.com/mcp' });
  });

  it('skips if popmelt is already configured', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({
      mcpServers: {
        popmelt: { type: 'http', url: 'https://old.popmelt.com/mcp' },
      },
    }));

    const result = await installClaudeMcp('https://mcp.popmelt.com/mcp');

    expect(result).toEqual({ installed: false, provider: 'claude', scope: null, reason: 'already_configured' });
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('skips if @popmelt.com/core is already configured (case-insensitive)', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({
      mcpServers: {
        '@popmelt.com/core': { type: 'http', url: 'https://old.popmelt.com/mcp' },
      },
    }));

    const result = await installClaudeMcp('https://mcp.popmelt.com/mcp');

    expect(result).toEqual({ installed: false, provider: 'claude', scope: null, reason: 'already_configured' });
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('uses provided serverUrl parameter', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    await installClaudeMcp('https://custom.example.com/mcp');

    const written = JSON.parse(mockWriteFile.mock.calls[0]![1] as string);
    expect(written.mcpServers.popmelt.url).toBe('https://custom.example.com/mcp');
  });
});

// ─── installCodexMcp ──────────────────────────────────────────────

describe('installCodexMcp', () => {
  it('appends TOML section to existing file', async () => {
    mockReadFile.mockResolvedValueOnce('[mcp_servers.github]\nurl = "https://github"\n');

    const result = await installCodexMcp('https://mcp.popmelt.com/mcp');

    expect(result).toEqual({ installed: true, provider: 'codex', scope: 'user' });
    expect(mockMkdir).toHaveBeenCalled();
    const written = mockWriteFile.mock.calls[0]![1] as string;
    expect(written).toContain('[mcp_servers.github]');
    expect(written).toContain('[mcp_servers.popmelt]');
    expect(written).toContain('url = "https://mcp.popmelt.com/mcp"');
  });

  it('creates ~/.codex/ directory and file if absent', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    const result = await installCodexMcp('https://mcp.popmelt.com/mcp');

    expect(result.installed).toBe(true);
    expect(mockMkdir).toHaveBeenCalledWith('/home/testuser/.codex', { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [path, content] = mockWriteFile.mock.calls[0]!;
    expect(path).toBe('/home/testuser/.codex/config.toml');
    expect(content).toContain('[mcp_servers.popmelt]');
  });

  it('skips if section already exists', async () => {
    mockReadFile.mockResolvedValueOnce('[mcp_servers.popmelt]\nurl = "https://old.popmelt.com/mcp"\n');

    const result = await installCodexMcp('https://mcp.popmelt.com/mcp');

    expect(result).toEqual({ installed: false, provider: 'codex', scope: null, reason: 'already_configured' });
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('respects $CODEX_HOME', async () => {
    process.env.CODEX_HOME = '/custom/codex';
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    await installCodexMcp('https://mcp.popmelt.com/mcp');

    expect(mockMkdir).toHaveBeenCalledWith('/custom/codex', { recursive: true });
    expect(mockWriteFile.mock.calls[0]![0]).toBe('/custom/codex/config.toml');
  });

  it('uses provided serverUrl parameter', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    await installCodexMcp('https://custom.example.com/mcp');

    const written = mockWriteFile.mock.calls[0]![1] as string;
    expect(written).toContain('url = "https://custom.example.com/mcp"');
  });
});
