import type { AnnotationResolution } from '../tools/types';
import type { FeedbackPayload, NovelPattern, PlanTask, Provider, ThreadMessage } from './types';

/** Format feedback annotations and style modifications into prompt-ready text */
export function formatFeedbackContext(feedback: FeedbackPayload, imagePaths?: Record<string, string[]>): string {
  const lines: string[] = [];

  if (feedback.annotations.length > 0) {
    lines.push('## Annotations');
    for (const ann of feedback.annotations) {
      const elementsDesc = ann.elements
        .map((el) => {
          const parts = [el.selector];
          if (el.reactComponent) parts.push(`(${el.reactComponent})`);
          return parts.join(' ');
        })
        .join(', ');

      const instruction = ann.instruction || 'No text';
      lines.push(`- id=${ann.id} [${ann.type}] ${instruction} → Elements: ${elementsDesc || 'none'}`);

      // Reference pasted images for this annotation
      const annImages = imagePaths?.[ann.id];
      if (annImages && annImages.length > 0) {
        for (const imgPath of annImages) {
          lines.push(`  Attached image: use the Read tool to view ${imgPath}`);
        }
      }
    }
  }

  if (feedback.styleModifications.length > 0) {
    lines.push('');
    lines.push('## Style Changes (make permanent in source)');
    lines.push('The developer previewed these CSS changes via inline style overrides. Find the corresponding styles in the source files and update them so the changes persist:');
    for (const mod of feedback.styleModifications) {
      const elementDesc = mod.element?.reactComponent
        ? `(${mod.element.reactComponent})`
        : '';
      for (const change of mod.changes) {
        lines.push(
          `- ${mod.selector} ${elementDesc}: ${change.property} ${change.original} → ${change.modified}`,
        );
      }
    }
  }

  if (feedback.spacingTokenChanges?.length) {
    lines.push('');
    lines.push('## Spacing Token Changes');
    lines.push('The developer adjusted these spacing tokens. Apply each change to the source code:');
    for (const change of feedback.spacingTokenChanges) {
      lines.push(`\n### ${change.tokenName}: ${change.originalPx}px → ${change.newPx}px`);
      for (const el of change.affectedElements) {
        const comp = el.reactComponent ? ` (${el.reactComponent})` : '';
        if (el.matchedClass && el.suggestedClass) {
          lines.push(`- ${el.selector}${comp}: \`${el.matchedClass}\` → \`${el.suggestedClass}\``);
        } else {
          lines.push(`- ${el.selector}${comp}: ${el.property} ${change.originalPx}px → ${change.newPx}px`);
        }
        lines.push(`  class="${el.className}"`);
      }
    }
  }

  if (feedback.inspectedElement) {
    const el = feedback.inspectedElement;
    lines.push('');
    lines.push('## Inspected Element');
    lines.push('The developer has this element selected in the inspector:');
    const parts = [el.selector];
    if (el.reactComponent) parts.push(`(${el.reactComponent})`);
    if (el.context) parts.push(`in ${el.context}`);
    if (el.textContent) parts.push(`"${el.textContent.slice(0, 80)}"`);
    lines.push(`- ${parts.join(' ')}`);
  }

  return lines.join('\n');
}

