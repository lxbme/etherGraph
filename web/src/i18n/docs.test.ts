import { DOC_IDS } from "../panels/info/docs";
import { docsEn, type DocText } from "./docs.en";
import { docsZh, type DocDictionary } from "./docs.zh";

// Compile-time: the zh dictionary must mirror en doc for doc and field for field (`bun run typecheck` fails otherwise).
// @ts-expect-error a doc without its summary does not compile
const missingSummary: DocDictionary["erc-20"] = { ...docsZh["erc-20"], summary: undefined };
// @ts-expect-error a field list shorter than the English one does not compile
const shortFields: DocDictionary["erc-20"] = { ...docsZh["erc-20"], fields: [["a", "b"]] };
// @ts-expect-error formulas where the English page has none do not compile
const extraMath: DocDictionary["erc-721"] = { ...docsZh["erc-721"], math: ["x"] };
// @ts-expect-error a missing doc does not compile
const missingDoc: DocDictionary = { ...docsZh, "erc-1155": undefined };
void [missingSummary, shortFields, extraMath, missingDoc];

/** Every string of a doc, paired with its path, for the emptiness check. */
function strings(doc: DocText): [string, string][] {
  const out: [string, string][] = [
    ["title", doc.title], ["code", doc.code], ["status", doc.status], ["introduced", doc.introduced],
  ];
  doc.summary.forEach((s, i) => out.push([`summary.${i}`, s]));
  doc.fields.forEach(([n, m], i) => out.push([`fields.${i}.name`, n], [`fields.${i}.meaning`, m]));
  doc.math?.forEach((s, i) => out.push([`math.${i}`, s]));
  doc.inThisApp.forEach((s, i) => out.push([`inThisApp.${i}`, s]));
  return out;
}

describe("documentation dictionaries", () => {
  it.each(DOC_IDS)("%s has the same shape in en and zh, with no empty strings", (id) => {
    const en: DocText = docsEn[id];
    const zh: DocText = docsZh[id];
    expect(zh.summary).toHaveLength(en.summary.length);
    expect(zh.fields).toHaveLength(en.fields.length);
    expect(zh.math?.length).toBe(en.math?.length);
    expect(zh.inThisApp).toHaveLength(en.inThisApp.length);
    for (const doc of [en, zh]) {
      expect(doc.summary.length).toBeGreaterThan(0);
      expect(doc.fields.length).toBeGreaterThan(0);
      expect(doc.inThisApp.length).toBeGreaterThan(0);
      for (const [path, s] of strings(doc)) expect(s.trim(), `${id}.${path}`).not.toBe("");
    }
  });

  it("covers exactly the documentation topics", () => {
    expect(Object.keys(docsEn).sort()).toEqual([...DOC_IDS].sort());
    expect(Object.keys(docsZh).sort()).toEqual([...DOC_IDS].sort());
  });
});
