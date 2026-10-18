// svgcanvas ships no typings: a CanvasRenderingContext2D look-alike that records the drawing as SVG.
declare module "svgcanvas" {
  export interface Context extends CanvasRenderingContext2D {
    /** The drawing so far as a standalone SVG document string. */
    getSerializedSvg(fixNamedEntities?: boolean): string;
  }
  export const Context: { new (options: { width: number; height: number }): Context };
}
