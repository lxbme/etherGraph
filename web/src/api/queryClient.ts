import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./errors";

const NO_RETRY = [
  "invalid_input", "not_found", "conflict", "quota_exhausted", "user_quota_exhausted", "unauthorized", "rate_limited",
];

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && NO_RETRY.includes(error.code)) return false;
        return failureCount < 2;
      },
    },
  },
});

export const qk = {
  graph: (centers: string[], filter: unknown) => ["graph", centers, filter],
  address: (a: string) => ["address", a],
  /** Live summaries of a snapshot's nodes (`addrs` sorted). */
  nodes: (addrs: string[]) => ["nodes", addrs],
  tx: (h: string) => ["tx", h],
  token: (a: string) => ["token", a],
  /** An NFT's metadata: token address (lowercase) and decimal id. */
  nft: (a: string, id: string) => ["nft", a, id],
  txRaw: (h: string) => ["txRaw", h],
  txTrace: (h: string) => ["txTrace", h],
  transfers: (p: unknown) => ["transfers", p],
  /** The Data tab's transfers: the canvas edges' pairs under the graph filter. */
  transfersBatch: (pairs: unknown, filter: unknown) => ["transfersBatch", pairs, filter],
  /** An address's assets, or a pair's per direction (`b`). */
  addressAssets: (a: string, b?: string) => ["addressAssets", a.toLowerCase(), b?.toLowerCase() ?? null],
  labels: (a: string) => ["labels", a],
  status: () => ["status"],
  jobs: () => ["jobs"],
  workspaces: () => ["workspaces"],
  /** The admin page's local datasets (under the admin keys: signed actions refresh it, leaving admin mode drops it). */
  localData: () => ["admin", "localData"],
  /** The latest `LocalDataProgress` event per source, kept from the event stream (never fetched). */
  localDataProgress: () => ["admin", "localDataProgress"],
};
