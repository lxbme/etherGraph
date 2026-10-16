import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./errors";

const NO_RETRY = ["invalid_input", "not_found", "conflict", "quota_exhausted"];

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
  tx: (h: string) => ["tx", h],
  transfers: (p: unknown) => ["transfers", p],
  labels: (a: string) => ["labels", a],
  status: () => ["status"],
  jobs: () => ["jobs"],
  workspaces: () => ["workspaces"],
};
