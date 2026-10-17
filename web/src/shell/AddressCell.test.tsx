import { fireEvent, render, screen } from "@testing-library/react";
import { useGraph } from "../graph/store";
import { AddressCell } from "./AddressCell";

const A = "0x" + "aa".repeat(20);

beforeEach(() => useGraph.getState().reset());

test("shows the short address with the full one as title, and adds it to the graph", () => {
  render(<AddressCell address={A} />);
  expect(screen.getByTitle(A)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add to graph" }));
  expect(useGraph.getState().centers).toContain(A);
});

test("prefers the node's name", () => {
  render(
    <AddressCell
      address={A}
      node={{ address: A, kind: "eoa", display_name: "Alice", ens: null, contract_name: null, labels: [], partial: false, syncing: false, synced: true, hot: false }}
    />,
  );
  expect(screen.getByText("Alice")).toHaveAttribute("title", A);
});

test("with onSelect the name is a button reporting the address; the other buttons do not select", () => {
  const onSelect = vi.fn();
  render(<AddressCell address={A} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: "0xaaaa…aaaa" }));
  expect(onSelect).toHaveBeenCalledWith(A);
  fireEvent.click(screen.getByRole("button", { name: "Add to graph" }));
  expect(onSelect).toHaveBeenCalledTimes(1);
});

test("without onSelect the name is plain text", () => {
  render(<AddressCell address={A} />);
  expect(screen.queryByRole("button", { name: "0xaaaa…aaaa" })).toBeNull();
  expect(screen.getAllByRole("button")).toHaveLength(2); // copy, add to graph
});