export function buildPrompt(
  screenshotPath: string,
  feedback: FeedbackPayload,
  options?: {
    threadHistory?: ThreadMessage[];
    provider?: Provider;
    imagePaths?: Record<string, string[]>;
    designModel?: Record<string, unknown>;
  },
): string {
  const lines: string[] = [];

  lines.push('You are reviewing a UI screenshot with developer annotations.');
  lines.push('');
  if (options?.provider !== 'codex') {
    lines.push(`IMPORTANT: First, use the Read tool to view the screenshot at: ${screenshotPath}`);
    lines.push('');
  }
  lines.push(
    `The developer annotated their running app at ${feedback.url} (${feedback.viewport.width}x${feedback.viewport.height}).`,
  );

  // Thread context section (if continuing a conversation)
  if (options?.threadHistory && options.threadHistory.length > 0) {
    lines.push('');
    lines.push('## Previous Conversation');
    let roundNum = 0;
    for (const msg of options.threadHistory) {
      if (msg.role === 'human') {
        roundNum++;
        if (msg.replyToQuestion) {
          lines.push(`### Round ${roundNum} (human) — reply`);
          lines.push(`"${msg.replyToQuestion}"`);
        } else {
          lines.push(`### Round ${roundNum} (human)`);
          if (msg.feedbackSummary) {
            lines.push(`Annotations: ${msg.feedbackSummary}`);
          }
          if (msg.annotationIds && msg.annotationIds.length > 0) {
            lines.push(`Annotation IDs: ${msg.annotationIds.join(', ')}`);
          }
        }
      } else {
        if (msg.question) {
          lines.push(`### Round ${roundNum} (assistant) — question`);
          lines.push(`"${msg.question}"`);
        } else {
          lines.push(`### Round ${roundNum} (assistant)`);
          if (msg.responseText) {
            lines.push(`Response: ${msg.responseText}`);
          }
          if (msg.resolutions && msg.resolutions.length > 0) {
            for (const r of msg.resolutions) {
              const scope = r.finalScope ?? r.inferredScope;
              const scopeLabel = scope ? ` [${scope.breadth} ${scope.target}]` : '';
              lines.push(`- ${r.annotationId}: ${r.status}${scopeLabel} — ${r.summary}`);
              if (r.filesModified && r.filesModified.length > 0) {
                lines.push(`  Files: ${r.filesModified.join(', ')}`);
              }
            }
          }
          if (msg.toolsUsed && msg.toolsUsed.length > 0) {
            lines.push(`Tools used: ${msg.toolsUsed.join(', ')}`);
          }
        }
      }
    }
    lines.push('');
    lines.push('The current round is shown in full below.');
  }

  // Design model enforcement
  if (options?.designModel) {
    lines.push('');
    lines.push('## Established Design Policies');
    lines.push('This project has an established design model (stored in .popmelt/model.json), extracted from the developer\'s previous design decisions. When making changes, follow these patterns unless the developer explicitly overrides them. When asked about design tokens, component patterns, or design decisions, reference this model as the authoritative source.');
    const rules = options.designModel.rules;
    if (Array.isArray(rules) && rules.length > 0) {
      lines.push('');
      lines.push('Rules:');
      for (const rule of rules) {
        if (typeof rule === 'string') lines.push(`- ${rule}`);
      }
    }
    const tokens = options.designModel.tokens;
    if (tokens && typeof tokens === 'object') {
      lines.push('');
      lines.push('Design tokens:');
      lines.push('```json');
      lines.push(JSON.stringify(tokens, null, 2));
      lines.push('```');
    }
    const components = options.designModel.components;
    if (components && typeof components === 'object') {
      lines.push('');
      lines.push('Component patterns:');
      lines.push('```json');
      lines.push(JSON.stringify(components, null, 2));
      lines.push('```');
    }
    lines.push('');
    lines.push('### Novel Pattern Detection');
    lines.push('When you make a design decision that has no matching policy in the model above (e.g., styling a component type not yet in the model, choosing a color with no token, picking spacing with no rule), flag it:');
    lines.push('<novel>');
    lines.push('[{"category":"component","element":"button","decision":"Used 8px border-radius, 12px 24px padding","reason":"No button pattern in design model"}]');
    lines.push('</novel>');
    lines.push('- `category`: "token" (color, spacing, typography), "component" (UI component pattern), or "element" (specific element style)');
    lines.push('- `element`: What you are styling or creating');
    lines.push('- `decision`: What you decided to do (specific values)');
    lines.push('- `reason`: Why this is novel (what is missing from the model)');
    lines.push('Still do the work — just flag it so the developer can review and set policy.');
  }

  // Always mention the decision store — even without a model, Claude should know it exists
  if (!options?.designModel) {
    lines.push('');
    lines.push('## Design Context');
    lines.push('This project uses Popmelt for design governance. Design decisions are stored in .popmelt/decisions/ (JSON files). A materialized design model may exist at .popmelt/model.json. When the developer asks about design tokens, patterns, or past decisions, check these files first before searching source code.');
  }

  const feedbackContext = formatFeedbackContext(feedback, options?.imagePaths);
  if (feedbackContext) {
    lines.push('');
    lines.push(feedbackContext);
  }

  lines.push('');
  lines.push(
    'Follow the developer\'s instructions. If they ask for changes, apply them to the source files — the dev server has HMR so changes appear immediately. If they ask a question or request analysis, respond in text without modifying code.',
  );
  lines.push('');
  lines.push(
    'IMPORTANT: If any elements you modify have a `data-pm` attribute, preserve it in the source. This attribute tracks annotation positions.',
  );

  // Structured resolution instruction
  lines.push('');
  lines.push('## Resolution');
  lines.push('After completing all work, output a resolution block listing what you did for each annotation:');
  lines.push('<resolution>');
  lines.push('[{"annotationId":"<id>","status":"resolved","summary":"<what you did>","filesModified":["<file>"],"declaredScope":{"breadth":"...","target":"..."},"inferredScope":{"breadth":"...","target":"..."}}]');
  lines.push('</resolution>');
  lines.push('Use status "resolved" when the change is complete, or "needs_review" if you\'re unsure about the result.');
  lines.push('');
  lines.push('### Scope classification');
  lines.push('Each resolution MUST include scope fields:');
  lines.push('- `declaredScope`: What scope the user\'s instruction text implies. null if no signal.');
  lines.push('- `inferredScope`: What scope the change actually has, based on what you modified.');
  lines.push('Scope has two dimensions:');
  lines.push('- `breadth`: "instance" (just this occurrence) or "pattern" (all similar occurrences)');
  lines.push('- `target`: "element" (a specific DOM element), "component" (a React/UI component), or "token" (a design token — color, spacing, typography)');
  lines.push('Note: "instance" + "token" is invalid — tokens are inherently patterns.');
  lines.push('If you cannot confidently determine scope, set it to null.');

  // Question instruction
  lines.push('');
  lines.push('## Questions');
  lines.push('If the annotation text is unclear, ambiguous, gibberish, or you are unsure what the developer wants, output a question:');
  lines.push('<question>What do you mean by "..."?</question>');
  lines.push('Do NOT guess what unclear instructions mean — ask instead.');
  lines.push('You may output BOTH a <resolution> for clear annotations AND a <question> for unclear ones in the same response.');

  return lines.join('\n');
}

