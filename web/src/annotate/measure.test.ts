import { textWidth } from "./measure";

// No canvas: every character is estimated, wide ones at 1em and the rest at 0.6em.
beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterAll(() => vi.restoreAllMocks());

const ch = (cp: number) => String.fromCodePoint(cp);

test("each wide range's first and last character is estimated at 1em", () => {
  const ends = [
    0x1100, 0x115f, // Hangul Jamo leading consonants
    0x2e80, 0xa4cf, // CJK radicals through Yi
    0xac00, 0xd7a3, // Hangul syllables
    0xf900, 0xfaff, // CJK compatibility ideographs
    0xfe30, 0xfe4f, // CJK compatibility forms
    0xff00, 0xff60, // fullwidth forms
    0xffe0, 0xffe6, // fullwidth signs
  ];
  for (const cp of ends) expect(textWidth(ch(cp), "10px sans-serif", 10), cp.toString(16)).toBe(10);
});

test("characters just outside the wide ranges are estimated at 0.6em", () => {
  for (const cp of [0x10ff, 0x1160, 0x2e7f, 0xa4d0, 0xabff, 0xd7a4, 0xf8ff, 0xfb00, 0xfe2f, 0xfe50, 0xff61, 0xffe7, 0x61]) {
    expect(textWidth(ch(cp), "10px sans-serif", 10), cp.toString(16)).toBe(6);
  }
});

test("a mixed line adds up per character", () => {
  expect(textWidth(`ab${ch(0x4e2d)}${ch(0x6587)}`, "10px sans-serif", 10)).toBeCloseTo(2 * 6 + 2 * 10);
});
