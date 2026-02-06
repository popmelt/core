import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AnnotationResolution } from '../tools/types';

export type Provider = 'claude' | 'codex';

export type BridgeServerOptions = {
  port?: number;
  projectRoot?: string;
  tempDir?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  claudePath?: string;
  provider?: Provider;
};

export type BridgeServerHandle = {
  port: number;
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
};

export type SSEEvent =
  | { type: 'job_started'; jobId: string; position: number }
  | { type: 'delta'; text: string }
  | { type: 'tool_use'; tool: string; file?: string }
  | { type: 'done'; jobId: string; success: boolean; resolutions?: AnnotationResolution[]; responseText?: string; threadId?: string }
  | { type: 'error'; jobId: string; message: string }
  | { type: 'question'; jobId: string; threadId: string; question: string; annotationIds?: string[] }
  | { type: 'queue_drained' };

export type SSEClient = {
  id: string;
  res: ServerResponse<IncomingMessage>;
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
};

export type Thread = {
  id: string;
  createdAt: number;
  updatedAt: number;
  elementIdentifiers: string[]; // linkedSelector values for continuation matching
  messages: ThreadMessage[];
};

export type ThreadStore = { version: 1; threads: Record<string, Thread> };