/** Parse a question block from Claude's response text */
export function parseQuestion(responseText: string): string | null {
  const match = responseText.match(/<question>\s*([\s\S]*?)\s*<\/question>/);
  return match?.[1] ?? null;
}

/** Build a focused prompt for continuation after a user reply */
export function buildReplyPrompt(
  screenshotPath: string,
  threadHistory: ThreadMessage[],
  provider?: Provider,
  imagePaths?: string[],
): string {
  const lines: string[] = [];

  lines.push('You are continuing work on a UI based on the developer\'s reply to your question.');
  lines.push('');
  if (provider !== 'codex') {
    lines.push(`IMPORTANT: First, use the Read tool to view the screenshot at: ${screenshotPath}`);
  }

  // Include original annotation context from the first human message
  const firstHuman = threadHistory.find(m => m.role === 'human' && m.feedbackContext);
  if (firstHuman?.feedbackContext) {
    lines.push('');
    lines.push(firstHuman.feedbackContext);
  }

  // Thread context
  if (threadHistory.length > 0) {
    lines.push('');
    lines.push('## Conversation History');
    let roundNum = 0;
    for (const msg of threadHistory) {
      if (msg.role === 'human') {
        roundNum++;
        if (msg.replyToQuestion) {
          lines.push(`### Round ${roundNum} (human) — reply`);
          lines.push(`"${msg.replyToQuestion}"`);
        } else {
          lines.push(`### Round ${roundNum} (human)`);
          if (msg.feedbackSummary) {
            lines.push(`Annotations: ${msg.feedbackSummary}`);
          }
        }
      } else {
        if (msg.question) {
          lines.push(`### Round ${roundNum} (assistant) — question`);
          lines.push(`"${msg.question}"`);
        } else {
          lines.push(`### Round ${roundNum} (assistant)`);
          if (msg.responseText) {
            lines.push(`Response: ${msg.responseText}`);
          }
        }
      }
    }
  }

  lines.push('');
  lines.push('The developer answered your question. Continue working based on their reply.');
  lines.push('Follow their instructions — apply code changes only if requested. The dev server has HMR so changes appear immediately.');
  lines.push('');
  lines.push('IMPORTANT: If any elements you modify have a `data-pm` attribute, preserve it in the source. This attribute tracks annotation positions.');

  // Attached images from the reply
  if (imagePaths && imagePaths.length > 0) {
    lines.push('');
    lines.push('## Attached Images');
    lines.push('The developer attached reference images with their reply:');
    for (const imgPath of imagePaths) {
      lines.push(`Attached image: use the Read tool to view the image at: ${imgPath}`);
    }
  }

  // Resolution instruction
  lines.push('');
  lines.push('## Resolution');
  lines.push('After completing all work, output a resolution block listing what you did for each annotation:');
  lines.push('<resolution>');
  lines.push('[{"annotationId":"<id>","status":"resolved","summary":"<what you did>","filesModified":["<file>"],"declaredScope":{"breadth":"...","target":"..."},"inferredScope":{"breadth":"...","target":"..."}}]');
  lines.push('</resolution>');
  lines.push('Use status "resolved" when the change is complete, or "needs_review" if you\'re unsure about the result.');
  lines.push('');
  lines.push('### Scope classification');
  lines.push('Each resolution MUST include scope fields:');
  lines.push('- `declaredScope`: What scope the user\'s instruction text implies. null if no signal.');
  lines.push('- `inferredScope`: What scope the change actually has, based on what you modified.');
  lines.push('Scope has two dimensions:');
  lines.push('- `breadth`: "instance" (just this occurrence) or "pattern" (all similar occurrences)');
  lines.push('- `target`: "element" (a specific DOM element), "component" (a React/UI component), or "token" (a design token — color, spacing, typography)');
  lines.push('Note: "instance" + "token" is invalid — tokens are inherently patterns.');
  lines.push('If you cannot confidently determine scope, set it to null.');
  lines.push('If the developer\'s reply corrects a prior scope classification (e.g., "this should apply everywhere" or "only fix this one"), set `finalScope` on your resolution to reflect their correction and apply the change at the corrected scope.');

  // Question instruction
  lines.push('');
  lines.push('## Questions');
  lines.push('If you still need clarification, output:');
  lines.push('<question>Your question here</question>');
  lines.push('You may output BOTH a <resolution> and a <question> in the same response.');

  return lines.join('\n');
}

