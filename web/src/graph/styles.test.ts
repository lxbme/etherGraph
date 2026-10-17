import cytoscape from "cytoscape";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  NODE_SHAPE,
  assetColors,
  categoryColors,
  graphStylesheet,
  iconSvgs,
  txFlowStylesheet,
} from "./styles";

type Block = { selector: string; style: Record<string, unknown> };
const sheet = (theme: "light" | "dark" = "light") => graphStylesheet(theme) as unknown as Block[];
const styleOf = (s: Block[], selector: string) => {
  const b = s.find((x) => x.selector === selector);
  if (!b) throw new Error(`missing selector ${selector}`);
  return b.style;
};

const { tag: TAG_ICON_SVG, pin: PIN_ICON_SVG, syncing: SYNCING_ICON_SVG, partial: PARTIAL_ICON_SVG } = iconSvgs("light");

afterEach(() => {
  document.documentElement.style.removeProperty("--cat-exchange");
  document.documentElement.style.removeProperty("--accent");
});

/** Cytoscape's parsed style (untyped in the bundled typings): list properties keep one entry per image. */
type Parsed = { value: unknown; strValue: string; pfValue: unknown };
const ps = (ele: cytoscape.CollectionReturnValue, prop: string) =>
  (ele as unknown as { pstyle(p: string): Parsed }).pstyle(prop);

/** Runs a stylesheet through headless Cytoscape and fails on any style warning or error. */
function withCy(style: cytoscape.StylesheetJson, elements: cytoscape.ElementDefinition[], check: (cy: cytoscape.Core) => void) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    check(cytoscape({ headless: true, styleEnabled: true, style, elements }));
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
}

