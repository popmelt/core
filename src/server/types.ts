import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AnnotationResolution } from '../tools/types';

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
};

export type PopmeltHandle = {
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
  // Planner fields
  planId?: string;
  planTaskId?: string;
};

export type SSEEvent =
  | { type: 'job_started'; jobId: string; position: number }
  | { type: 'delta'; jobId: string; text: string }
  | { type: 'thinking'; jobId: string; text: string }
  | { type: 'tool_use'; jobId: string; tool: string; file?: string }
  | { type: 'done'; jobId: string; success: boolean; resolutions?: AnnotationResolution[]; responseText?: string; threadId?: string }
  | { type: 'error'; jobId: string; message: string }
  | { type: 'question'; jobId: string; threadId: string; question: string; annotationIds?: string[] }
  | { type: 'plan_ready'; jobId: string; planId: string; tasks: PlanTask[]; threadId?: string }
  | { type: 'plan_review'; planId: string; verdict: 'pass' | 'fail'; summary: string; issues?: string[] }
  | { type: 'task_resolved'; jobId: string; planId: string; resolutions: AnnotationResolution[]; threadId?: string }
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

// Planner types
export type PlanTask = {
  id: string;
  instruction: string;
  region: { x: number; y: number; width: number; height: number };
  priority?: number;
};

export type JobGroupStatus = 'planning' | 'awaiting_approval' | 'executing' | 'reviewing' | 'done' | 'error';

export type JobGroup = {
  id: string;
  goal: string;
  status: JobGroupStatus;
  plannerJobId: string;
  plannerThreadId?: string;
  plan?: PlanTask[];
  workerJobIds: string[];
  executorJobId?: string;
  screenshotPath: string;
  pageUrl: string;
  viewport: { width: number; height: number };
  createdAt: number;
};
