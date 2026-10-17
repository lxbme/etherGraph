import { act, renderHook, waitFor } from "@testing-library/react";
import { api } from "../../api/endpoints";
import { ApiError } from "../../api/errors";
import type { ProbeItemDto } from "../../api/generated/ProbeItemDto";
import type { ProbeResponseDto } from "../../api/generated/ProbeResponseDto";
import { useProbe } from "./useProbe";

const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const item = (a: string): ProbeItemDto => ({
  address: a, kind: "eoa", nonce: 1, balance: "0", local_transfers: 0, synced: false, partial: false, probed_at: "",
});
const answer = (addresses: string[], calls = 2): ProbeResponseDto => ({ items: addresses.map(item), calls });
const list = (n: number) => Array.from({ length: n }, (_, i) => addr(i + 1));

afterEach(() => vi.restoreAllMocks());

test("probes the first chunk interactively, then only on more(), in background", async () => {
  const probe = vi.spyOn(api, "probe").mockImplementation(async (r) => answer(r.addresses));
  const addrs = list(45);
  const { result } = renderHook(() => useProbe(addrs));
  await waitFor(() => expect(result.current.probed).toBe(20));
  expect(probe).toHaveBeenCalledTimes(1);
  expect(probe.mock.calls[0]![0]).toEqual({ addresses: addrs.slice(0, 20), priority: "interactive" });
  expect(result.current.calls).toBe(2);
  expect(result.current.busy).toBe(false);
  expect(result.current.items.get(addrs[0]!)?.nonce).toBe(1);

  act(() => result.current.more());
  await waitFor(() => expect(result.current.probed).toBe(40));
  expect(probe.mock.calls[1]![0]).toEqual({ addresses: addrs.slice(20, 40), priority: "background" });
  act(() => result.current.more());
  await waitFor(() => expect(result.current.probed).toBe(45));
  expect(result.current.calls).toBe(6);
  expect(result.current.remaining).toBe(0);
  act(() => result.current.more()); // nothing left
  expect(probe).toHaveBeenCalledTimes(3);
});

test("an empty list probes nothing; a list arriving later starts the first chunk", async () => {
  const probe = vi.spyOn(api, "probe").mockImplementation(async (r) => answer(r.addresses));
  const { result, rerender } = renderHook(({ a }) => useProbe(a), { initialProps: { a: [] as string[] } });
  expect(probe).not.toHaveBeenCalled();
  rerender({ a: list(3) });
  await waitFor(() => expect(result.current.probed).toBe(3));
  expect(probe).toHaveBeenCalledTimes(1);
});

test("a failed chunk reports the error and is put back: more() re-sends the same addresses and clears it", async () => {
  const probe = vi.spyOn(api, "probe").mockRejectedValueOnce(new ApiError("upstream_error", 502, "x"));
  probe.mockImplementation(async (r) => answer(r.addresses));
  const addrs = list(30);
  const { result } = renderHook(() => useProbe(addrs));
  await waitFor(() => expect(result.current.error).toBeInstanceOf(ApiError));
  expect(probe).toHaveBeenCalledTimes(1);
  expect(result.current.remaining).toBe(30);
  act(() => result.current.more());
  await waitFor(() => expect(result.current.probed).toBe(20));
  expect(probe.mock.calls[1]![0].addresses).toEqual(addrs.slice(0, 20));
  expect(result.current.error).toBeNull();
});

test("more() while a chunk is in flight sends nothing; after unmount nothing is sent or set", async () => {
  let release: (v: ProbeResponseDto) => void = () => {};
  const probe = vi.spyOn(api, "probe").mockImplementation(() => new Promise((r) => { release = r; }));
  const err = vi.spyOn(console, "error");
  const addrs = list(30);
  const { result, unmount } = renderHook(() => useProbe(addrs));
  expect(probe).toHaveBeenCalledTimes(1);
  act(() => result.current.more());
  expect(probe).toHaveBeenCalledTimes(1);
  const more = result.current.more;
  unmount();
  await act(async () => release(answer(addrs.slice(0, 20))));
  await new Promise((r) => setTimeout(r, 10));
  more();
  expect(probe).toHaveBeenCalledTimes(1);
  expect(err).not.toHaveBeenCalled();
});
