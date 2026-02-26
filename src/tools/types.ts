export type AnnotationLifecycleStatus = 'pending' | 'in_flight' | 'resolved' | 'needs_review' | 'dismissed' | 'waiting_input';

export type ScopeBreadth = 'instance' | 'pattern';
export type ScopeTarget = 'element' | 'component' | 'token';
export type Scope = { breadth: ScopeBreadth; target: ScopeTarget };

export type AnnotationResolution = {
  annotationId: string;
  status: 'resolved' | 'needs_review';
  summary: string;
  filesModified?: string[];
  declaredScope?: Scope | null;
  inferredScope?: Scope | null;
  finalScope?: Scope | null;
};

export type ManifestEntry = {
  tag: string;
  text?: string;
  rect: { x: number; y: number; w: number; h: number };
  component?: string;
  classes?: string;
  styles?: Record<string, string>;
  depth: number;
  role?: string;
  href?: string;
  alt?: string;
};

export type ToolType = 'freehand' | 'line' | 'rectangle' | 'circle' | 'text' | 'inspector' | 'hand' | 'model';

export type Point = {
  x: number;
  y: number;
};

export type ElementInfo = {
  selector: string;
  tagName: string;
  id?: string;
  className?: string;
  textContent?: string;
  dataAttributes?: Record<string, string>;
  reactComponent?: string;
  context?: string; // Nearest meaningful ancestor (e.g., section#pricing)
};

export type StyleChange = {
  property: string;       // e.g., "background-color"
  original: string;       // e.g., "#3b82f6"
  modified: string;       // e.g., "#10b981"
};

export type StyleModification = {
  selector: string;              // CSS selector for the element (data-pm during session)
  durableSelector?: string;      // Stable CSS path selector that survives page refresh
  element: ElementInfo;          // Context (tagName, reactComponent, etc.)
  changes: StyleChange[];
  captured?: boolean;            // Has been included in a screenshot (read-only)
};

export type InspectedElement = {
  el: Element;
  info: ElementInfo;
};

export type SpacingElementEvidence = {
  selector: string;          // unique CSS selector
  reactComponent?: string;   // "ContentLayout"
  className: string;         // full className string
  property: string;          // "gap", "padding-top", etc.
  matchedClass?: string;     // "gap-6" (Tailwind class producing old value)
  suggestedClass?: string;   // "gap-8" (Tailwind class for new value)
};

export type SpacingTokenChange = {
  id: string;
  tokenPath: string;         // "tokens.spacing.section-gap"
  tokenName: string;         // "section-gap"
  originalPx: number;
  newPx: number;
  captured?: boolean;
  affectedElements: SpacingElementEvidence[];
};

export type Annotation = {
  id: string;
  type: ToolType;
  points: Point[];
  color: string;
  strokeWidth: number;
  text?: string;
  fontSize?: number;
  timestamp: number;
  groupId?: string; // Links annotations that move together
  captured?: boolean; // Has been included in a screenshot (read-only) — deprecated, use status
  status?: AnnotationLifecycleStatus; // Lifecycle state (default: 'pending')
  question?: string; // Pending question from Claude (when status === 'waiting_input')
  resolutionSummary?: string; // What Claude did (when status === 'resolved' or 'needs_review')
  scope?: Scope | null; // Effective scope (finalScope ?? inferredScope)
  replyCount?: number; // Number of Claude responses for this annotation
  threadId?: string; // Thread this annotation belongs to
  elements?: ElementInfo[]; // DOM elements captured at creation time
  linkedSelector?: string; // CSS selector of linked DOM element (inspector pin)
  linkedAnchor?: 'top-left' | 'bottom-left'; // Which corner to anchor to
  imageCount?: number; // Number of pasted images attached (blobs stored out-of-band)
};

/** A token modification tracked for undo/redo. Stores enough to revert both
 *  the model.json value and DOM inline style overrides. */
export type SpacingTokenMod = {
  tokenPath: string;            // "tokens.spacing.section-gap"
  originalValue: string;        // Serialized original value (JSON string for enriched, or plain "8px")
  currentValue: string;         // Serialized new value, or '__deleted__' sentinel
  targets: Array<{ selector: string; property: string }>;  // For inline style sync
  originalPx: number;
  currentPx: number;            // 0 for deleted
};

// Undo stack entry stores annotations, style modifications, and spacing token modifications
export type UndoEntry = {
  annotations: Annotation[];
  styleModifications: StyleModification[];
  spacingTokenMods: SpacingTokenMod[];
};

