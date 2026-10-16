import cytoscape from "cytoscape";
import { afterEach, describe, expect, test, vi } from "vitest";
import { graphStylesheet } from "./styles";

type Block = { selector: string; style: Record<string, unknown> };
const sheet = (theme: "light" | "dark" = "light") => graphStylesheet(theme) as Block[];
const styleOf = (s: Block[], selector: string) => {
  const b = s.find((x) => x.selector === selector);
  if (!b) throw new Error(`missing selector ${selector}`);
  return b.style;
};

afterEach(() => {
  document.documentElement.style.removeProperty("--cat-exchange");
  document.documentElement.style.removeProperty("--accent");
});

describe("graphStylesheet", () => {
  test("encodes shapes, category fills, sync borders and asset colors (hex fallbacks)", () => {
    const s = sheet();
    expect(styleOf(s, "node.kind-eoa").shape).toBe("ellipse");
    expect(styleOf(s, "node.kind-contract").shape).toBe("round-rectangle");
    expect(styleOf(s, "node.kind-unknown").shape).toBe("diamond");
    expect(styleOf(s, "node.cat-exchange")["background-color"]).toBe("#3b7dd8");
    expect(styleOf(s, "node.cat-defi")["background-color"]).toBe("#8a5cd6");
    expect(styleOf(s, "node.cat-bridge")["background-color"]).toBe("#2a9d9d");
    expect(styleOf(s, "node.cat-mixer")["background-color"]).toBe("#e06a2b");
    expect(styleOf(s, "node.cat-scam, node.cat-sanctioned")["background-color"]).toBe("#c23b3b");
    expect(styleOf(s, "node.synced")["border-style"]).toBe("solid");
    expect(styleOf(s, "node.unsynced")["border-style"]).toBe("dashed");
    expect(styleOf(s, "node.user-label")["outline-color"]).toBe("#ffffff");
    expect(styleOf(s, "node.selected, node:selected")["border-width"]).toBe(4);
    expect(styleOf(s, "edge.asset-eth")["line-color"]).toBe("#8c8cff");
    expect(styleOf(s, "edge.asset-stable")["line-color"]).toBe("#2bb673");
    expect(styleOf(s, "edge.asset-erc20")["line-color"]).toBe("#e0a030");
    expect(styleOf(s, "edge.asset-nft")["line-color"]).toBe("#999999");
    expect(styleOf(s, "edge.asset-other")["line-color"]).toBe("#999999");
    expect(styleOf(s, "edge").width).toBe("data(width)");
  });

  test.each(["light", "dark"] as const)("user-label ring has a contrasting halo (%s)", (theme) => {
    const st = styleOf(sheet(theme), "node.user-label");
    expect(st["outline-width"]).toBe(3);
    expect(st["underlay-color"]).toBe(theme === "light" ? "#2b323a" : "#98a3b0");
    // ring reaches outline-offset + outline-width = 4px past the border; the halo goes beyond it
    expect(st["underlay-padding"]).toBeGreaterThan(4);
    expect(st["underlay-opacity"]).toBeCloseTo(0.6);
  });

  test("reads colors from CSS variables when they are set", () => {
    document.documentElement.style.setProperty("--cat-exchange", "#123456");
    document.documentElement.style.setProperty("--accent", "#abcdef");
    const s = sheet("dark");
    expect(styleOf(s, "node.cat-exchange")["background-color"]).toBe("#123456");
    expect(styleOf(s, "node.selected, node:selected")["border-color"]).toBe("#abcdef");
  });

  test("cytoscape accepts every property without warnings and applies the encoding", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cy = cytoscape({
        headless: true,
        styleEnabled: true,
        style: graphStylesheet("light"),
        elements: [
          { group: "nodes", data: { id: "a", text: "x\ny" }, classes: "kind-contract cat-mixer unsynced user-label" },
          { group: "nodes", data: { id: "b", text: "b" }, classes: "kind-unknown selected" },
          { group: "edges", data: { id: "ab", source: "a", target: "b", width: 3, badge: "×2" }, classes: "asset-erc20 highlighted" },
        ],
      });
      const a = cy.getElementById("a");
      expect(a.style("shape")).toBe("round-rectangle");
      expect(a.style("border-style")).toBe("dashed");
      expect(cy.getElementById("b").style("border-width")).toBe("4px");
      expect(cy.getElementById("ab").style("label")).toBe("×2");
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
