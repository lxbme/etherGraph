import { expect, test } from "vitest";

// vitest stubs CSS imports, so read the files directly.
// @ts-expect-error node builtins are untyped here (no @types/node); the module exists at runtime.
import { readFileSync } from "node:fs";

const tokens = readFileSync("src/styles/tokens.css", "utf8") as string;
const app = readFileSync("src/styles/app.css", "utf8") as string;

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const i = css.indexOf(`${selector} {`);
  if (i < 0) throw new Error(`no rule ${selector}`);
  return css.slice(i, css.indexOf("}", i));
}
/** A token's value in the light (:root) or dark theme block. */
function token(theme: "light" | "dark", name: string): string {
  const block = rule(tokens, theme === "light" ? ":root" : ':root[data-theme="dark"]');
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
  if (!m) throw new Error(`${name} missing in ${theme}`);
  return m[1]!.trim();
}
/** Relative luminance of an rgb()/rgba() colour, 0 (black) to 1 (white). */
function luminance(c: string): number {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (!m) throw new Error(`not rgb(a): ${c}`);
  const lin = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(+m[1]!) + 0.7152 * lin(+m[2]!) + 0.0722 * lin(+m[3]!);
}

test("modal backdrops dim with a dark scrim in both themes, never a light veil", () => {
  expect(rule(app, ".dialog-backdrop")).toMatch(/background:\s*var\(--scrim\);/);
  expect(rule(app, ".drawer-backdrop")).toMatch(/background:\s*var\(--scrim-soft\);/);
  for (const theme of ["light", "dark"] as const) {
    for (const name of ["--scrim", "--scrim-soft"]) expect(luminance(token(theme, name)), `${theme} ${name}`).toBeLessThan(0.05);
  }
});