export type AnnotationState = {
  isAnnotating: boolean;
  activeTool: ToolType;
  activeColor: string;
  strokeWidth: number;
  annotations: Annotation[];
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  currentPath: Point[];
  selectedAnnotationIds: string[];
  lastSelectedId: string | null; // Drives counter color when multiple selected
  // Inspector state
  inspectedElement: InspectedElement | null;
  styleModifications: StyleModification[];
  spacingTokenChanges: SpacingTokenChange[];
  spacingTokenMods: SpacingTokenMod[];
};

// Bridge types (client-side)
export type BridgeStatus = {
  ok: boolean;
  activeJob: { id: string; status: string } | null;
  queueDepth: number;
  sessionId: string | null;
};

export type BridgeEvent = {
  type: 'job_started' | 'delta' | 'tool_use' | 'done' | 'error';
  data: Record<string, unknown>;
  timestamp: number;
};

export type ClaudeResponse = {
  jobId: string;
  sessionId?: string;
  text: string;
  success: boolean;
  toolsUsed: string[];
};

export type AnnotationAction =
  | { type: 'SET_ANNOTATING'; payload: boolean }
  | { type: 'SET_TOOL'; payload: ToolType }
  | { type: 'SET_COLOR'; payload: string }
  | { type: 'SET_STROKE_WIDTH'; payload: number }
  | { type: 'START_PATH'; payload: Point }
  | { type: 'CONTINUE_PATH'; payload: Point }
  | { type: 'FINISH_PATH'; payload?: { groupId?: string; elements?: ElementInfo[] } }
  | { type: 'CANCEL_PATH' }
  | { type: 'ADD_TEXT'; payload: {
      point: Point;
      text: string;
      fontSize?: number;
      id?: string;
      groupId?: string;
      linkedSelector?: string;
      linkedAnchor?: 'top-left' | 'bottom-left';
      elements?: ElementInfo[];
      imageCount?: number;
    } }
  | { type: 'UPDATE_TEXT'; payload: { id: string; text: string; imageCount?: number } }
  | { type: 'UPDATE_TEXT_SIZE'; payload: { id: string; fontSize: number } }
  | { type: 'DELETE_ANNOTATION'; payload: { id: string } }
  | { type: 'MOVE_ANNOTATION'; payload: { id: string; delta: Point; saveUndo?: boolean } }
  | { type: 'RESIZE_ANNOTATION'; payload: { id: string; points: Point[]; saveUndo?: boolean } }
  | { type: 'PASTE_ANNOTATIONS'; payload: { annotations: Annotation[] } }
  | { type: 'RESTORE_ANNOTATIONS'; payload: { annotations: Annotation[] } }
  | { type: 'SELECT_ANNOTATION'; payload: { id: string | null; addToSelection?: boolean } }
  | { type: 'UPDATE_ANNOTATION_COLOR'; payload: { id: string; color: string } }
  | { type: 'MARK_CAPTURED' }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'CLEAR' }
  // Inspector actions
  | { type: 'SELECT_ELEMENT'; payload: InspectedElement | null }
  | { type: 'MODIFY_STYLE'; payload: { selector: string; element: ElementInfo; property: string; original: string; modified: string } }
  | { type: 'MODIFY_STYLES_BATCH'; payload: { selector: string; durableSelector?: string; element: ElementInfo; changes: { property: string; original: string; modified: string }[] } }
  | { type: 'CLEAR_STYLE'; payload: { selector: string; property: string } }
  | { type: 'CLEAR_ALL_STYLES' }
  | { type: 'RESTORE_STYLE_MODIFICATIONS'; payload: StyleModification[] }
  | { type: 'UPDATE_LINKED_POSITIONS'; payload: { updates: { id: string; point: Point; linkedAnchor?: 'top-left' | 'bottom-left' }[] } }
  | { type: 'CLEANUP_ORPHANED'; payload: { linkedSelectors: string[]; styleSelectors: string[] } }
  | { type: 'SET_ANNOTATION_STATUS'; payload: { ids: string[]; status: AnnotationLifecycleStatus } }
  | { type: 'SET_ANNOTATION_THREAD'; payload: { ids: string[]; threadId: string } }
  | { type: 'SET_ANNOTATION_QUESTION'; payload: { ids: string[]; question: string; threadId: string } }
  | { type: 'APPLY_RESOLUTIONS'; payload: { resolutions: AnnotationResolution[]; threadId?: string } }
  | { type: 'ADD_SPACING_TOKEN_CHANGE'; payload: SpacingTokenChange }
  | { type: 'RESTORE_SPACING_TOKEN_CHANGES'; payload: SpacingTokenChange[] }
  | { type: 'MODIFY_SPACING_TOKEN'; payload: SpacingTokenMod }
  | { type: 'DELETE_SPACING_TOKEN'; payload: { tokenPath: string; originalValue: string } }
