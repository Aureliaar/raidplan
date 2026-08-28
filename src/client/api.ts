import type { Op } from "../shared/apply";
import type { Plan, PlanRole, PlanSummary, User } from "../shared/schema";
import type { HistoryResult, PlanHistory } from "../shared/history";
import { prepareBackground } from "./background-image";
import type { FFLogsDebuffDump } from "../shared/fflogs";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  me: () => req<{ user: User | null; devAuth: boolean }>("/api/me"),

  fflogsDebuffs: (url: string) =>
    req<FFLogsDebuffDump>("/api/fflogs/debuffs", { method: "POST", body: JSON.stringify({ url }) }),
  fflogsConfig: () => req<{
    clientId: string;
    redirectUrl: string;
    authorizeUrl: string;
    userApiUrl: string;
  }>("/api/fflogs/config"),
  fflogsExchange: (code: string) =>
    req<{ access_token: string; expires_in?: number }>("/api/fflogs/exchange", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),

  uploadBackground: async (file: File) => {
    const prepared = await prepareBackground(file);
    const uploaded = await req<{ url: string; width: number; height: number }>("/api/backgrounds", {
      method: "POST",
      headers: { "content-type": prepared.file.type || "application/octet-stream" },
      body: prepared.file,
    });
    return {
      ...uploaded,
      resized: prepared.resized,
      originalWidth: prepared.originalWidth,
      originalHeight: prepared.originalHeight,
    };
  },

  listPlans: () => req<PlanSummary[]>("/api/plans"),
  createPlan: (body: { name: string; encounter?: string; withParty?: boolean; variantModel?: "beat" }) =>
    req<{ id: string }>("/api/plans", { method: "POST", body: JSON.stringify(body) }),
  getPlan: (id: string) =>
    req<{ plan: Plan; role: PlanRole; meta: { isPublic: boolean } | null }>(`/api/plans/${id}`),
  deletePlan: (id: string) => req<{ ok: true }>(`/api/plans/${id}`, { method: "DELETE" }),
  saveEncounter: (id: string) =>
    req<{ encounter: string; markers: number }>(`/api/plans/${id}/encounter/save`, { method: "POST" }),
  applyEncounter: (id: string) =>
    req<{ rev: number; plan: Plan }>(`/api/plans/${id}/encounter/apply`, { method: "POST" }),
  setPublic: (id: string, isPublic: boolean) =>
    req<{ ok: true }>(`/api/plans/${id}/public`, { method: "POST", body: JSON.stringify({ isPublic }) }),
  share: (id: string, userId: string, role: PlanRole | null) =>
    req<{ ok: true }>(`/api/plans/${id}/share`, {
      method: "POST",
      body: JSON.stringify({ userId, role, remove: role === null }),
    }),
  collaborators: (id: string) =>
    req<{ userId: string; role: PlanRole; name: string | null }[]>(`/api/plans/${id}/collaborators`),
  /** Every mutation in the app goes through here. */
  ops: (planId: string, ops: Op | Op[], sessionId?: string) =>
    req<{ rev: number; values: unknown[]; plan: Plan; history: PlanHistory }>(`/api/plans/${planId}/ops`, {
      method: "POST",
      body: JSON.stringify({ ops, sessionId }),
    }),
  history: (planId: string) => req<PlanHistory>(`/api/plans/${planId}/history`),
  undo: (planId: string) =>
    req<HistoryResult>(`/api/plans/${planId}/history/undo`, { method: "POST" }),
  redo: (planId: string) =>
    req<HistoryResult>(`/api/plans/${planId}/history/redo`, { method: "POST" }),
  revert: (planId: string, revisionId: string, sessionId?: string) =>
    req<HistoryResult>(`/api/plans/${planId}/history/revert`, {
      method: "POST",
      body: JSON.stringify({ revisionId, sessionId }),
    }),

  listTokens: () => req<{ id: string; label: string; createdAt: number; lastUsedAt?: number }[]>("/api/tokens"),
  createToken: (label: string) =>
    req<{ id: string; token: string; mcpUrl: string }>("/api/tokens", {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
  revokeToken: (id: string) => req<{ ok: true }>(`/api/tokens/${id}`, { method: "DELETE" }),

  chatConfig: () => req<{ enabled: boolean; allowed: boolean; model: string }>("/api/chat/config"),
  chat: (planId: string, messages: { role: "user" | "assistant"; content: string }[]) =>
    req<{ reply: string; trace: { tool: string; result: string }[] }>(`/api/chat/${planId}`, {
      method: "POST",
      body: JSON.stringify({ messages }),
    }),
};