function isValidScope(s: unknown): boolean {
  if (typeof s !== 'object' || s === null) return false;
  const obj = s as Record<string, unknown>;
  return (
    (obj.breadth === 'instance' || obj.breadth === 'pattern') &&
    (obj.target === 'element' || obj.target === 'component' || obj.target === 'token')
  );
}

function isValidResolution(r: unknown): r is AnnotationResolution {
  if (
    typeof r !== 'object' ||
    r === null ||
    typeof (r as Record<string, unknown>).annotationId !== 'string' ||
    ((r as Record<string, unknown>).status !== 'resolved' && (r as Record<string, unknown>).status !== 'needs_review') ||
    typeof (r as Record<string, unknown>).summary !== 'string'
  ) {
    return false;
  }
  const obj = r as Record<string, unknown>;
  for (const field of ['declaredScope', 'inferredScope', 'finalScope']) {
    if (obj[field] !== undefined && obj[field] !== null && !isValidScope(obj[field])) {
      return false;
    }
  }
  return true;
}

/** Parse the first resolution block from Claude's response text */
export function parseResolutions(responseText: string): AnnotationResolution[] {
  const match = responseText.match(/<resolution>\s*([\s\S]*?)\s*<\/resolution>/);
  if (!match || !match[1]) return [];

  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidResolution);
  } catch {
    return [];
  }
}

