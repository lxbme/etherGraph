import { create } from "zustand";
import type { SseState } from "../api/sse";
import type { Event } from "../api/generated/Event";

export type JobProgressEvent = Extract<Event, { type: "JobProgress" }>;
export type QuotaInfo = { used: number; limit: number; paused: boolean; reset_at: string };

export const useSseState = create<{
  state: SseState;
  /** The first connection attempt has finished (opened or failed); reconnect cycles happen after it. */
  firstConnectDone: boolean;
  set(s: SseState): void;
}>((set) => ({
  state: "connecting",
  firstConnectDone: false,
  set: (state) => set((cur) => ({ state, firstConnectDone: cur.firstConnectDone || state !== "connecting" })),
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
  /** Forget these jobs (e.g. they finished while events were missed). */
  remove(ids: number[]): void;
  activeCount(): number;
}>((set, get) => ({
  byId: {},
  upsert: (e) => set((s) => ({ byId: { ...s.byId, [e.job_id]: e } })),
  remove: (ids) =>
    set((s) => {
      const drop = new Set(ids);
      return { byId: Object.fromEntries(Object.entries(s.byId).filter(([id]) => !drop.has(Number(id)))) };
    }),
  activeCount: () => Object.values(get().byId).filter((e) => ACTIVE.has(e.status)).length,
}));
