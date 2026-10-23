const pad = (n: number) => String(n).padStart(2, "0");

/** UTC time "YYYY-MM-DD HH:mm:ss UTC" (the display format everywhere); returns the input unchanged if unparsable. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

/** UTC time to the minute, "YYYY-MM-DD HH:mm" (formatTime's instant, short for narrow columns); input unchanged if unparsable. */
export function formatShortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "UTC", "UTC+8", "UTC-3:30": the browser's offset at the instant `d`. */
function localOffset(d: Date): string {
  const off = -d.getTimezoneOffset();
  if (off === 0) return "UTC";
  const abs = Math.abs(off);
  const m = abs % 60;
  return `UTC${off < 0 ? "-" : "+"}${Math.floor(abs / 60)}${m ? `:${pad(m)}` : ""}`;
}

/** The same instant in local time with its offset ("… UTC+8"); meant for a `title` next to a formatTime() value. */
export function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${localOffset(d)}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

const CIRCLED = "⓪①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

/** ⓪…⑳ for 0–20 (tx-flow sequence numbers), "(n)" beyond. */
export function circled(seq: number): string {
  return Number.isInteger(seq) && seq >= 0 && seq <= 20 ? [...CIRCLED][seq]! : `(${seq})`;
}

/** Cuts `s` to at most `max` characters, ending in "…" when it was cut. */
export function ellipsize(s: string, max: number): string {
  const cs = [...s];
  return cs.length > max ? cs.slice(0, max - 1).join("") + "…" : s;
}

/** A token id over 12 characters becomes first 6 + "…" + last 4. */
export function shortTokenId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}