describe("graphStylesheet", () => {
  test("shapes: ellipse EOA, round-rectangle contract, hexagon unknown", () => {
    expect(NODE_SHAPE).toEqual({ eoa: "ellipse", contract: "round-rectangle", unknown: "hexagon" });
    const s = sheet();
    expect(styleOf(s, "node.kind-eoa").shape).toBe("ellipse");
    expect(styleOf(s, "node.kind-contract").shape).toBe("round-rectangle");
    expect(styleOf(s, "node.kind-unknown").shape).toBe("hexagon");
  });

  test("uncategorised nodes are a white fill with a grey stroke and Inter 12 labels on the canvas colour", () => {
    const node = styleOf(sheet(), "node");
    expect(node["background-color"]).toBe("#ffffff");
    expect(node["border-color"]).toBe("#6b7280");
    expect(node["font-size"]).toBe(12);
    expect(String(node["font-family"])).toMatch(/Inter/);
    expect(node["text-outline-color"]).toBe("#fbfcfd");
    expect(styleOf(sheet(), "edge[badge]")["text-background-color"]).toBe("#fbfcfd");
  });

  test("the +N more pill is a dashed round-rectangle on the canvas colour with a dashed thin edge, warning-free", () => {
    const more = styleOf(sheet(), "node.more");
    expect(more).toMatchObject({ shape: "round-rectangle", "background-color": "#fbfcfd", "border-style": "dashed", "font-size": 11, color: "#6b7280" });
    expect(styleOf(sheet(), "edge.more")).toMatchObject({ "line-style": "dashed", width: 1, "target-arrow-shape": "none" });
    withCy(
      sheet(),
      [
        { group: "nodes", data: { id: "a" } },
        { group: "nodes", data: { id: "more:a", label: "+12 more" }, classes: "more" },
        { group: "edges", data: { id: "e", source: "a", target: "more:a" }, classes: "more" },
      ],
      (cy) => {
        expect(ps(cy.getElementById("more:a") as never, "width").pfValue).toBeGreaterThan(40);
        expect(ps(cy.getElementById("e") as never, "line-style").strValue).toBe("dashed");
      },
    );
  });

  test("edge badges use the smallest type-scale size (11px)", () => {
    expect(styleOf(sheet(), "edge")["font-size"]).toBe(11);
  });

  test("dark and light produce different default node colours", () => {
    const light = styleOf(sheet("light"), "node");
    const dark = styleOf(sheet("dark"), "node");
    expect(dark["background-color"]).not.toBe(light["background-color"]);
    expect(dark["border-color"]).not.toBe(light["border-color"]);
    expect(dark["text-outline-color"]).toBe("#10141a");
  });

  test("the center node is an accent fill with a 3px white border and a 600 label", () => {
    const c = styleOf(sheet(), "node.center");
    expect(c["background-color"]).toBe("#1f5eff");
    expect(c["border-color"]).toBe("#ffffff");
    expect(c["border-width"]).toBe(3);
    expect(c["font-weight"]).toBe(600);
  });

  test("categories are a light tint fill with a same-hue stroke", () => {
    const s = sheet();
    const ex = styleOf(s, "node.cat-exchange");
    expect(ex["background-color"]).toBe("#dee8f7");
    expect(ex["border-color"]).toBe("#2563c9");
    const colors = categoryColors("light");
    expect(ex["background-color"]).toBe(colors.exchange.fill);
    expect(ex["border-color"]).toBe(colors.exchange.stroke);
    for (const k of ["defi", "bridge", "mixer"] as const) {
      expect(styleOf(s, `node.cat-${k}`)).toMatchObject({ "background-color": colors[k].fill, "border-color": colors[k].stroke });
    }
    expect(styleOf(s, "node.cat-scam, node.cat-sanctioned")).toMatchObject({
      "background-color": colors.scam.fill,
      "border-color": colors.scam.stroke,
    });
    expect(colors.sanctioned).toEqual(colors.scam);
    expect(colors.none).toEqual({ fill: "#ffffff", stroke: "#6b7280" });
  });

  test("dark tints blend toward the dark surface instead of white", () => {
    const d = categoryColors("dark");
    expect(d.exchange.stroke).toBe("#6ea3f0");
    expect(d.exchange.fill).not.toBe(categoryColors("light").exchange.fill);
    expect(parseInt(d.exchange.fill.slice(1, 3), 16)).toBeLessThan(0x60);
  });

  test("sync state and selection", () => {
    const s = sheet();
    expect(styleOf(s, "node.synced")["border-style"]).toBe("solid");
    expect(styleOf(s, "node.unsynced")["border-style"]).toBe("dashed");
    const sel = styleOf(s, "node.selected, node:selected");
    expect(sel["outline-color"]).toBe("#1f5eff");
    expect(sel["outline-width"]).toBe(2);
    expect(sel).not.toHaveProperty("border-color"); // the node keeps its own stroke
  });

  test("a user label is a tag icon, not a ring", () => {
    const u = styleOf(sheet(), "node.user-label");
    expect(u).toHaveProperty("background-image");
    expect(u["bounds-expansion"]).toBeGreaterThan(0);
    for (const key of Object.keys(u)) {
      expect(key).not.toMatch(/^(underlay|outline)-/);
    }
    expect(sheet().some((b) => b.selector.includes("user-label.kind-"))).toBe(false);
  });

  test("corner icons are lucide data URIs", () => {
    for (const uri of Object.values(iconSvgs("light"))) {
      expect(uri).toMatch(/^data:image\/svg\+xml,/);
      expect(uri).not.toMatch(/\s/); // Cytoscape splits multi-image lists on whitespace
    }
    expect(decodeURIComponent(TAG_ICON_SVG)).toContain("M12.586 2.586"); // lucide `tag`
    expect(decodeURIComponent(PIN_ICON_SVG)).toContain("M12 17v5"); // lucide `pin`
    expect(decodeURIComponent(SYNCING_ICON_SVG)).toContain("M12 6v6l4 2"); // lucide `clock`
    expect(decodeURIComponent(PARTIAL_ICON_SVG)).toContain("m21.73 18-8-14"); // lucide `triangle-alert`
    expect(decodeURIComponent(PARTIAL_ICON_SVG)).toContain("#e8a317"); // --warn
  });

  test("corner icons follow the theme's accent and warn tokens", () => {
    const dark = iconSvgs("dark");
    expect(decodeURIComponent(dark.tag)).toContain("#5b8cff");
    expect(decodeURIComponent(dark.syncing)).toContain("#5b8cff");
    expect(decodeURIComponent(dark.partial)).toContain("#f0b64a");
    expect(dark.tag).not.toBe(iconSvgs("light").tag);
    for (const uri of Object.values(dark)) expect(uri).not.toMatch(/\s/);
    withCy(graphStylesheet("dark"), [{ group: "nodes", data: { id: "p", text: "x" }, classes: "kind-eoa pinned" }], (cy) => {
      expect(ps(cy.getElementById("p"), "background-image").value).toEqual([dark.pin]);
    });
  });

  test("state icons sit outside the node corners: tag top-right, pin top-left, syncing bottom-right, partial bottom-left", () => {
    withCy(
      graphStylesheet("light"),
      [
        { group: "nodes", data: { id: "all", text: "x" }, classes: "kind-eoa pinned user-label partial" },
        { group: "nodes", data: { id: "sync", text: "x" }, classes: "kind-eoa syncing" },
        { group: "nodes", data: { id: "tag", text: "x" }, classes: "kind-eoa user-label" },
        { group: "nodes", data: { id: "plain", text: "x" }, classes: "kind-eoa" },
      ],
      (cy) => {
        const all = cy.getElementById("all");
        const list = (prop: string) => ps(all, prop).value as unknown[];
        expect(list("background-image")).toEqual([TAG_ICON_SVG, PIN_ICON_SVG, PARTIAL_ICON_SVG]);
        expect(list("background-position-x")).toHaveLength(3);
        expect(ps(all, "background-position-x").strValue).toBe("100% 0% 0%");
        expect(ps(all, "background-position-y").strValue).toBe("0% 0% 100%");
        expect(ps(all, "background-offset-x").pfValue).toEqual([6, -6, -6]);
        expect(ps(all, "background-offset-y").pfValue).toEqual([-6, -6, 6]);
        expect(list("background-clip")).toEqual(["none", "none", "none"]);
        expect(list("background-image-containment")).toEqual(["over", "over", "over"]);
        expect(ps(all, "background-width").pfValue).toEqual([11, 11, 11]);
        expect(ps(all, "background-height").pfValue).toEqual([11, 11, 11]);

        const sync = cy.getElementById("sync");
        expect(ps(sync, "background-image").value).toEqual([SYNCING_ICON_SVG]);
        expect(ps(sync, "background-position-x").strValue).toBe("100%");
        expect(ps(sync, "background-position-y").strValue).toBe("100%");

        expect(ps(cy.getElementById("tag"), "background-image").value).toEqual([TAG_ICON_SVG]);
        // A bottom icon pushes the label down so they do not overlap.
        expect(ps(sync, "text-margin-y").pfValue as number).toBeGreaterThan(ps(cy.getElementById("tag"), "text-margin-y").pfValue as number);
        expect(cy.getElementById("plain").style("background-image")).toBe("none");

        // Icons follow class changes (e.g. a pin toggled in place).
        cy.getElementById("tag").addClass("pinned");
        expect(ps(cy.getElementById("tag"), "background-image").value).toEqual([TAG_ICON_SVG, PIN_ICON_SVG]);
      },
    );
  });

  test("edge colours follow the asset class", () => {
    const s = sheet();
    const a = assetColors("light");
    expect(a).toEqual({ eth: "#5b5bd6", stable: "#0f9d58", erc20: "#b7791f", nft: "#6b7280", other: "#9ca3af" });
    for (const k of ["eth", "stable", "erc20", "nft", "other"] as const) {
      expect(styleOf(s, `edge.asset-${k}`)["line-color"]).toBe(a[k]);
    }
    expect(assetColors("dark").eth).toBe("#9a9aff");
    expect(styleOf(s, "edge").width).toBe("data(width)");
  });

  test("reads colors from CSS variables when they are set", () => {
    document.documentElement.style.setProperty("--cat-exchange", "#123456");
    document.documentElement.style.setProperty("--accent", "#abcdef");
    const s = sheet("dark");
    expect(styleOf(s, "node.cat-exchange")["border-color"]).toBe("#123456");
    expect(styleOf(s, "node.cat-exchange")["background-color"]).toBe(categoryColors("dark").exchange.fill);
    expect(styleOf(s, "node.selected, node:selected")["outline-color"]).toBe("#abcdef");
    expect(styleOf(s, "node.center")["background-color"]).toBe("#abcdef");
  });

  test("cytoscape accepts every property without warnings and applies the encoding", () => {
    withCy(
      graphStylesheet("light"),
      [
        { group: "nodes", data: { id: "a", text: "x\ny" }, classes: "kind-contract cat-mixer unsynced user-label" },
        { group: "nodes", data: { id: "b", text: "b" }, classes: "kind-unknown selected" },
        { group: "nodes", data: { id: "c", text: "c" }, classes: "kind-eoa cat-exchange center selected" },
        { group: "edges", data: { id: "ab", source: "a", target: "b", width: 3, badge: "×2" }, classes: "asset-erc20 highlighted" },
      ],
      (cy) => {
        const a = cy.getElementById("a");
        expect(a.style("shape")).toBe("round-rectangle");
        expect(a.style("border-style")).toBe("dashed");
        expect(a.style("background-image-containment")).toBe("over");
        expect(cy.getElementById("b").style("shape")).toBe("hexagon");
        expect(cy.getElementById("b").style("outline-width")).toBe("2px");
        const c = cy.getElementById("c");
        expect(c.style("background-color")).toBe("rgb(31,94,255)"); // center accent beats the category tint
        expect(c.style("border-width")).toBe("3px");
        expect(c.style("border-color")).toBe("rgb(255,255,255)"); // selection does not repaint the center's ring
        expect(cy.getElementById("ab").style("label")).toBe("×2");
      },
    );
  });
});

