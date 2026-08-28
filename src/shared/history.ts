import type { Plan } from "./schema";

/** Metadata supplied by a writer when a plan revision is created. */
export interface HistoryActor {
  actorId?: string;
  actorName?: string;
  /** A browser tab or automation run. Consecutive edits share this work session. */
  sessionId?: string;
  source?: "editor" | "chat" | "mcp" | "migration" | "system";
}

/** Lightweight revision metadata returned to the browser. */
export interface PlanRevision {
  id: string;
  rev: number;
  createdAt: number;
  sessionId: string;
  sessionStartedAt: number;
  actorId?: string;
  actorName: string;
  source: "editor" | "chat" | "mcp" | "migration" | "system";
  summary: string;
}

export interface PlanHistory {
  revisions: PlanRevision[];
  currentId: string | null;
  /** The exact snapshots the server stacks would visit next. */
  undoId: string | null;
  redoId: string | null;
  canUndo: boolean;
  canRedo: boolean;
}

export interface HistoryResult {
  plan: Plan;
  history: PlanHistory;
}
