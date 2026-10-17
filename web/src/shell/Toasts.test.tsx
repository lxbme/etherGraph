import { act, fireEvent, render, screen } from "@testing-library/react";
import { dismissToast, toast, Toasts } from "./Toasts";

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
