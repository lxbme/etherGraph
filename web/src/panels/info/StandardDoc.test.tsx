import { act, render, screen, within } from "@testing-library/react";
import { useLocale } from "../../i18n";
import { docsZh } from "../../i18n/docs.zh";
import { StandardDoc } from "./StandardDoc";

afterEach(() => act(() => useLocale.getState().setLocale("en")));

test("renders the title, the facts, the fields as a definition list, the formulas and the external link", () => {
  render(<StandardDoc id="eip-1559" />);
  expect(screen.getByRole("heading", { name: "Fee market change" })).toBeInTheDocument();
  const doc = screen.getByTestId("standard-doc");
  expect(doc).toHaveTextContent("London hard fork, 5 August 2021");
  const fields = screen.getByTestId("doc-fields");
  expect(fields.tagName).toBe("DL");
  expect(within(fields).getByText("maxFeePerGas", { selector: "dt" })).toBeInTheDocument();
  expect(within(fields).getByText("maxPriorityFeePerGas", { selector: "dt" })).toBeInTheDocument();
  expect(screen.getByText("effective gas price = min(maxFeePerGas, baseFee + maxPriorityFeePerGas)").tagName).toBe("CODE");
  const link = screen.getByRole("link", { name: /Open the specification/ });
  expect(link).toHaveAttribute("href", "https://eips.ethereum.org/EIPS/eip-1559");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
});

test("a page without formulas has no formula section", () => {
  render(<StandardDoc id="erc-721" />);
  expect(screen.getByRole("heading", { name: "Non-fungible tokens" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Formulas" })).toBeNull();
  expect(screen.getByRole("link", { name: /Open the specification/ })).toHaveAttribute("href", "https://eips.ethereum.org/EIPS/eip-721");
});

test("follows the language", () => {
  render(<StandardDoc id="native-eth" />);
  act(() => useLocale.getState().setLocale("zh"));
  expect(screen.getByRole("heading", { name: docsZh["native-eth"].title })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /打开规范/ })).toHaveAttribute("href", "https://ethereum.org/en/developers/docs/intro-to-ether/");
});
