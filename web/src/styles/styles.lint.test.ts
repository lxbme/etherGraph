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
const RESTRICTED = /^(font-size|padding(-[a-z]+)*|margin(-[a-z]+)*|gap|row-gap|column-gap|height|min-height|max-height|border-radius)$/;
const KEYWORDS = new Set(["0", "auto", "100%"]);

/** A single value token is allowed if it is var(--…), 0, auto, 100%, or a calc() made only of var(), 0 and 100% with +/-. */
function tokenOk(tok: string): boolean {
  if (KEYWORDS.has(tok) || /^var\(--[\w-]+\)$/.test(tok)) return true;
  const calc = /^calc\((.*)\)$/.exec(tok);
  if (!calc) return false;
  const rest = calc[1]!.replace(/var\(--[\w-]+\)/g, "").replace(/100%|[\s0+\-()]/g, "");
  return rest === "";
}

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
        if (!RESTRICTED.test(prop!)) continue;
        const value = raw!.replace(/\s*!important\s*$/, "").trim();
        if (!splitValue(value).every(tokenOk)) bad.push(`${prop}: ${value}`);
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
