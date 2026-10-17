import { act, fireEvent, render, screen } from "@testing-library/react";
import { clearToasts, dismissToast, toast, Toasts } from "./Toasts";

beforeEach(() => act(() => clearToasts()));
afterEach(() => vi.useRealTimers());

test("a toast with an action renders a button that runs it and dismisses the toast", () => {
  const onClick = vi.fn();
  render(<Toasts />);
  act(() => void toast("Expanded 2 addresses", "info", { action: { label: "Undo", onClick } }));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Expanded 2 addresses")).toBeNull();
});

test("dismissToast removes only that toast; plain toasts still work", () => {
  render(<Toasts />);
  let id = 0;
  act(() => {
    id = toast("first");
    toast("second", "error");
  });
  expect(screen.getByText("first")).toBeInTheDocument();
  act(() => dismissToast(id));
  expect(screen.queryByText("first")).toBeNull();
  expect(screen.getByText("second")).toBeInTheDocument();
  act(() => dismissToast(9999)); // unknown id: no-op
  expect(screen.getByText("second")).toBeInTheDocument();
});

test("ttlMs overrides how long a toast stays", () => {
  vi.useFakeTimers();
  render(<Toasts />);
  act(() => {
    toast("short", "info", { ttlMs: 1000 });
    toast("default");
  });
  act(() => vi.advanceTimersByTime(1001));
  expect(screen.queryByText("short")).toBeNull();
  expect(screen.getByText("default")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(5000));
  expect(screen.queryByText("default")).toBeNull();
});

test("ttlMs: null keeps the toast until it is dismissed with its close button", () => {
  vi.useFakeTimers();
  const onDismiss = vi.fn();
  render(<Toasts />);
  act(() => void toast("sticky", "info", { ttlMs: null, onDismiss }));
  act(() => vi.advanceTimersByTime(60 * 60_000));
  expect(screen.getByText("sticky")).toBeInTheDocument();
  expect(onDismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByText("sticky")).toBeNull();
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("over the visible limit the oldest toast without an action goes first", () => {
  render(<Toasts />);
  const onDismiss = vi.fn();
  act(() => {
    toast("undo me", "info", { ttlMs: null, action: { label: "Undo", onClick: () => {} }, onDismiss });
    toast("a");
    toast("b");
    toast("c");
  });
  expect(screen.getByText("undo me")).toBeInTheDocument();
  expect(screen.queryByText("a")).toBeNull();
  expect(screen.getByText("c")).toBeInTheDocument();
  expect(onDismiss).not.toHaveBeenCalled();
  // Only actions left: the oldest goes after all, and is told so.
  act(() => {
    toast("x", "info", { action: { label: "X", onClick: () => {} } });
    toast("y", "info", { action: { label: "Y", onClick: () => {} } });
    toast("z", "info", { action: { label: "Z", onClick: () => {} } });
  });
  expect(screen.queryByText("undo me")).toBeNull();
  expect(onDismiss).toHaveBeenCalledTimes(1);
});
