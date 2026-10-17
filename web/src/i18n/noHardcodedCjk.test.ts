// Guards the English-first UI: user-facing copy lives in the i18n dictionaries, never inline in components.
// Excluded: the whole i18n/ directory (dictionaries and native locale names), tests, generated API types.
const sources = import.meta.glob<string>(
  ["/src/**/*.{ts,tsx}", "!/src/**/*.test.*", "!/src/i18n/**", "!/src/api/generated/**"],
  { query: "?raw", import: "default", eager: true },
);

// Ideographs, CJK punctuation and kana (U+3000–30FF), fullwidth forms (U+FF00–FFEF).
const CJK = /[\u3000-\u30ff\u4e00-\u9fff\uff00-\uffef]/;

/** Drops block and line comments, keeping line numbers intact; "://" in URLs is not a comment. */
function stripComments(src: string): string[] {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""));
  return noBlock.split("\n").map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"));
}

describe("no hard-coded CJK copy outside the dictionaries", () => {
  it("the pattern covers ideographs, CJK punctuation, kana and fullwidth forms", () => {
    for (const ch of ["中", "。", "、", "「", "カ", "ひ", "：", "（", "！"]) expect(CJK.test(ch), ch).toBe(true);
    for (const ch of ["a", "…", "—", "→", "Σ", "·"]) expect(CJK.test(ch), ch).toBe(false);
  });

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
