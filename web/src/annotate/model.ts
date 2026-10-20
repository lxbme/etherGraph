export type AnnotationKind = "text" | "arrow" | "rect" | "ellipse";
export type AnnotationColor = "red" | "amber" | "blue" | "ink";

/** A mark drawn over a canvas, fixed in model coordinates (pan and zoom move it, node drags do not). */
export interface Annotation {
  id: string;
  kind: AnnotationKind;
  color: AnnotationColor;
  /** Model coordinates. text: anchor (x1,y1) is the top-left of the first line; arrow: tail (x1,y1) → head (x2,y2); rect/ellipse: opposite corners. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Text only; may contain "\n". */
  text?: string;
}

export const ANNOTATION_KINDS: AnnotationKind[] = ["text", "arrow", "rect", "ellipse"];
export const ANNOTATION_COLORS: AnnotationColor[] = ["red", "amber", "blue", "ink"];
export const STROKE_WIDTH = 2; // model units
export const FONT_SIZE = 14; // model units
export const LINE_HEIGHT = 1.3;
/** The page font (`--font-sans` in styles/tokens.css, keep in sync): on-screen text, its editor and the export use it. */
export const FONT_FAMILY =
  "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif";

/** The CSS `font` of annotation text at `size` px. */
export const fontOf = (size: number): string => `${size}px ${FONT_FAMILY}`;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Validation for deserialize: a known kind and colour, an id and finite coordinates (text only for strings). */
export function isAnnotation(v: unknown): v is Annotation {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    a.id !== "" &&
    typeof a.kind === "string" &&
    (ANNOTATION_KINDS as string[]).includes(a.kind) &&
    typeof a.color === "string" &&
    (ANNOTATION_COLORS as string[]).includes(a.color) &&
    isNum(a.x1) && isNum(a.y1) && isNum(a.x2) && isNum(a.y2) &&
    (a.text === undefined || typeof a.text === "string")
  );
}

/** Estimated size of a text annotation, used when the caller cannot measure it. */
function estimateText(a: Annotation): { w: number; h: number } {
  const lines = (a.text ?? "").split("\n");
  const longest = Math.max(...lines.map((l) => l.length));
  return { w: longest * FONT_SIZE * 0.6, h: lines.length * FONT_SIZE * LINE_HEIGHT };
}

/** The box spanning every annotation (null for an empty list); text takes its measured or estimated size. */
export function bounds(
  list: Annotation[],
  measure?: (a: Annotation) => { w: number; h: number },
): { x1: number; y1: number; x2: number; y2: number } | null {
  if (list.length === 0) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const a of list) {
    let ax1 = Math.min(a.x1, a.x2);
    let ay1 = Math.min(a.y1, a.y2);
    let ax2 = Math.max(a.x1, a.x2);
    let ay2 = Math.max(a.y1, a.y2);
    if (a.kind === "text") {
      const { w, h } = (measure ?? estimateText)(a);
      ax1 = a.x1;
      ay1 = a.y1;
      ax2 = a.x1 + w;
      ay2 = a.y1 + h;
    }
    x1 = Math.min(x1, ax1);
    y1 = Math.min(y1, ay1);
    x2 = Math.max(x2, ax2);
    y2 = Math.max(y2, ay2);
  }
  return { x1, y1, x2, y2 };
}

export function translate(a: Annotation, dx: number, dy: number): Annotation {
  return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
}

/** A canvas that carries annotations: the address graph, or a tx tab's flow or call graph. */
export type ViewId = "graph" | `tx:${string}:flow` | `tx:${string}:calls`;
export const txFlowView = (hash: string): ViewId => `tx:${hash.toLowerCase()}:flow`;
export const txCallsView = (hash: string): ViewId => `tx:${hash.toLowerCase()}:calls`;
