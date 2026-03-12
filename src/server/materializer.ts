import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { spawnClaude } from './claude-spawner';
import type { DecisionStore } from './decision-store';
import type { DecisionRecord, MaterializationIndex, MaterializationResult, Rule, SSEEvent } from './types';

const TAG = '[Materializer]';

const EMPTY_INDEX: MaterializationIndex = {
  version: 1,
  materializedIds: [],
  lastRunAt: null,
  lastRunDecisionIds: [],
  lastRunError: null,
};

/** Convert legacy string[] rules to Rule[] objects. Already-structured rules pass through. */
function normalizeRules(rules: unknown): Rule[] {
  if (!Array.isArray(rules)) return [];
  return rules.map((r, i) => {
    if (typeof r === 'string') {
      const id = Math.random().toString(16).slice(2, 10);
      return { id, scope: 'general', text: r, sources: [] } satisfies Rule;
    }
    if (r && typeof r === 'object' && typeof r.text === 'string') {
      return r as Rule;
    }
    // Unrecognized — wrap as general
    const id = Math.random().toString(16).slice(2, 10);
    return { id, scope: 'general', text: String(r), sources: [] } satisfies Rule;
  });
}

/** Validate and backfill Rule objects parsed from LLM output. Drops entries missing id/text. */
export function validateRules(rules: unknown[]): Rule[] {
  const valid: Rule[] = [];
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue;
    const obj = r as Record<string, unknown>;
    if (typeof obj.id !== 'string' || typeof obj.text !== 'string') {
      console.warn(`${TAG} Dropping rule missing id or text:`, JSON.stringify(r).slice(0, 120));
      continue;
    }
    valid.push({
      id: obj.id as string,
      scope: typeof obj.scope === 'string' ? obj.scope : 'general',
      text: obj.text as string,
      sources: Array.isArray(obj.sources) ? (obj.sources as unknown[]).filter((s): s is string => typeof s === 'string') : [],
    });
  }
  if (valid.length > 30) {
    console.warn(`${TAG} Rule count ${valid.length} exceeds cap of 30`);
  }
  return valid;
}

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

  /** Read the local design model. Returns null if no model exists yet.
   *  Normalizes legacy string[] rules to Rule[] in memory (does NOT write back). */
  async loadModel(): Promise<Record<string, unknown> | null> {
    try {
      const raw = await readFile(this.modelPath, 'utf-8');
      const model = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(model.rules)) {
        model.rules = normalizeRules(model.rules);
      }
      return model;
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
            // Validate and backfill rules
            if (Array.isArray(model.rules)) {
              model.rules = validateRules(model.rules as unknown[]);
            }
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

  /** Consolidate existing rules: merges duplicates, enforces cap of 30. Independent of new decisions. */
  async consolidate(): Promise<{ success: boolean; error?: string }> {
    if (this.running) {
      return { success: false, error: 'Already running' };
    }
    this.running = true;

    try {
      const model = await this.loadModel();
      if (!model) return { success: false, error: 'No model exists' };

      const prompt = buildConsolidationPrompt(model);
      const { result } = spawnClaude(`consolidate-${Date.now()}`, {
        prompt,
        projectRoot: this.projectRoot,
        maxTurns: this.options.maxTurns ?? 3,
        maxBudgetUsd: this.options.maxBudgetUsd ?? 0.30,
        allowedTools: [],
        claudePath: this.options.claudePath ?? 'claude',
      });

      const spawnResult = await result;
      if (!spawnResult.success) {
        console.error(`${TAG} Consolidation spawn error:`, spawnResult.error);
        return { success: false, error: spawnResult.error };
      }

      const parsed = parseModelBlock(spawnResult.text);
      if (!parsed) {
        console.error(`${TAG} No <model> block in consolidation response`);
        return { success: false, error: 'No <model> block found' };
      }

      // Validate rules
      if (Array.isArray(parsed.rules)) {
        parsed.rules = validateRules(parsed.rules as unknown[]);
      }

      // Preserve tokens and components from current model if not in response
      if (!parsed.tokens && model.tokens) parsed.tokens = model.tokens;
      if (!parsed.components && model.components) parsed.components = model.components;

      await writeFile(this.modelPath, JSON.stringify(parsed, null, 2));
      console.log(`${TAG} Consolidation complete → ${this.modelPath}`);
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`${TAG} Consolidation error:`, error);
      return { success: false, error };
    } finally {
      this.running = false;
    }
  }

  /** Write a validated model to disk. Used by consolidate() and the synthesize job processor. */
  async writeModel(model: Record<string, unknown>): Promise<void> {
    if (Array.isArray(model.rules)) {
      model.rules = validateRules(model.rules as unknown[]);
    }
    await writeFile(this.modelPath, JSON.stringify(model, null, 2));
    console.log(`${TAG} Model written → ${this.modelPath}`);
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

export function parseModelBlock(text: string): Record<string, unknown> | null {
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

  const decisionIds = decisions.map(d => d.id);

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
- \`rules\`: Array of structured rule objects

### Rule format
Each rule is a JSON object:
\`\`\`json
{ "id": "a1b2c3d4", "scope": "typography", "text": "Body text uses Inter at 16px/1.5", "sources": ["d-abc123"] }
\`\`\`

Fields:
- \`id\`: 8-character hex string. Preserve IDs for unchanged rules. Generate new IDs for new or merged rules.
- \`scope\`: One of: typography, color, spacing, border, component, layout, copy, ssr, accessibility, structure
- \`text\`: A clear, enforceable design rule
- \`sources\`: Array of decision IDs that informed this rule. For new rules from these decisions, use: ${JSON.stringify(decisionIds)}

### Rule guidelines
- **Hard cap: 30 rules maximum.** Merge rules covering the same concern into one.
- **Reject:** workflow advice ("After fixing X, verify Y"), instance-level observations ("The hero section uses 32px gap"), rules that merely restate a token or component already in the model.
- **Keep:** Enforceable patterns, constraints, relationships between elements, accessibility requirements.

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
    { "id": "a1b2c3d4", "scope": "typography", "text": "Body text uses Inter at 16px/1.5", "sources": ["d-abc123"] },
    { "id": "e5f6a7b8", "scope": "color", "text": "Primary actions use the primary color token", "sources": ["d-def456"] }
  ]
}
</model>

## Guidelines
- Map token-scoped decisions to \`tokens\`, component-scoped to \`components\`.
- Extract clear, enforceable rules into the \`rules\` array as structured objects.
- When merging, new decisions override conflicting older values.
- Keep the model concise — only include patterns with clear evidence from decisions.
- Do NOT output resolution or question blocks. Just output the <model> block.
- Spacing tokens can be plain strings ("8px") or objects with code bindings:
  { "value": "8px", "property": "gap", "bindings": ["gap-2"] }
  - property: "gap", "padding", or "margin" — which CSS property this token controls
  - bindings: Tailwind class names (without responsive prefixes) that use this token
  Include property and bindings when the decision context has class-level evidence.`;
}

function buildConsolidationPrompt(model: Record<string, unknown>): string {
  return `You are consolidating a design model's rules. The model has accumulated too many rules and needs cleanup.

## Current Model
\`\`\`json
${JSON.stringify(model, null, 2)}
\`\`\`

## Instructions
1. Review all current rules.
2. Merge rules that cover the same concern into single, clear rules.
3. Remove rules that are:
   - Workflow advice ("After SSR fixes, re-verify headless output")
   - Instance-level observations ("Footer tagline is 'Design everything.'")
   - Restating tokens or components already defined elsewhere in the model
   - Procedural instructions rather than design constraints
4. Output the full model with consolidated rules.

## Rule format
Each rule MUST be a JSON object:
{ "id": "a1b2c3d4", "scope": "<scope>", "text": "<rule text>", "sources": ["<decision-id>", ...] }

- \`id\`: 8-char hex. Preserve the ID of the most representative source rule when merging. Generate new 8-char hex IDs for genuinely new rules.
- \`scope\`: One of: typography, color, spacing, border, component, layout, copy, ssr, accessibility, structure
- \`text\`: Clear, enforceable design constraint
- \`sources\`: Merge source arrays when combining rules

## Hard cap: 30 rules maximum.

Prioritize rules that are:
- Enforceable constraints (not preferences)
- Cross-cutting (affect many elements)
- Not already captured by tokens or component definitions in the model

## Output
Output the complete model inside <model> tags. Preserve tokens and components as-is — only rules change.

<model>
{ "tokens": { ... }, "components": { ... }, "rules": [ ... ] }
</model>`;
}

export function buildSynthesizePrompt(model: Record<string, unknown>): string {
  return `You are a design system curator reviewing a project's design model. Your job is to propose improvements to the rules — merging duplicates, filling gaps, removing noise.

## Current Model
\`\`\`json
${JSON.stringify(model, null, 2)}
\`\`\`

## Instructions
1. Review all current rules, tokens, and components.
2. Propose specific changes — additions, merges, removals — with brief reasoning for each.
3. Present your proposals as clear text so the developer can review them.
4. Do NOT output a <model> block yet. First get the developer's approval.

## Output format
- List each proposed change as a numbered item with a short rationale.
- Group by action: **Merge**, **Add**, **Remove**, **Reword**.
- After your proposals, output a <question> block asking the developer to approve, adjust, or reject.

Example:
**Merge**
1. Rules "Body text uses Inter 16px" and "Paragraph text is Inter 16/1.5" → "Body/paragraph text uses Inter at 16px/1.5" (they say the same thing)

**Remove**
2. "After fixing SSR, re-verify headless output" — workflow advice, not a design constraint

**Add**
3. "Primary actions use the primary color token; secondary actions use gray-500" — implied by token usage but not codified

<question>
These are my proposed rule changes. Would you like to approve all of them, adjust specific items, or add more? Once you're happy I'll output the final model.
</question>

## After approval
When the developer approves (says "yes", "looks good", "go ahead", etc.), output the complete updated model inside <model> tags — the full JSON with tokens, components, and the revised rules array. Do NOT output partial models. Preserve tokens and components as-is unless the developer asks to change them.`;
}
