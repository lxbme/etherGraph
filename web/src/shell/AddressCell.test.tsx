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