describe("txFlowStylesheet", () => {
  test.each(["light", "dark"] as const)("adds edge labels on the canvas colour and a dashed call edge (%s)", (theme) => {
    const s = txFlowStylesheet(theme) as unknown as Block[];
    expect(s.length).toBeGreaterThan(sheet(theme).length);
    expect(styleOf(s, "edge[label]")["text-background-color"]).toBe(theme === "light" ? "#fbfcfd" : "#10141a");
    const call = styleOf(s, "edge.call");
    expect(call["line-style"]).toBe("dashed");
    expect(call["line-color"]).toBe(assetColors(theme).other);
    // The method sits near the sender, in a smaller type, so it never covers the flow labels at mid-edge.
    expect(call["source-label"]).toBe("data(label)");
    expect(call.label).toBe("");
    expect(call["font-size"]).toBeLessThan(11);
    expect(call["source-text-margin-y"]).toBeLessThan(0); // above its line
  });

  test("cytoscape accepts the tx stylesheet without warnings", () => {
    withCy(
      txFlowStylesheet("dark"),
      [
        { group: "nodes", data: { id: "a", text: "a" }, classes: "kind-eoa" },
        { group: "nodes", data: { id: "b", text: "b" }, classes: "kind-contract" },
        { group: "edges", data: { id: "ab", source: "a", target: "b", width: 2, label: "1 ETH" }, classes: "asset-eth call" },
      ],
      (cy) => {
        const e = cy.getElementById("ab");
        expect(e.style("line-style")).toBe("dashed");
        expect(e.style("source-label")).toBe("1 ETH");
        expect(e.style("label")).toBe("");
      },
    );
  });
});
