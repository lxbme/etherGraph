const pad = (n: number) => String(n).padStart(2, "0");

/** Local time "YYYY-MM-DD HH:mm"; returns the input unchanged if unparsable. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}
