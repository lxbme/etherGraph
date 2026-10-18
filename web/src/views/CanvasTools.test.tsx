import { act, render, screen, within } from "@testing-library/react";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { useIdentifying } from "../graph/identify";
import { CanvasTools, IdentifyAllButton } from "./CanvasTools";

test("a toolbar with the select-mode toggle (aria-pressed) and room for more tools", () => {
  const onSelectModeChange = vi.fn();
  const { rerender } = render(
    <CanvasTools selectMode={false} onSelectModeChange={onSelectModeChange}>
      <button type="button">extra</button>
    </CanvasTools>,
  );
  const bar = screen.getByRole("toolbar", { name: "Canvas tools" });
  const toggle = within(bar).getByRole("button", { name: "Box select (Shift+drag)" });
  expect(toggle).toHaveAttribute("title", "Box select (Shift+drag)");
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(within(bar).getByRole("button", { name: "extra" })).toBeInTheDocument();
  act(() => toggle.click());
  expect(onSelectModeChange).toHaveBeenCalledWith(true);
  rerender(<CanvasTools selectMode onSelectModeChange={onSelectModeChange} />);
  expect(screen.getByRole("button", { name: "Box select (Shift+drag)" })).toHaveAttribute("aria-pressed", "true");
  act(() => screen.getByRole("button", { name: "Box select (Shift+drag)" }).click());
  expect(onSelectModeChange).toHaveBeenLastCalledWith(false);
});

test("Identify all is disabled while an identification run is in flight", () => {
  const nodes = [{ address: "0x" + "1".repeat(40), kind: "unknown", identified: false }] as unknown as NodeSummaryDto[];
  render(<IdentifyAllButton nodes={nodes} />);
  const button = screen.getByRole("button", { name: /Identify all \(1\)/ });
  expect(button).toBeEnabled();
  act(() => useIdentifying.setState({ running: true }));
  expect(button).toBeDisabled();
  act(() => useIdentifying.setState({ running: false }));
});
