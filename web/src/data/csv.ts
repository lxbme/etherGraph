import type { TransferDto } from "../api/generated/TransferDto";
import { transferKey, type HiddenTransfer } from "../graph/hiddenTransfers";

const BOM = "﻿";
const HEADER = ["time_utc", "block", "tx_hash", "sub_id", "type", "from", "from_name", "to", "to_name", "symbol", "token", "amount", "amount_raw", "hidden"];

/**
 * One RFC 4180 field: quoted when it holds a comma, quote, CR or LF, with inner quotes doubled. A value a spreadsheet
 * would run as a formula (leading `=`, `+`, `-`, `@`, tab or CR; symbols and names are attacker-controlled) gets a
 * leading apostrophe first. No numeric column starts with those characters.
 */
function field(raw: string): string {
  const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[,"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** `raw` scaled by `decimals` as a full-precision decimal string (no separators, no trailing zeros); "" when decimals are unknown or raw is not an integer. BigInt only. */
export function scaledAmount(raw: string, decimals: number | null): string {
  if (decimals === null || !/^\d+$/.test(raw)) return "";
  const base = 10n ** BigInt(decimals);
  const value = BigInt(raw);
  const int = (value / base).toString();
  if (decimals === 0) return int;
  const frac = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac === "" ? int : `${int}.${frac}`;
}

/** ISO 8601 UTC with a `Z`; a timestamp already ending in `Z` is kept as is. */
function utc(ts: string): string {
  if (/Z$/.test(ts)) return ts;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString();
}

/**
 * The transfers `rows` as CSV text: a BOM, then a header row and one CRLF-ended line per transfer, in the given order.
 * `names` maps a lowercase address to its display name or first label; `hidden` marks the hidden transfers.
 */
export function transfersCsv(rows: TransferDto[], hidden: Record<string, HiddenTransfer>, names: Map<string, string>): string {
  const lines = [HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        utc(r.ts),
        String(r.block_number),
        r.tx_hash,
        r.sub_id,
        r.kind,
        r.from,
        names.get(r.from.toLowerCase()) ?? "",
        r.to,
        names.get(r.to.toLowerCase()) ?? "",
        r.symbol ?? (r.asset === null ? "ETH" : ""),
        r.asset ?? "",
        scaledAmount(r.amount, r.decimals),
        r.amount,
        transferKey(r) in hidden ? "true" : "false",
      ]
        .map(field)
        .join(","),
    );
  }
  return BOM + lines.join("\r\n") + "\r\n";
}
