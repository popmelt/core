import { describe, expect, it } from 'vitest';

import type { FeedbackPayload, ThreadMessage } from './types';
import {
  buildPrompt,
  buildReplyPrompt,
  formatFeedbackContext,
  parseQuestion,
  parseResolutions,
} from './prompt-builder';

const baseFeedback: FeedbackPayload = {
  timestamp: '2025-01-01T00:00:00Z',
  url: 'http://localhost:3000',
  viewport: { width: 1280, height: 720 },
  scrollPosition: { x: 0, y: 0 },
  annotations: [],
  styleModifications: [],
};

describe('formatFeedbackContext', () => {
  it('returns empty string for empty input', () => {
    expect(formatFeedbackContext(baseFeedback)).toBe('');
  });

  it('formats annotations with instruction', () => {
    const feedback: FeedbackPayload = {
      ...baseFeedback,
      annotations: [
        {
          id: 'a1',
          type: 'text',
          instruction: 'Make this bigger',
          elements: [{ selector: 'div.hero', tagName: 'div' }],
        },
      ],
    };
    const result = formatFeedbackContext(feedback);
    expect(result).toContain('## Annotations');
    expect(result).toContain('id=a1');
    expect(result).toContain('Make this bigger');
    expect(result).toContain('div.hero');
  });

  it('shows "No text" when instruction is missing', () => {
    const feedback: FeedbackPayload = {
      ...baseFeedback,
      annotations: [
        { id: 'a1', type: 'rectangle', elements: [{ selector: 'p', tagName: 'p' }] },
      ],
    };
    const result = formatFeedbackContext(feedback);
    expect(result).toContain('No text');
  });

  it('includes reactComponent in element description', () => {
    const feedback: FeedbackPayload = {
      ...baseFeedback,
      annotations: [
        {
          id: 'a1',
          type: 'text',
          instruction: 'Fix',
          elements: [{ selector: 'div', tagName: 'div', reactComponent: 'HeroSection' }],
        },
      ],
    };
    const result = formatFeedbackContext(feedback);
    expect(result).toContain('(HeroSection)');
  });

  it('formats style modifications', () => {
    const feedback: FeedbackPayload = {
      ...baseFeedback,
      styleModifications: [
        {
          selector: 'div.card',
          element: { selector: 'div.card', tagName: 'div', reactComponent: 'Card' },
          changes: [{ property: 'background-color', original: '#fff', modified: '#000' }],
        },
      ],
    };
    const result = formatFeedbackContext(feedback);
    expect(result).toContain('## Style Changes');
    expect(result).toContain('div.card');
    expect(result).toContain('(Card)');
    expect(result).toContain('background-color');
    expect(result).toContain('#fff → #000');
  });

  it('shows "none" when annotation has no elements', () => {
    const feedback: FeedbackPayload = {
      ...baseFeedback,
      annotations: [
        { id: 'a1', type: 'freehand', instruction: 'here', elements: [] },
      ],
    };
    const result = formatFeedbackContext(feedback);
    expect(result).toContain('none');
  });
});

describe('buildPrompt', () => {
  it('contains the screenshot path', () => {
    const result = buildPrompt('/tmp/shot.png', baseFeedback);
    expect(result).toContain('/tmp/shot.png');
  });

  it('contains viewport dimensions', () => {
    const result = buildPrompt('/tmp/shot.png', baseFeedback);
    expect(result).toContain('1280x720');
  });

  it('includes thread history with human rounds', () => {
    const history: ThreadMessage[] = [
      { role: 'human', timestamp: 1, jobId: 'j1', feedbackSummary: 'Fix button' },
      { role: 'assistant', timestamp: 2, jobId: 'j1', responseText: 'Done' },
    ];
    const result = buildPrompt('/tmp/shot.png', baseFeedback, { threadHistory: history });
    expect(result).toContain('## Previous Conversation');
    expect(result).toContain('### Round 1 (human)');
    expect(result).toContain('Fix button');
    expect(result).toContain('### Round 1 (assistant)');
    expect(result).toContain('Done');
  });

  it('formats question and reply in thread history', () => {
    const history: ThreadMessage[] = [
      { role: 'human', timestamp: 1, jobId: 'j1', feedbackSummary: 'Fix button' },
      { role: 'assistant', timestamp: 2, jobId: 'j1', question: 'Which button?' },
      { role: 'human', timestamp: 3, jobId: 'j2', replyToQuestion: 'The big one' },
    ];
    const result = buildPrompt('/tmp/shot.png', baseFeedback, { threadHistory: history });
    expect(result).toContain('question');
    expect(result).toContain('Which button?');
    expect(result).toContain('reply');
    expect(result).toContain('The big one');
  });

  it('includes resolution and question blocks', () => {
    const result = buildPrompt('/tmp/shot.png', baseFeedback);
    expect(result).toContain('<resolution>');
    expect(result).toContain('</resolution>');
    expect(result).toContain('<question>');
    expect(result).toContain('</question>');
  });

  it('includes annotation IDs from thread history', () => {
    const history: ThreadMessage[] = [
      { role: 'human', timestamp: 1, jobId: 'j1', annotationIds: ['a1', 'a2'] },
    ];
    const result = buildPrompt('/tmp/shot.png', baseFeedback, { threadHistory: history });
    expect(result).toContain('a1, a2');
  });
});