/** Parse ALL resolution blocks from response text (for plan executor with incremental output) */
export function parseAllResolutions(responseText: string): AnnotationResolution[] {
  const results: AnnotationResolution[] = [];
  const regex = /<resolution>\s*([\s\S]*?)\s*<\/resolution>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(responseText)) !== null) {
    if (!match[1]) continue;
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) {
        results.push(...parsed.filter(isValidResolution));
      }
    } catch {
      // Incomplete or invalid JSON — skip this block
    }
  }

  return results;
}

/** Parse novel pattern flags from Claude's response text */
export function parseNovelPatterns(responseText: string): NovelPattern[] {
  const match = responseText.match(/<novel>\s*([\s\S]*?)\s*<\/novel>/);
  if (!match?.[1]) return [];

  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p: unknown): p is NovelPattern => {
      if (typeof p !== 'object' || p === null) return false;
      const obj = p as Record<string, unknown>;
      return (
        (obj.category === 'token' || obj.category === 'component' || obj.category === 'element') &&
        typeof obj.element === 'string' &&
        typeof obj.decision === 'string' &&
        typeof obj.reason === 'string'
      );
    });
  } catch {
    return [];
  }
}

// ============================
// Planner prompt + parser
// ============================

export function buildPlannerPrompt(
  screenshotPath: string,
  goal: string,
  pageUrl: string,
  viewport: { width: number; height: number },
  manifestJson?: string,
  feedbackContext?: string,
): string {
  const lines: string[] = [];

  lines.push('You are a UI design planner. You are looking at a full-page screenshot of a web application.');
  lines.push('');
  lines.push(`IMPORTANT: First, use the Read tool to view the screenshot at: ${screenshotPath}`);
  lines.push('');
  lines.push(`Page: ${pageUrl}`);
  lines.push(`Viewport: ${viewport.width}x${viewport.height}`);

  if (manifestJson) {
    lines.push('');
    lines.push('## Page Elements (ground truth)');
    lines.push('Below is a structured inventory of actual DOM elements on this page. Cross-reference');
    lines.push('against this list — do NOT reference elements that aren\'t listed here.');
    lines.push('');
    lines.push('<manifest>');
    lines.push(manifestJson);
    lines.push('</manifest>');
  }

  // Include developer's annotations and style modifications as additional context
  if (feedbackContext) {
    lines.push('');
    lines.push('## Developer Context');
    lines.push('The developer has the following annotations and style changes on their canvas. Factor these into your plan:');
    lines.push(feedbackContext);
  }

  lines.push('');
  lines.push('## Goal');
  lines.push(goal);
  lines.push('');
  lines.push('## Your Task');
  lines.push('Analyze the screenshot and decompose the goal into specific, element-level tasks.');
  lines.push('Each task targets a specific region of the page and gives a clear instruction for a worker agent.');
  lines.push('');
  lines.push('Output your plan as a JSON array inside a <plan> tag. Each task has:');
  lines.push('- `id`: A short unique identifier (e.g., "t1", "t2")');
  lines.push('- `instruction`: Clear, specific instruction for a worker agent (what to change and how)');
  lines.push('- `region`: Bounding box in page coordinates `{x, y, width, height}` — where (x,y) is top-left corner');
  lines.push('- `priority`: Optional 1-5 (1=highest). Tasks with no dependency can share a priority level.');
  lines.push('');
  lines.push('Example:');
  lines.push('<plan>');
  lines.push('[');
  lines.push('  {"id":"t1","instruction":"Increase heading font-size to 48px and change font-weight to 700","region":{"x":100,"y":50,"width":600,"height":80},"priority":1},');
  lines.push('  {"id":"t2","instruction":"Add a subtle box-shadow to the card container","region":{"x":80,"y":200,"width":640,"height":300},"priority":2}');
  lines.push(']');
  lines.push('</plan>');
  lines.push('');
  lines.push('Guidelines:');
  lines.push('- CRITICAL: Cross-check all element references against the <manifest>. Only reference elements that actually exist. Use the manifest\'s text content, component names, and bounding rects for precise instructions.');
  lines.push('- Be specific about values (colors, sizes, spacing) rather than vague ("make it look better")');
  lines.push('- Each task should be independently actionable by a worker that can only see its region');
  lines.push('- Regions should tightly bound the relevant UI element(s)');
  lines.push('- Keep tasks atomic — one change per task, not multiple unrelated changes');
  lines.push('- Order by priority: structural changes first, then visual polish');
  lines.push('- If the goal can be accomplished as a single change, return a plan with just one task. Only decompose when the goal genuinely requires multiple independent changes.');
  lines.push('- If the goal is unclear or you need more context, output a question instead:');
  lines.push('<question>Your question here</question>');
  lines.push('');
  lines.push('Do NOT modify any files. You are a planner only — output a <plan> or <question>, nothing else.');

  return lines.join('\n');
}

