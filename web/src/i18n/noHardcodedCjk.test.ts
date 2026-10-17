// Guards the English-first UI: user-facing copy lives in the i18n dictionaries, never inline in components.
// Excluded: the whole i18n/ directory (dictionaries and native locale names), tests, generated API types.
const sources = import.meta.glob<string>(
  ["/src/**/*.{ts,tsx}", "!/src/**/*.test.*", "!/src/i18n/**", "!/src/api/generated/**"],
  { query: "?raw", import: "default", eager: true },
);

const CJK = /[一-鿿]/;

/** Drops block and line comments, keeping line numbers intact; "://" in URLs is not a comment. */
function stripComments(src: string): string[] {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""));
  return noBlock.split("\n").map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"));
}

describe("no hard-coded CJK copy outside the dictionaries", () => {
  it("scans the source tree", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
  });

  it("finds no CJK characters in code", () => {
    const offenders: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      stripComments(src).forEach((line, i) => {
        if (CJK.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, `hard-coded CJK copy:\n${offenders.join("\n")}`).toEqual([]);
  });
});