describe('buildReplyPrompt', () => {
  it('includes original feedback context from first human message', () => {
    const history: ThreadMessage[] = [
      { role: 'human', timestamp: 1, jobId: 'j1', feedbackContext: '## Annotations\n- id=a1' },
      { role: 'assistant', timestamp: 2, jobId: 'j1', question: 'Which one?' },
      { role: 'human', timestamp: 3, jobId: 'j2', replyToQuestion: 'The red one' },
    ];
    const result = buildReplyPrompt('/tmp/shot.png', history);
    expect(result).toContain('## Annotations');
    expect(result).toContain('id=a1');
  });

  it('includes conversation history with reply', () => {
    const history: ThreadMessage[] = [
      { role: 'human', timestamp: 1, jobId: 'j1', feedbackSummary: 'Fix it' },
      { role: 'assistant', timestamp: 2, jobId: 'j1', question: 'Fix what?' },
      { role: 'human', timestamp: 3, jobId: 'j2', replyToQuestion: 'The header' },
    ];
    const result = buildReplyPrompt('/tmp/shot.png', history);
    expect(result).toContain('## Conversation History');
    expect(result).toContain('Fix it');
    expect(result).toContain('Fix what?');
    expect(result).toContain('The header');
  });

  it('includes screenshot path', () => {
    const result = buildReplyPrompt('/tmp/shot.png', []);
    expect(result).toContain('/tmp/shot.png');
  });

});

describe('parseQuestion', () => {
  it('extracts question from tags', () => {
    const text = 'Some text\n<question>What do you mean?</question>\nMore text';
    expect(parseQuestion(text)).toBe('What do you mean?');
  });

  it('returns null when no question tag', () => {
    expect(parseQuestion('No question here')).toBeNull();
  });

  it('trims whitespace from question', () => {
    expect(parseQuestion('<question>  Hello  </question>')).toBe('Hello');
  });
});

describe('parseResolutions', () => {
  it('parses valid resolution JSON array', () => {
    const text = `Done!\n<resolution>[{"annotationId":"a1","status":"resolved","summary":"Fixed the button"}]</resolution>`;
    const result = parseResolutions(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      annotationId: 'a1',
      status: 'resolved',
      summary: 'Fixed the button',
    });
  });

  it('returns empty array when no resolution tag', () => {
    expect(parseResolutions('No resolution here')).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseResolutions('<resolution>not json</resolution>')).toEqual([]);
  });

  it('filters entries with wrong shape', () => {
    const text = '<resolution>[{"annotationId":"a1","status":"resolved","summary":"ok"},{"bad":true}]</resolution>';
    const result = parseResolutions(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.annotationId).toBe('a1');
  });

  it('filters entries with invalid status values', () => {
    const text = '<resolution>[{"annotationId":"a1","status":"pending","summary":"nope"}]</resolution>';
    const result = parseResolutions(text);
    expect(result).toEqual([]);
  });

  it('accepts needs_review status', () => {
    const text = '<resolution>[{"annotationId":"a1","status":"needs_review","summary":"check this"}]</resolution>';
    const result = parseResolutions(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('needs_review');
  });

  it('includes optional filesModified', () => {
    const text = '<resolution>[{"annotationId":"a1","status":"resolved","summary":"ok","filesModified":["src/App.tsx"]}]</resolution>';
    const result = parseResolutions(text);
    expect(result[0]!.filesModified).toEqual(['src/App.tsx']);
  });
});
