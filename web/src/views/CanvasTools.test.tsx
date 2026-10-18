import { act, render, screen, within } from "@testing-library/react";
import { CanvasTools } from "./CanvasTools";

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
