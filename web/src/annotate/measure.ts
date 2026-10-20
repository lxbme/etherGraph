/** The 2D context text is measured with: created once; null where there is no canvas (jsdom). */
let ctx: CanvasRenderingContext2D | null | undefined;

/** Wide (CJK, full-width) characters: about 1em each when no canvas can measure. */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

/** The width (px) of one line of `text` in a CSS `font` of `size` px; estimated per character without a canvas. */
export function textWidth(text: string, font: string, size: number): number {
  if (ctx === undefined) {
    try {
      ctx = document.createElement("canvas").getContext("2d");
    } catch {
      ctx = null;
    }
  }
  if (ctx) {
    ctx.font = font;
    return ctx.measureText(text).width;
  }
  return [...text].reduce((w, ch) => w + (WIDE.test(ch) ? size : 0.6 * size), 0);
}
