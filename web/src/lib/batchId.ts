/**
 * A new expansion batch id. `crypto.randomUUID` exists only in secure contexts (https or localhost), so a
 * server reached over plain http on the LAN gets 128 random bits as hex instead; both fit the API's
 * `batch` format (1–64 characters of [A-Za-z0-9-]).
 */
export function newBatchId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
