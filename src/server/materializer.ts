import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { spawnClaude } from './claude-spawner';
import type { DecisionStore } from './decision-store';
import type { DecisionRecord, MaterializationIndex, MaterializationResult, SSEEvent } from './types';

const TAG = '[Materializer]';

const EMPTY_INDEX: MaterializationIndex = {
  version: 1,
  materializedIds: [],
  lastRunAt: null,
  lastRunDecisionIds: [],
  lastRunError: null,
};

export class Materializer {
  private indexPath: string;
  private modelPath: string;
  private cachedIndex: MaterializationIndex | null = null;
  private running = false;

  constructor(
    private projectRoot: string,
    private decisionStore: DecisionStore,
    private options: {
      claudePath?: string;
      maxTurns?: number;
      maxBudgetUsd?: number;
      onEvent?: (event: SSEEvent) => void;
    } = {},
  ) {
    const popmeltDir = join(projectRoot, '.popmelt');
    this.indexPath = join(popmeltDir, 'materialized.json');
    this.modelPath = join(popmeltDir, 'model.json');
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Read the local design model. Returns null if no model exists yet. */
  async loadModel(): Promise<Record<string, unknown> | null> {
    try {
      const raw = await readFile(this.modelPath, 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Add a component entry to model.json. Creates the file if it doesn't exist. */
  async addComponent(name: string): Promise<{ added: boolean; alreadyExists: boolean }> {
    let model = await this.loadModel() as Record<string, unknown> | null;
    if (!model) {
      model = { tokens: {}, components: {}, rules: [] };
    }
    if (!model.components || typeof model.components !== 'object') {
      model.components = {};
    }
    const components = model.components as Record<string, unknown>;
    if (components[name]) {
      return { added: false, alreadyExists: true };
    }
    components[name] = { description: '' };
    await writeFile(this.modelPath, JSON.stringify(model, null, 2));
    console.log(`${TAG} Added component "${name}" to model`);
    return { added: true, alreadyExists: false };
  }

  /** Update a token value by dot-path (e.g. "tokens.spacing.section-gap" → "24px").
   *  Value can be a plain string ("40px") or a JSON-stringified enriched object
   *  ({"value":"40px","property":"gap","bindings":["gap-10"]}). */
  async updateToken(path: string, value: string): Promise<{ updated: boolean }> {
    let model = await this.loadModel() as Record<string, unknown> | null;
    if (!model) {
      model = { tokens: {}, components: {}, rules: [] };
    }
    const segments = path.split('.');
    let cursor: Record<string, unknown> = model;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      if (!cursor[seg] || typeof cursor[seg] !== 'object') {
        cursor[seg] = {};
      }
      cursor = cursor[seg] as Record<string, unknown>;
    }
    const lastSeg = segments[segments.length - 1]!;

    // Try to parse as enriched token object
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { parsed = null; }

    if (parsed && typeof parsed === 'object' && parsed !== null && 'value' in (parsed as Record<string, unknown>)) {
      // Store enriched token
      cursor[lastSeg] = parsed;
    } else {
      // Plain string value — preserve existing bindings if token was already enriched
      const existing = cursor[lastSeg];
      if (existing && typeof existing === 'object' && existing !== null && 'value' in (existing as Record<string, unknown>)) {
        (existing as Record<string, unknown>).value = value;
      } else {
        cursor[lastSeg] = value;
      }
    }

    await writeFile(this.modelPath, JSON.stringify(model, null, 2));
    console.log(`${TAG} Updated token "${path}" → "${value.slice(0, 80)}"`);
    return { updated: true };
  }

  /** Remove a token by dot-path (e.g. "tokens.spacing.section-gap"). */
  async removeToken(path: string): Promise<{ removed: boolean }> {
    const model = await this.loadModel();
    if (!model) return { removed: false };
    const segments = path.split('.');
    let cursor: Record<string, unknown> = model;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      if (!cursor[seg] || typeof cursor[seg] !== 'object') return { removed: false };
      cursor = cursor[seg] as Record<string, unknown>;
    }
    const lastSeg = segments[segments.length - 1]!;
    if (!(lastSeg in cursor)) return { removed: false };
    delete cursor[lastSeg];
    await writeFile(this.modelPath, JSON.stringify(model, null, 2));
    console.log(`${TAG} Removed token "${path}" from model`);
    return { removed: true };
  }

  /** Remove a component entry from model.json. */
  async removeComponent(name: string): Promise<{ removed: boolean }> {
    const model = await this.loadModel();
    if (!model) return { removed: false };
    const components = model.components as Record<string, unknown> | undefined;
    if (!components || !components[name]) return { removed: false };
    delete components[name];
    await writeFile(this.modelPath, JSON.stringify(model, null, 2));
    console.log(`${TAG} Removed component "${name}" from model`);
    return { removed: true };
  }

  async getUnmaterializedPatternDecisions(): Promise<DecisionRecord[]> {
    const index = await this.loadIndex();
    const materializedSet = new Set(index.materializedIds);

    const allIds = await this.decisionStore.listDecisionIds();
    const unmaterializedIds = allIds.filter(id => !materializedSet.has(id));
    if (unmaterializedIds.length === 0) return [];

    const decisions = await this.decisionStore.loadDecisions(unmaterializedIds);

    return decisions.filter(d =>
      d.resolutions.some(r => {
        const scope = r.finalScope ?? r.inferredScope;
        return scope?.breadth === 'pattern';
      }),
    );
  }

  async run(): Promise<MaterializationResult> {
    if (this.running) {
      return { processedIds: [], success: true, error: 'Already running' };
    }
    this.running = true;

    try {
      const decisions = await this.getUnmaterializedPatternDecisions();
      if (decisions.length === 0) {
        return { processedIds: [], success: true };
      }

      const decisionIds = decisions.map(d => d.id);
      console.log(`${TAG} Processing ${decisionIds.length} pattern-scoped decision(s): ${decisionIds.join(', ')}`);

      this.options.onEvent?.({ type: 'materialize_started', decisionIds });

      const currentModel = await this.loadModel();
      const prompt = buildMaterializationPrompt(decisions, currentModel);
      let success = true;
      let error: string | undefined;

      try {
        const { result } = spawnClaude(`mat-${Date.now()}`, {
          prompt,
          projectRoot: this.projectRoot,
          maxTurns: this.options.maxTurns ?? 5,
          maxBudgetUsd: this.options.maxBudgetUsd ?? 0.50,
          allowedTools: ['Read'],
          claudePath: this.options.claudePath ?? 'claude',
        });

        const spawnResult = await result;
        if (!spawnResult.success) {
          success = false;
          error = spawnResult.error;
          console.error(`${TAG} Claude spawn error:`, error);
        } else {
          // Parse <model> block from response and write to disk
          const model = parseModelBlock(spawnResult.text);
          if (model) {
            await writeFile(this.modelPath, JSON.stringify(model, null, 2));
            console.log(`${TAG} Successfully materialized ${decisionIds.length} decision(s) → ${this.modelPath}`);
          } else {
            success = false;
            error = 'No <model> block found in response';
            console.error(`${TAG} ${error}`);
          }
        }
      } catch (err) {
        success = false;
        error = err instanceof Error ? err.message : String(err);
        console.error(`${TAG} Error:`, error);
      }

      // Mark all processed decision IDs in the index (even on failure — prevents retry loops)
      const index = await this.loadIndex();
      const existingSet = new Set(index.materializedIds);
      for (const id of decisionIds) {
        existingSet.add(id);
      }
      index.materializedIds = [...existingSet];
      index.lastRunAt = Date.now();
      index.lastRunDecisionIds = decisionIds;
      index.lastRunError = error ?? null;
      await this.persistIndex(index);

      this.options.onEvent?.({ type: 'materialize_done', decisionIds, success, error });

      return { processedIds: decisionIds, success, error };
    } finally {
      this.running = false;
    }
  }

  private async loadIndex(): Promise<MaterializationIndex> {
    if (this.cachedIndex) return this.cachedIndex;
    try {
      const raw = await readFile(this.indexPath, 'utf-8');
      const parsed = JSON.parse(raw) as MaterializationIndex;
      this.cachedIndex = parsed;
      return parsed;
    } catch {
      this.cachedIndex = { ...EMPTY_INDEX, materializedIds: [], lastRunDecisionIds: [] };
      return this.cachedIndex;
    }
  }

  private async persistIndex(index: MaterializationIndex): Promise<void> {
    this.cachedIndex = index;
    try {
      await writeFile(this.indexPath, JSON.stringify(index, null, 2));
    } catch (err) {
      console.error(`${TAG} Failed to write index:`, err);
    }
  }
}

function parseModelBlock(text: string): Record<string, unknown> | null {
  const match = text.match(/<model>\s*([\s\S]*?)\s*<\/model>/);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildMaterializationPrompt(
  decisions: DecisionRecord[],
  currentModel: Record<string, unknown> | null,
): string {
  const decisionBlocks = decisions.map(d => {
    const patternResolutions = d.resolutions.filter(r => {
      const scope = r.finalScope ?? r.inferredScope;
      return scope?.breadth === 'pattern';
    });

    const resolutionLines = patternResolutions.map(r => {
      const scope = r.finalScope ?? r.inferredScope;
      const target = scope?.target ?? 'unknown';
      const files = r.filesModified?.join(', ') ?? 'none';
      return `- **${r.summary}** [scope: pattern/${target}]\n  Files modified: ${files}`;
    }).join('\n');

    const instructions = d.annotations
      .map(a => a.instruction)
      .filter(Boolean)
      .join('\n');

    const diffBlock = d.gitDiff
      ? `\n\`\`\`diff\n${d.gitDiff.slice(0, 2000)}\n\`\`\``
      : '';

    return `### Decision ${d.id} (${new Date(d.createdAt).toISOString()})
Page: ${d.url}
${resolutionLines}
${diffBlock}
${instructions ? `\nOriginal instructions:\n${instructions}` : ''}`;
  }).join('\n\n');

  const modelSection = currentModel
    ? `## Current Model
\`\`\`json
${JSON.stringify(currentModel, null, 2)}
\`\`\`

Merge the new decisions into the existing model. Preserve existing entries that are not contradicted by new decisions.`
    : `No model exists yet. Create one from scratch based on the decisions below.`;

  return `You are extracting a local design model from accumulated design decisions.

## Instructions
1. Review the current model (if any) and the new decisions below.
2. Determine what design tokens, component patterns, and rules to add or update.
3. Output the complete updated model as a JSON object inside <model> tags.

${modelSection}

## Design Decisions to Materialize
${decisionBlocks}

## Output Format
Output the full model inside <model> tags. The model is a JSON object with these sections:
- \`tokens\`: Design tokens (colors, spacing, typography, etc.)
- \`components\`: Component-level patterns (e.g., button styles, card layouts)
- \`rules\`: Array of plain-language rules extracted from decisions

Example:
<model>
{
  "tokens": {
    "colors": { "primary": "#3b82f6" },
    "spacing": {
      "sm": "4px",
      "md": "8px",
      "section-gap": { "value": "32px", "property": "gap", "bindings": ["gap-8"] }
    }
  },
  "components": {
    "button": { "padding": "12px 24px", "borderRadius": "8px" }
  },
  "rules": [
    "Buttons use 12px vertical padding and 24px horizontal padding",
    "Primary actions use the primary color"
  ]
}
</model>

## Guidelines
- Map token-scoped decisions to \`tokens\`, component-scoped to \`components\`.
- Extract clear, enforceable rules into the \`rules\` array.
- When merging, new decisions override conflicting older values.
- Keep the model concise — only include patterns with clear evidence from decisions.
- Do NOT output resolution or question blocks. Just output the <model> block.
- Spacing tokens can be plain strings ("8px") or objects with code bindings:
  { "value": "8px", "property": "gap", "bindings": ["gap-2"] }
  - property: "gap", "padding", or "margin" — which CSS property this token controls
  - bindings: Tailwind class names (without responsive prefixes) that use this token
  Include property and bindings when the decision context has class-level evidence.`;
}
