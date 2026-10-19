import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { CallFrameDto } from "../../api/generated/CallFrameDto";
import { useT } from "../../i18n";
import { formatAmount } from "../../lib/amount";
import { ellipsize } from "../../lib/format";
import { argAmounts, type ArgAmount, type ArgToken } from "../../lib/tokenArgs";
import { flaggedLabel, trustFlag } from "../../lib/trust";
import { callName, sendsEth, type TreeRow } from "./model";

/** Every row is this tall (--h-compact in tokens.css), so the window of rows in view is plain arithmetic. */
export const ROW_HEIGHT = 28;
/** Rows rendered beyond each edge of the view. */
const OVERSCAN = 10;
/** The list's height before it is measured (and in tests without layout). */
const FALLBACK_HEIGHT = 600;
const INDENT = 16;
const ARG_MAX = 18;
const SUMMARY_MAX = 80;

/** Opcode names: the same in every language. */
export const KIND_TEXT: Record<CallFrameDto["kind"], string> = {
  call: "CALL", staticcall: "STATIC", delegatecall: "DELEGATE", callcode: "CALLCODE",
  create: "CREATE", create2: "CREATE2", selfdestruct: "SELFDESTRUCT",
};

/** A token amount in a row: four places and the symbol, `unlimited` for an unlimited allowance; a flagged token's marked. */
function shortAmount(m: ArgAmount, unlimited: string): string {
  const text = `${m.unlimited ? unlimited : formatAmount(m.raw, m.decimals, { maxFrac: 4 }).text}${m.symbol ? ` ${m.symbol}` : ""}`;
  return m.trust && trustFlag(m.trust) ? flaggedLabel(text) : text;
}

/**
 * `register(alice, 0xab…, 31536000)`: the method (or raw selector) with shortened argument values. With the `token`
 * the frame acts as, an ERC-20 amount reads `4,699.4659 USDC` (`unlimited` is the word for an unlimited allowance).
 */
export function callSummary(frame: CallFrameDto, token?: ArgToken, unlimited = "∞"): string {
  const name = callName(frame);
  if (!frame.call || frame.call.args.length === 0) return name;
  const amounts = argAmounts(frame.call.signature, frame.call.args, token);
  const values = frame.call.args.map((a, i) => {
    const m = amounts[i];
    return m ? shortAmount(m, unlimited) : ellipsize(a.value, ARG_MAX);
  });
  return ellipsize(`${name}(${values.join(", ")})`, SUMMARY_MAX);
}

/**
 * The indented call tree, windowed: only the rows in view (plus overscan) are in the DOM, so thousands of
 * frames stay responsive. A click selects a row; arrow keys move the selection (Right/Left expand/collapse);
 * a new `reveal` value scrolls the selected row into view. `tokenOf` is the ERC-20 a frame acts as, for its amounts.
 */
export function CallTreeList({
  rows,
  collapsed,
  selected,
  reveal,
  nameOf,
  tokenOf,
  onSelect,
  onToggle,
}: {
  rows: TreeRow[];
  collapsed: ReadonlySet<string>;
  selected: string | null;
  reveal: number;
  nameOf(address: string): string;
  tokenOf?(frame: CallFrameDto): ArgToken | undefined;
  onSelect(id: string, reveal?: boolean): void;
  onToggle(id: string): void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [measured, setMeasured] = useState(0);
  const height = measured || FALLBACK_HEIGHT;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setMeasured(el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const i = rows.findIndex((r) => r.id === selected);
    if (i < 0 || reveal === 0) return;
    const y = i * ROW_HEIGHT;
    if (y >= top && y + ROW_HEIGHT <= top + height) return;
    const next = Math.max(0, y - (height - ROW_HEIGHT) / 2);
    if (ref.current) ref.current.scrollTop = next;
    setTop(next);
    // Only a new request scrolls; rows changing under a scrolled list must not move it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  const onKeyDown = (e: KeyboardEvent) => {
    const i = rows.findIndex((r) => r.id === selected);
    const row = rows[i];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = rows[i < 0 ? 0 : i + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) onSelect(next.id, true);
    } else if (row?.hasChildren && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      if (collapsed.has(row.id) === (e.key === "ArrowRight")) onToggle(row.id);
    } else {
      return;
    }
    e.preventDefault();
  };

  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
  return (
    <div
      ref={ref}
      className="calltree__list"
      role="tree"
      aria-label={t("tx.view.calls")}
      tabIndex={0}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      {rows.length === 0 && <div className="placeholder">{t("tx.calls.empty")}</div>}
      <div className="calltree__spacer" style={{ height: rows.length * ROW_HEIGHT }}>
        {rows.slice(first, last).map((r, i) => {
          const f = r.frame;
          const open = r.hasChildren && !collapsed.has(r.id);
          const value = sendsEth(f) ? BigInt(f.value) : 0n;
          const isSel = r.id === selected;
          return (
            <div
              key={r.id}
              role="treeitem"
              data-frame={r.id}
              aria-level={r.depth + 1}
              aria-selected={isSel}
              aria-expanded={r.hasChildren ? open : undefined}
              className={`calltree__row${isSel ? " calltree__row--selected" : ""}${r.failed ? " calltree__row--failed" : ""}`}
              style={{ top: (first + i) * ROW_HEIGHT, paddingLeft: r.depth * INDENT }}
              onClick={() => onSelect(r.id)}
            >
              {r.hasChildren ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--icon btn--compact calltree__toggle"
                  aria-label={open ? t("tx.calls.collapse") : t("tx.calls.expand")}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(r.id);
                  }}
                >
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              ) : (
                <span className="calltree__toggle" />
              )}
              <span className="calltree__seq num">{r.seq}</span>
              <span className={`calltree__kind calltree__kind--${f.kind}`}>{KIND_TEXT[f.kind]}</span>
              <span className="calltree__callee" title={f.to ?? undefined}>{f.to ? nameOf(f.to) : "—"}</span>
              <span className="calltree__call detail__mono" title={f.call?.signature}>{callSummary(f, tokenOf?.(f), t("tx.args.unlimited"))}</span>
              {value > 0n && <span className="calltree__value num">{formatAmount(f.value, 18, { maxFrac: 4 }).text} ETH</span>}
              {r.failed && <span className="tag tag--neg calltree__failed">{t("tx.calls.failedMark")}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
