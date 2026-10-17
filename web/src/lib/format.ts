const pad = (n: number) => String(n).padStart(2, "0");

/** UTC time "YYYY-MM-DD HH:mm:ss" (the display format everywhere); returns the input unchanged if unparsable. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** The same instant in local time, same format; meant for a `title` next to a formatTime() value. */
export function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}
