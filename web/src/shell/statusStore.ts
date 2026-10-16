import { create } from "zustand";
import type { SseState } from "../api/sse";
import type { Event } from "../api/generated/Event";

export type JobProgressEvent = Extract<Event, { type: "JobProgress" }>;
export type QuotaInfo = { used: number; limit: number; paused: boolean; reset_at: string };

export const useSseState = create<{ state: SseState; set(s: SseState): void }>((set) => ({
  state: "connecting",
  set: (state) => set({ state }),
}));

export const useQuota = create<{
  quota: QuotaInfo | null;
  degraded: string | null;
  setQuota(q: QuotaInfo | null): void;
  setDegraded(d: string | null): void;
}>((set) => ({
  quota: null,
  degraded: null,
  setQuota: (quota) => set({ quota }),
  setDegraded: (degraded) => set({ degraded }),
}));

const ACTIVE = new Set(["pending", "running", "paused_quota"]);

export const useJobProgress = create<{
  byId: Record<number, JobProgressEvent>;
  upsert(e: JobProgressEvent): void;
  activeCount(): number;
}>((set, get) => ({
  byId: {},
  upsert: (e) => set((s) => ({ byId: { ...s.byId, [e.job_id]: e } })),
  activeCount: () => Object.values(get().byId).filter((e) => ACTIVE.has(e.status)).length,
}));
