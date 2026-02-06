import type { AnnotationResolution } from '../tools/types';
import type { FeedbackPayload, Provider, ThreadMessage } from './types';

/** Format feedback annotations and style modifications into prompt-ready text */
export function formatFeedbackContext(feedback: FeedbackPayload): string {
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

  return lines.join('\n');
}

export function buildPrompt(
  screenshotPath: string,
  feedback: FeedbackPayload,
  options?: {
    threadHistory?: ThreadMessage[];
    provider?: Provider;
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
              lines.push(`- ${r.annotationId}: ${r.status} — ${r.summary}`);
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

  const feedbackContext = formatFeedbackContext(feedback);
  if (feedbackContext) {
    lines.push('');
    lines.push(feedbackContext);
  }

  lines.push('');
  lines.push(
    'Apply the requested changes to the source files. The dev server has HMR so the developer will see your changes immediately in the browser.',
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
  lines.push('[{"annotationId":"<id>","status":"resolved","summary":"<what you did>","filesModified":["<file>"]}]');
  lines.push('</resolution>');
  lines.push('Use status "resolved" when the change is complete, or "needs_review" if you\'re unsure about the result.');

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
  lines.push('');
  lines.push('Apply the requested changes to the source files. The dev server has HMR so the developer will see your changes immediately in the browser.');
  lines.push('');
  lines.push('IMPORTANT: If any elements you modify have a `data-pm` attribute, preserve it in the source. This attribute tracks annotation positions.');

  // Resolution instruction
  lines.push('');
  lines.push('## Resolution');
  lines.push('After completing all work, output a resolution block listing what you did for each annotation:');
  lines.push('<resolution>');
  lines.push('[{"annotationId":"<id>","status":"resolved","summary":"<what you did>","filesModified":["<file>"]}]');
  lines.push('</resolution>');
  lines.push('Use status "resolved" when the change is complete, or "needs_review" if you\'re unsure about the result.');

  // Question instruction
  lines.push('');
  lines.push('## Questions');
  lines.push('If you still need clarification, output:');
  lines.push('<question>Your question here</question>');
  lines.push('You may output BOTH a <resolution> and a <question> in the same response.');

  return lines.join('\n');
}

/** Parse resolution blocks from Claude's response text */
export function parseResolutions(responseText: string): AnnotationResolution[] {
  const match = responseText.match(/<resolution>\s*([\s\S]*?)\s*<\/resolution>/);
  if (!match || !match[1]) return [];

  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return [];

    // Validate shape
    return parsed.filter(
      (r: unknown): r is AnnotationResolution =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as Record<string, unknown>).annotationId === 'string' &&
        ((r as Record<string, unknown>).status === 'resolved' || (r as Record<string, unknown>).status === 'needs_review') &&
        typeof (r as Record<string, unknown>).summary === 'string',
    );
  } catch {
    return [];
  }
}
