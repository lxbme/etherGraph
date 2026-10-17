import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/endpoints";
import type { ProbeItemDto } from "../../api/generated/ProbeItemDto";
import { PROBE_CHUNK } from "../../graph/budget";

export interface ProbeState {
  /** Probe results by lowercase address. */
  items: Map<string, ProbeItemDto>;
  /** Addresses with a result. */
  probed: number;
  /** Addresses not sent yet. */
  remaining: number;
  /** Upstream calls the probes made (cache hits cost none). */
  calls: number;
  /**
   * Probes the next chunk (background priority; after a failure, the failed one again). Returns whether a request
   * was sent: false while one is in flight, after unmount, or when nothing is left.
   */
  more(): boolean;
  busy: boolean;
  /** The last failed chunk's error, cleared by the next success. A failed chunk is not retried by itself. */
  error: unknown;
}

const lc = (s: string) => s.toLowerCase();

/**
 * Probes `addresses` (already in probe order) in chunks of PROBE_CHUNK, one request at a time: the first chunk
 * at once with interactive priority, each later one in the background on `more()` (the caller decides when more
 * are needed, from the results so far). After unmount nothing new is sent and in-flight answers are dropped
 * (the server has cached them).
 */
export function useProbe(addresses: string[]): ProbeState {
  const [items, setItems] = useState<Map<string, ProbeItemDto>>(() => new Map());
  const [calls, setCalls] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** Number of addresses sent so far (mirrors `sentRef` for rendering). */
  const [sent, setSent] = useState(0);

  const alive = useRef(true);
  const inFlight = useRef(false);
  const sentRef = useRef(0);
  const list = useRef(addresses);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Before the first-chunk effect below, so it sees the new list.
  useEffect(() => {
    list.current = addresses;
  }, [addresses]);

  const probeNext = useCallback((priority: "interactive" | "background"): boolean => {
    const all = list.current;
    if (!alive.current || inFlight.current || sentRef.current >= all.length) return false;
    const chunk = all.slice(sentRef.current, sentRef.current + PROBE_CHUNK);
    sentRef.current += chunk.length;
    inFlight.current = true;
    setSent(sentRef.current);
    setBusy(true);
    api
      .probe({ addresses: chunk, priority })
      .then((r) => {
        if (!alive.current) return;
        setItems((cur) => {
          const next = new Map(cur);
          for (const it of r.items) next.set(lc(it.address), it);
          return next;
        });
        setCalls((c) => c + r.calls);
        setError(null);
      })
      .catch((err: unknown) => {
        // Put the chunk back (it is the last one sent: one request at a time), so `more()` re-sends it.
        sentRef.current -= chunk.length;
        if (!alive.current) return;
        setSent(sentRef.current);
        setError(err);
      })
      .finally(() => {
        inFlight.current = false;
        if (alive.current) setBusy(false);
      });
    return true;
  }, []);

  // The first chunk, as soon as there is something to probe.
  useEffect(() => {
    if (sentRef.current === 0 && addresses.length > 0) probeNext("interactive");
  }, [addresses, probeNext]);

  const more = useCallback(() => probeNext("background"), [probeNext]);

  return {
    items,
    probed: items.size,
    remaining: Math.max(0, addresses.length - sent),
    calls,
    more,
    busy,
    error,
  };
}
