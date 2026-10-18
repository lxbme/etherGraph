import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { CATEGORIES, LabelEditor } from "./LabelEditor";

test("offers all thirteen categories in UI order", () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LabelEditor address={"0x" + "aa".repeat(20)} onClose={() => {}} />
    </QueryClientProvider>,
  );
  const options = screen.getAllByRole("option").map((o) => o.textContent);
  expect(options).toEqual([
    "CEX", "DEX", "DeFi", "Bridge", "Mixer", "Scam / phishing", "Sanctioned", "Hacker / exploiter",
    "MEV bot", "Market maker / fund", "NFT marketplace", "Staking / validator", "Other",
  ]);
  expect(CATEGORIES).toHaveLength(13);
});
