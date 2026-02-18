import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DecisionRecord } from './types';

export class DecisionStore {
  private decisionsDir: string;
  private screenshotsDir: string;

  constructor(private projectRoot: string) {
    const popmeltDir = join(projectRoot, '.popmelt');
    this.decisionsDir = join(popmeltDir, 'decisions');
    this.screenshotsDir = join(popmeltDir, 'screenshots');
  }

  async persist(
    record: DecisionRecord,
    tempScreenshotPath: string,
    tempImagePaths: string[],
  ): Promise<void> {
    try {
      await mkdir(this.decisionsDir, { recursive: true });
      await mkdir(this.screenshotsDir, { recursive: true });

      // Copy screenshot from temp to persistent storage
      try {
        await copyFile(tempScreenshotPath, join(this.screenshotsDir, `s-${record.id}.png`));
      } catch {
        // Source missing (already cleaned up) — record still written
      }

      // Copy pasted images
      for (let i = 0; i < tempImagePaths.length; i++) {
        try {
          const filename = record.pastedImagePaths[i];
          if (filename) {
            await copyFile(tempImagePaths[i]!, join(this.screenshotsDir, filename.replace('screenshots/', '')));
          }
        } catch {
          // Skip missing images
        }
      }

      // Write decision record
      await writeFile(
        join(this.decisionsDir, `d-${record.id}.json`),
        JSON.stringify(record, null, 2),
      );
    } catch (err) {
      console.error('[DecisionStore] Failed to persist decision record:', err);
    }
  }

  async listDecisionIds(): Promise<string[]> {
    try {
      const files = await readdir(this.decisionsDir);
      return files
        .filter(f => f.startsWith('d-') && f.endsWith('.json'))
        .map(f => f.slice(2, -5)); // strip d- prefix and .json suffix
    } catch {
      return [];
    }
  }

  async loadDecision(id: string): Promise<DecisionRecord | null> {
    try {
      const raw = await readFile(join(this.decisionsDir, `d-${id}.json`), 'utf-8');
      return JSON.parse(raw) as DecisionRecord;
    } catch {
      return null;
    }
  }

  async loadDecisions(ids: string[]): Promise<DecisionRecord[]> {
    const results = await Promise.all(ids.map(id => this.loadDecision(id)));
    return results.filter((r): r is DecisionRecord => r !== null);
  }

  captureGitDiff(cwd: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        'git',
        ['diff', 'HEAD'],
        { cwd, timeout: 5000, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          resolve(stdout || null);
        },
      );
    });
  }
}