/** Parse a <plan> block from Claude's response text */
export function parsePlan(responseText: string): PlanTask[] | null {
  const match = responseText.match(/<plan>\s*([\s\S]*?)\s*<\/plan>/);
  if (!match?.[1]) return null;

  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return null;

    return parsed.filter(
      (t: unknown): t is PlanTask => {
        if (typeof t !== 'object' || t === null) return false;
        const obj = t as Record<string, unknown>;
        if (typeof obj.id !== 'string' || typeof obj.instruction !== 'string') return false;
        if (typeof obj.region !== 'object' || obj.region === null) return false;
        const r = obj.region as Record<string, unknown>;
        return typeof r.x === 'number' && typeof r.y === 'number' &&
               typeof r.width === 'number' && typeof r.height === 'number';
      },
    );
  } catch {
    return null;
  }
}

// ============================
// Reviewer prompt + parser
// ============================

export function buildReviewerPrompt(
  screenshotPath: string,
  goal: string,
  completedTasks: { id: string; instruction: string; summary: string }[],
): string {
  const lines: string[] = [];

  lines.push('You are reviewing whether a series of UI changes achieved the original design goal.');
  lines.push('');
  lines.push(`IMPORTANT: First, use the Read tool to view the screenshot at: ${screenshotPath}`);
  lines.push('');
  lines.push('## Original Goal');
  lines.push(goal);
  lines.push('');
  lines.push('## Completed Tasks');
  for (const task of completedTasks) {
    lines.push(`- [${task.id}] ${task.instruction} → ${task.summary}`);
  }
  lines.push('');
  lines.push('## Your Task');
  lines.push('Look at the current screenshot and determine if the goal has been achieved.');
  lines.push('Output your verdict inside a <review> tag:');
  lines.push('<review>');
  lines.push('{"verdict":"pass","summary":"The changes look good..."}');
  lines.push('</review>');
  lines.push('');
  lines.push('Or if issues remain:');
  lines.push('<review>');
  lines.push('{"verdict":"fail","summary":"Some issues remain...","issues":["Issue 1","Issue 2"]}');
  lines.push('</review>');
  lines.push('');
  lines.push('Do NOT modify any files. Output only a <review> block.');

  return lines.join('\n');
}

// ============================
// Plan executor prompt (single-session multi-task)
// ============================

