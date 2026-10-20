import type { AnnotationColor } from "./model";

type Theme = "light" | "dark";

/** Fallbacks for the --note-* tokens in styles/tokens.css (used when CSS variables are unavailable, e.g. jsdom). */
const NOTE_HEX: Record<Theme, Record<AnnotationColor, string>> = {
  light: { red: "#d93025", amber: "#b45309", blue: "#2563c9", ink: "#111827" },
  dark: { red: "#f0645a", amber: "#f0b64a", blue: "#6ea3f0", ink: "#e6e9ed" },
};

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** The concrete annotation colours for the export painter; the live overlay references the tokens directly instead. */
export function annotationColors(theme: Theme): Record<AnnotationColor, string> {
  const t = NOTE_HEX[theme];
  return {
    red: cssVar("--note-red", t.red),
    amber: cssVar("--note-amber", t.amber),
    blue: cssVar("--note-blue", t.blue),
    ink: cssVar("--note-ink", t.ink),
  };
}
