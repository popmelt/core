import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AnnotationResolution } from '../tools/types';

export type McpDetection = {
  found: boolean;
  name: string | null;
  scope: 'user' | 'project' | 'mcp.json' | null;
  disabled: boolean;
};

export type Provider = 'claude' | 'codex';

export type PopmeltOptions = {
  port?: number;
  projectRoot?: string;
  tempDir?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  claudePath?: string;
  provider?: Provider;
  timeoutMs?: number;
  devOrigin?: string;
};

export type PopmeltHandle = {
  port: number;
  projectId: string;
  close: () => Promise<void>;
};

export type FeedbackPayload = {
  timestamp: string;
  url: string;
  viewport: { width: number; height: number };
  scrollPosition: { x: number; y: number };
  annotations: {
    id: string;
    type: string;
    instruction?: string;
    linkedSelector?: string;
    imageCount?: number;
    elements: {
      selector: string;
      tagName: string;
      id?: string;
      className?: string;
      textContent?: string;
      reactComponent?: string;
      context?: string;
    }[];
  }[];
  styleModifications: {
    selector: string;
    element: {
      selector: string;
      tagName: string;
      reactComponent?: string;
    };
    changes: {
      property: string;
      original: string;
      modified: string;
    }[];
  }[];
  inspectedElement?: {
    selector: string;
    tagName: string;
    id?: string;
    className?: string;
    textContent?: string;
    reactComponent?: string;
    context?: string;
  };
  spacingTokenChanges?: {
    tokenPath: string;
    tokenName: string;
    originalPx: number;
    newPx: number;
    affectedElements: {
      selector: string;
      reactComponent?: string;
      className: string;
      property: string;
      matchedClass?: string;
      suggestedClass?: string;
    }[];
  }[];
};

export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export type Job = {
  id: string;
  status: JobStatus;
  screenshotPath: string;
  feedback: FeedbackPayload;
  createdAt: number;
  color?: string;
  result?: string;
  error?: string;
  threadId?: string;
  annotationIds?: string[];
  provider?: Provider;
  model?: string;
  imagePaths?: Record<string, string[]>; // annotationId → temp file paths for pasted images
  sourceId?: string; // SSE scoping — only the originating client sees job events
};

export type SSEEvent =
  | { type: 'job_started'; jobId: string; position: number; threadId?: string }
  | { type: 'delta'; jobId: string; text: string }
  | { type: 'thinking'; jobId: string; text: string }
  | { type: 'tool_use'; jobId: string; tool: string; file?: string }
  | { type: 'done'; jobId: string; success: boolean; resolutions?: AnnotationResolution[]; responseText?: string; threadId?: string }
  | { type: 'error'; jobId: string; message: string; cancelled?: boolean }
  | { type: 'question'; jobId: string; threadId: string; question: string; annotationIds?: string[] }
  | { type: 'queue_drained' }
  | { type: 'materialize_started'; decisionIds: string[] }
  | { type: 'materialize_done'; decisionIds: string[]; success: boolean; error?: string }
  | { type: 'novel_patterns'; jobId: string; patterns: NovelPattern[]; threadId?: string }
  | { type: 'capabilities_changed'; data: Record<string, unknown> };

export type NovelPattern = {
  category: 'token' | 'component' | 'element';
  element: string;
  decision: string;
  reason: string;
};

export type SSEClient = {
  id: string;
  res: ServerResponse<IncomingMessage>;
  sourceId?: string;
};

// Thread model types
export type ThreadMessage = {
  role: 'human' | 'assistant';
  timestamp: number;
  jobId: string;
  // Human
  screenshotPath?: string;
  annotationIds?: string[];
  feedbackSummary?: string;
  feedbackContext?: string; // Full formatted annotation details (selectors, elements, etc.)
  // Assistant
  responseText?: string;
  resolutions?: AnnotationResolution[];
  toolsUsed?: string[];
  sessionId?: string;
  question?: string;         // assistant asks a question
  replyToQuestion?: string;  // human replies to a question
  cancelled?: boolean;       // job was cancelled by user
  error?: string;            // spawn/runtime error (e.g. git trust, timeout)
  model?: string;            // model id used for this message
  provider?: Provider;       // provider used for this message
};

export type Thread = {
  id: string;
  createdAt: number;
  updatedAt: number;
  elementIdentifiers: string[]; // linkedSelector values for continuation matching
  messages: ThreadMessage[];
};

export type ThreadStore = { version: 1; threads: Record<string, Thread> };

// File edit types (used by claude-spawner and decision-store)
export type FileEdit = {
  tool: 'Edit' | 'Write';
  file_path: string;
  old_string?: string;  // Edit tool: text that was replaced
  new_string?: string;  // Edit tool: replacement text
  replace_all?: boolean;
  content?: string;     // Write tool: full file content written
};

// Decision record — persisted for every completed job
export type DecisionRecord = {
  version: 1;
  id: string;
  createdAt: number;
  completedAt: number;
  durationMs: number;
  url: string;
  viewport: { width: number; height: number };
  screenshotPath: string;
  pastedImagePaths: string[];
  annotations: FeedbackPayload['annotations'];
  styleModifications: FeedbackPayload['styleModifications'];
  inspectedElement?: FeedbackPayload['inspectedElement'];
  provider: Provider | undefined;
  model: string | undefined;
  sessionId: string | undefined;
  threadId: string | undefined;
  responseText: string;
  resolutions: AnnotationResolution[];
  question: string | undefined;
  fileEdits: FileEdit[];
  toolsUsed: string[] | undefined;
  gitDiff: string | null;
};

export type MaterializationIndex = {
  version: 1;
  materializedIds: string[];
  lastRunAt: number | null;
  lastRunDecisionIds: string[];
  lastRunError: string | null;
};

export type MaterializationResult = {
  processedIds: string[];
  success: boolean;
  error?: string;
};
