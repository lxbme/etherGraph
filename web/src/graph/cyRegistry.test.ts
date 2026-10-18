import type cytoscape from "cytoscape";
import { expect, test } from "vitest";
import { getTxCy, registerTxCy } from "./cyRegistry";

test("tx canvases are registered by hash (case-insensitively) and dropped with null", () => {
  const cy = {} as cytoscape.Core;
  expect(getTxCy("0xAB")).toBeNull();
  registerTxCy("0xAB", cy);
  expect(getTxCy("0xab")).toBe(cy);
  registerTxCy("0xab", null);
  expect(getTxCy("0xAB")).toBeNull();
});
