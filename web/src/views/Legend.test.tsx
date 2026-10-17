import { fireEvent, render, screen } from "@testing-library/react";
import { fullLegendGroups, legendFor } from "../graph/legend";
import { categoryColors } from "../graph/styles";
import { Legend } from "./Legend";

const KEY = "eg.legend.collapsed";
const groups = legendFor(
  [
    { group: "nodes", data: { id: "a" }, classes: "kind-eoa cat-none" },
    { group: "nodes", data: { id: "b" }, classes: "kind-eoa cat-exchange" },
    { group: "edges", data: { id: "e", source: "a", target: "b", width: 2 }, classes: "asset-eth" },
  ],
  "light",
);

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test("renders nothing without groups", () => {
  const { container } = render(<Legend groups={[]} collapsedKey={KEY} />);
  expect(container).toBeEmptyDOMElement();
});

test("lists each entry with a 16px swatch and its label", () => {
  render(<Legend groups={groups} collapsedKey={KEY} />);
  expect(screen.getByText("Legend")).toBeInTheDocument();
  expect(screen.getByText("Exchange")).toBeInTheDocument();
  expect(screen.getByText("No label")).toBeInTheDocument();
  expect(screen.getByText("Width = number of transfers (log scale)")).toBeInTheDocument();
  const swatch = screen.getByText("Exchange").closest("li")!.querySelector("svg")!;
  expect(swatch.getAttribute("width")).toBe("16");
  expect(swatch.getAttribute("height")).toBe("16");
  expect(swatch.querySelector("[fill]")!.getAttribute("fill")).toBe(categoryColors("light").exchange.fill);
});

test("collapsing hides the entries and survives a remount", () => {
  const { unmount } = render(<Legend groups={groups} collapsedKey={KEY} />);
  fireEvent.click(screen.getByRole("button", { name: "Collapse legend" }));
  expect(screen.queryByText("Exchange")).not.toBeInTheDocument();
  expect(localStorage.getItem(KEY)).toBe("1");
  unmount();
  render(<Legend groups={groups} collapsedKey={KEY} />);
  expect(screen.queryByText("Exchange")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Expand legend" }));
  expect(screen.getByText("Exchange")).toBeInTheDocument();
  expect(localStorage.getItem(KEY)).toBe("0");
});

test("legends sharing a key collapse and expand together", () => {
  render(
    <>
      <Legend groups={groups} collapsedKey={KEY} />
      <Legend groups={groups} collapsedKey={KEY} />
    </>,
  );
  expect(screen.getAllByText("Exchange")).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Collapse legend" })[0]!);
  expect(screen.queryByText("Exchange")).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Expand legend" })).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Expand legend" })[1]!);
  expect(screen.getAllByText("Exchange")).toHaveLength(2);
});

test("storage that throws leaves the legend expanded and still toggles", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  render(<Legend groups={groups} collapsedKey={KEY} />);
  expect(screen.getByText("Exchange")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Collapse legend" }));
  expect(screen.queryByText("Exchange")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Expand legend" }));
  expect(screen.getByText("Exchange")).toBeInTheDocument();
});

test("without a collapse key it renders every group inline, with no toggle", () => {
  render(<Legend groups={fullLegendGroups("light")} />);
  expect(screen.getByTestId("legend-full")).toBeInTheDocument();
  expect(screen.queryByTestId("legend")).not.toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getByText("①②③ = order of transfers")).toBeInTheDocument();
});
