import { act, render, screen } from "@testing-library/react";
import type { TrustDto } from "../../api/generated/TrustDto";
import { useLocale } from "../../i18n";
import { TrustBadge } from "./TrustBadge";

const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const listed: TrustDto = { level: "listed", impersonates: null, reason: null };
const unknown: TrustDto = { level: "unknown", impersonates: null, reason: null };
const suspicious: TrustDto = { level: "suspicious", impersonates: { address: USDT, symbol: "USDT", name: "Tether USD" }, reason: null };

afterEach(() => act(() => useLocale.getState().setLocale("en")));

test.each([listed, unknown])("a $level token has no badge", (trust) => {
  const { container } = render(<TrustBadge trust={trust} />);
  expect(container).toBeEmptyDOMElement();
});

test("a suspicious token is a warn tag naming the listed token it copies", () => {
  render(<TrustBadge trust={suspicious} />);
  const tag = screen.getByText("Possible impersonation");
  expect(tag).toHaveClass("tag", "tag--warn");
  expect(tag).toHaveAttribute("title", "Same name as Tether USD (0xdac1…1ec7) but not in any token list");
});

test("a scam token is a scam-hued tag explained by its reason", () => {
  const { rerender } = render(<TrustBadge trust={{ level: "scam", impersonates: null, reason: "spam-token" }} />);
  const tag = screen.getByText("Known scam");
  expect(tag).toHaveClass("tag", "tag--scam");
  expect(tag).not.toHaveClass("tag--warn");
  expect(tag).toHaveAttribute("title", "Flagged as spam by eth-labels");
  rerender(<TrustBadge trust={{ level: "scam", impersonates: null, reason: "scam-label" }} />);
  expect(screen.getByText("Known scam")).toHaveAttribute("title", "Labelled as a scam");
});

test("badges are translated", () => {
  act(() => useLocale.getState().setLocale("zh"));
  const { rerender } = render(<TrustBadge trust={suspicious} />);
  expect(screen.getByText("疑似仿冒")).toBeInTheDocument();
  rerender(<TrustBadge trust={{ level: "scam", impersonates: null, reason: "scam-label" }} />);
  expect(screen.getByText("已知诈骗")).toBeInTheDocument();
});
