import { describe, expect, it } from "vitest";

// vitest stubs CSS imports (even ?raw) to "", so read the files directly.
// @ts-expect-error node builtins are untyped here (no @types/node); the module exists at runtime.
import { readdirSync, readFileSync } from "node:fs";

const DIR = "src/styles/"; // vitest runs from web/
const SHEETS: Record<string, string> = Object.fromEntries(
  (readdirSync(DIR) as string[])
    .filter((f) => f.endsWith(".css"))
    .map((f) => [`./${f}`, readFileSync(DIR + f, "utf8") as string]),
);
const RESTRICTED = /^(font-size|padding(-[a-z]+)*|margin(-[a-z]+)*|gap|row-gap|column-gap|height|min-height|max-height|border-radius|line-height)$/;
/** Offsets of positioned elements: same rule, plus 50% for centring. (Widths are not linted: panel/popover widths are layout constants.) */
const OFFSETS = /^(top|right|bottom|left|inset)$/;
const KEYWORDS = new Set(["0", "auto", "100%"]);

/** A single value token is allowed if it is var(--…), 0, auto, 100%, or a calc() made only of var(), 0 / 0px and 100% with +/-. */
function tokenOk(tok: string, extra: ReadonlySet<string> = new Set()): boolean {
  if (KEYWORDS.has(tok) || extra.has(tok) || /^var\(--[\w-]+\)$/.test(tok)) return true;
  const calc = /^calc\((.*)\)$/.exec(tok);
  if (!calc) return false;
  const rest = calc[1]!.replace(/var\(--[\w-]+\)/g, "").replace(/\b0px\b|100%|[\s0+\-()]/g, "");
  return rest === "";
}
const CENTRE = new Set(["50%"]);

/** Split on top-level whitespace (not inside parentheses). */
function splitValue(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

describe("stylesheets use spacing/size tokens", () => {
  const files = Object.keys(SHEETS)
    .map((p) => p.replace("./", ""))
    .filter((f) => f !== "tokens.css");
  it("finds the stylesheets", () => {
    expect(files).toContain("app.css");
    expect(SHEETS["./app.css"]!.length).toBeGreaterThan(1000);
  });
  for (const f of files) {
    it(`${f} has no raw sizes`, () => {
      const css = SHEETS[`./${f}`]!.replace(/\/\*[\s\S]*?\*\//g, "");
      const bad: string[] = [];
      for (const m of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/g)) {
        const [, prop, raw] = m;
        const offset = OFFSETS.test(prop!);
        if (!offset && !RESTRICTED.test(prop!)) continue;
        const value = raw!.replace(/\s*!important\s*$/, "").trim();
        if (!splitValue(value).every((tok) => tokenOk(tok, offset ? CENTRE : undefined))) bad.push(`${prop}: ${value}`);
      }
      expect(bad).toEqual([]);
    });
  }
});

describe("tokens.css", () => {
  it("sets native control color-scheme per theme", () => {
    const css = SHEETS["./tokens.css"]!;
    expect(css).toMatch(/:root\s*\{\s*color-scheme:\s*light;/);
    expect(css).toMatch(/:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;/);
  });
});

/** The declarations of the first rule whose selector list contains `selector` exactly. */
function ruleBody(css: string, selector: string): string {
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(",").some((s) => s.trim() === selector)) return m[2]!;
  }
  throw new Error(`no rule for ${selector}`);
}

describe("app.css semantic colours", () => {
  const css = SHEETS["./app.css"]!;
  it.each([
    [".address-graph__status--error", "--neg"],
    [".dialog__warn", "--warn"],
  ])("%s uses %s, not a label category hue", (selector, token) => {
    const body = ruleBody(css, selector);
    expect(body).toContain(`var(${token})`);
    expect(body).not.toMatch(/--cat-/);
  });
  it.each([".txview__tag"])("%s uses the control radius", (selector) => {
    expect(ruleBody(css, selector)).toMatch(/border-radius:\s*var\(--radius\)/);
  });
});

describe("app.css layout rules", () => {
  const css = SHEETS["./app.css"]!;
  it("the graph tooltip keeps its natural width (the edge flip measures it) up to 280px", () => {
    const body = ruleBody(css, ".graph-tooltip");
    expect(body).toMatch(/(^|[\s;])width:\s*max-content/);
    expect(body).toMatch(/max-width:\s*280px/);
  });
  it("the legend is opaque: canvas content never shows through it", () => {
    expect(ruleBody(css, ".legend")).toMatch(/background:\s*var\(--bg\)\s*;/);
  });
  it("the batch bar wraps and never grows past the canvas", () => {
    const body = ruleBody(css, ".batch-bar");
    expect(body).toMatch(/flex-wrap:\s*wrap/);
    expect(body).toMatch(/max-width:\s*calc\(100%/);
    expect(body).not.toMatch(/white-space:\s*nowrap/);
  });
});