export function buildPlanExecutorPrompt(
  screenshotPath: string,
  tasks: Array<{
    planTaskId: string;
    annotationId: string;
    instruction: string;
    region: { x: number; y: number; width: number; height: number };
    linkedSelector?: string;
    elements?: Array<{ selector: string; reactComponent?: string }>;
  }>,
  pageUrl: string,
  viewport: { width: number; height: number },
  provider?: Provider,
): string {
  const lines: string[] = [];

  lines.push('You are implementing a series of UI changes on a web application.');
  lines.push('');
  if (provider !== 'codex') {
    lines.push(`IMPORTANT: First, use the Read tool to view the screenshot at: ${screenshotPath}`);
    lines.push('');
  }
  lines.push(`Page: ${pageUrl} (${viewport.width}x${viewport.height})`);
  lines.push('');
  lines.push('## Tasks');
  lines.push('Each task targets a specific region of the page. Complete them in order.');
  lines.push('');

  for (const task of tasks) {
    lines.push(`### Task ${task.planTaskId} (annotationId: ${task.annotationId})`);
    lines.push(`Instruction: ${task.instruction}`);
    lines.push(`Region: (${task.region.x}, ${task.region.y}) ${task.region.width}x${task.region.height}`);
    if (task.linkedSelector) {
      lines.push(`Target element: ${task.linkedSelector}`);
    }
    if (task.elements && task.elements.length > 0) {
      const elemDesc = task.elements
        .map(el => {
          const parts = [el.selector];
          if (el.reactComponent) parts.push(`(${el.reactComponent})`);
          return parts.join(' ');
        })
        .join(', ');
      lines.push(`Elements: ${elemDesc}`);
    }
    lines.push('');
  }

  lines.push('## Instructions');
  lines.push('- Apply each change to the source files — the dev server has HMR so changes appear immediately.');
  lines.push('- IMPORTANT: If any elements you modify have a `data-pm` attribute, preserve it in the source.');
  lines.push('- You may use parallel subagents (Task tool) for independent changes, or work serially — use your judgment.');
  lines.push('');
  lines.push('## Resolution');
  lines.push('CRITICAL: After completing EACH task, immediately output a <resolution> block for that task.');
  lines.push('Do NOT wait until all tasks are done — output each resolution as soon as that task is finished.');
  lines.push('<resolution>');
  lines.push('[{"annotationId":"<annotationId>","status":"resolved","summary":"<what you did>","filesModified":["<file>"],"declaredScope":{"breadth":"...","target":"..."},"inferredScope":{"breadth":"...","target":"..."}}]');
  lines.push('</resolution>');
  lines.push('Use status "resolved" when the change is complete, or "needs_review" if you\'re unsure about the result.');
  lines.push('');
  lines.push('### Scope classification');
  lines.push('Each resolution MUST include scope fields:');
  lines.push('- `declaredScope`: What scope the task instruction implies. null if no signal.');
  lines.push('- `inferredScope`: What scope the change actually has, based on what you modified.');
  lines.push('Scope has two dimensions:');
  lines.push('- `breadth`: "instance" (just this occurrence) or "pattern" (all similar occurrences)');
  lines.push('- `target`: "element" (a specific DOM element), "component" (a React/UI component), or "token" (a design token — color, spacing, typography)');
  lines.push('Note: "instance" + "token" is invalid — tokens are inherently patterns.');
  lines.push('If you cannot confidently determine scope, set it to null.');

  return lines.join('\n');
}

/** Parse a <review> block from Claude's response text */
export function parseReview(responseText: string): { verdict: 'pass' | 'fail'; summary: string; issues?: string[] } | null {
  const match = responseText.match(/<review>\s*([\s\S]*?)\s*<\/review>/);
  if (!match?.[1]) return null;

  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (parsed.verdict !== 'pass' && parsed.verdict !== 'fail') return null;
    if (typeof parsed.summary !== 'string') return null;
    return {
      verdict: parsed.verdict,
      summary: parsed.summary,
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((i: unknown) => typeof i === 'string') : undefined,
    };
  } catch {
    return null;
  }
}
