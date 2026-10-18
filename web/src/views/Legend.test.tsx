import { fireEvent, render, screen } from "@testing-library/react";
import { fullLegendGroups, legendFor } from "../graph/legend";
import { categoryColors, stateColors } from "../graph/styles";
import { Legend } from "./Legend";

const KEY = "eg.legend.collapsed";
const groups = legendFor(
  [
    { group: "nodes", data: { id: "a" }, classes: "kind-eoa cat-none" },
    { group: "nodes", data: { id: "b" }, classes: "kind-eoa cat-cex" },
    { group: "edges", data: { id: "e", source: "a", target: "b", width: 2 }, classes: "asset-eth" },
  ],
  "light",
);

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test("inline, renders nothing without groups", () => {
  const { container } = render(<Legend groups={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test("floating on an empty canvas: the header and one hint line, still the tour target and collapsible", () => {
  render(<Legend groups={[]} collapsedKey={KEY} />);
  const legend = screen.getByTestId("legend");
  expect(legend).toHaveAttribute("data-tour", "legend");
  expect(screen.getByText("Legend")).toBeInTheDocument();
  expect(screen.getByText("Signals appear here once the graph has nodes")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Collapse legend" }));
  expect(screen.queryByText("Signals appear here once the graph has nodes")).toBeNull();
  expect(screen.getByTestId("legend")).toBeInTheDocument();
});

test("reports the canvas width it covers from the left edge while expanded, 0 when collapsed", () => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockReturnValue(12);
  const onCover = vi.fn();
  render(<Legend groups={groups} collapsedKey={KEY} onCover={onCover} />);
  expect(onCover).toHaveBeenLastCalledWith(212);
  fireEvent.click(screen.getByRole("button", { name: "Collapse legend" }));
  expect(onCover).toHaveBeenLastCalledWith(0);
  fireEvent.click(screen.getByRole("button", { name: "Expand legend" }));
  expect(onCover).toHaveBeenLastCalledWith(212);
});

test("lists each entry with a 16px swatch and its label", () => {
  render(<Legend groups={groups} collapsedKey={KEY} />);
  expect(screen.getByText("Legend")).toBeInTheDocument();
  expect(screen.getByText("CEX")).toBeInTheDocument();
  expect(screen.getByText("No category")).toBeInTheDocument();
  expect(screen.getByText("Width = number of transfers (log scale)")).toBeInTheDocument();
  const swatch = screen.getByText("CEX").closest("li")!.querySelector("svg")!;
  expect(swatch.getAttribute("width")).toBe("16");
  expect(swatch.getAttribute("height")).toBe("16");
  expect(swatch.querySelector("[fill]")!.getAttribute("fill")).toBe(categoryColors("light").cex.fill);
});

test("collapsing hides the entries and survives a remount", () => {
  const { unmount } = render(<Legend groups={groups} collapsedKey={KEY} />);
  fireEvent.click(screen.getByRole("button", { name: "Collapse legend" }));
  expect(screen.queryByText("CEX")).not.toBeInTheDocument();
  expect(localStorage.getItem(KEY)).toBe("1");
  unmount();
  render(<Legend groups={groups} collapsedKey={KEY} />);
  expect(screen.queryByText("CEX")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Expand legend" }));
  expect(screen.getByText("CEX")).toBeInTheDocument();
  expect(localStorage.getItem(KEY)).toBe("0");
});

test("legends sharing a key collapse and expand together", () => {
  render(
    <>
      <Legend groups={groups} collapsedKey={KEY} />
      <Legend groups={groups} collapsedKey={KEY} />
    </>,
  );
  expect(screen.getAllByText("CEX")).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Collapse legend" })[0]!);
  expect(screen.queryByText("CEX")).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Expand legend" })).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Expand legend" })[1]!);
  expect(screen.getAllByText("CEX")).toHaveLength(2);
});

test("storage that throws leaves the legend expanded and still toggles", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  render(<Legend groups={groups} collapsedKey={KEY} />);
  expect(screen.getByText("CEX")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Collapse legend" }));
  expect(screen.queryByText("CEX")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Expand legend" }));
  expect(screen.getByText("CEX")).toBeInTheDocument();
});

test("without a collapse key it renders every group inline, with no toggle", () => {
  render(<Legend groups={fullLegendGroups("light")} />);
  expect(screen.getByTestId("legend-full")).toBeInTheDocument();
  expect(screen.queryByTestId("legend")).not.toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getByText("①②③ = order of transfers")).toBeInTheDocument();
});

test("the +N more swatch is a wide dashed pill with a +, outlined in the canvas pill's colour", () => {
  render(<Legend groups={fullLegendGroups("light")} />);
  const svg = screen.getByText("+N more: hidden neighbours, click to show").closest("li")!.querySelector("svg")!;
  const rect = svg.querySelector("rect")!;
  expect(Number(rect.getAttribute("width"))).toBeGreaterThan(Number(rect.getAttribute("height")));
  expect(rect.getAttribute("stroke")).toBe(stateColors("light").more.stroke);
  expect(rect.getAttribute("stroke-dasharray")).toBeTruthy();
  expect(svg.querySelector("text")?.textContent).toBe("+");
});

test("the token-contract swatch is a dotted line (round dots), the delegation swatch a dashed one", () => {
  render(<Legend groups={fullLegendGroups("light")} />);
  const line = (label: string) => screen.getByText(label).closest("li")!.querySelector("line")!;
  const dotted = line("Token contract (dotted link)");
  expect(dotted.getAttribute("stroke-linecap")).toBe("round");
  expect(dotted.getAttribute("stroke-dasharray")).toBe("0.1 3");
  expect(dotted.getAttribute("stroke-width")).toBe("1");
  expect(line("Delegation (EIP-7702)").getAttribute("stroke-dasharray")).toBe("3 2");
});
