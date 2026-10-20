import { Fragment, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import type { DecodedArgDto } from "../../api/generated/DecodedArgDto";
import type { FlowDto } from "../../api/generated/FlowDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import { useT } from "../../i18n";
import { formatFull } from "../../lib/amount";
import { argAmounts, type ArgAmount, type ArgToken } from "../../lib/tokenArgs";
import { trustFlag, trustReason, trustText } from "../../lib/trust";
import { useUi } from "../../panels/uiStore";
import { AddressCell } from "../../shell/AddressCell";
import { CopyButton } from "../../shell/CopyButton";
import { useTabs } from "../../shell/tabs";

/** Values longer than this are folded until expanded. */
export const LONG_VALUE = 120;
/** Hex data larger than this many bytes is folded until expanded. */
export const FOLD_BYTES = 4096;

/**
 * Links a detail table to the tx graph: `select` picks an address as the tab's selected node (the right panel
 * follows); `rowProps(seq)` makes a row toggle the highlight of that flow's edge (clicks on buttons are ignored).
 */
export function useFlowLink(hash: string) {
  const id = hash.toLowerCase();
  const highlighted = useTabs((s) => {
    const entry = s.tabs.find((x) => x.id === id);
    return entry?.kind === "tx" ? (entry.highlightedSeq ?? null) : null;
  });
  const select = (address: string) => useUi.getState().selectTx(id, address);
  const rowProps = (seq: number) => ({
    className: highlighted === seq ? "txdetail__row txdetail__row--active" : "txdetail__row",
    onClick: (e: MouseEvent) => {
      if ((e.target as Element).closest("button")) return;
      useTabs.getState().setHighlightedSeq(id, highlighted === seq ? null : seq);
    },
  });
  return { select, rowProps };
}

/**
 * What address cells need from a transaction: its hash (to select in its tab) and the nodes that name addresses;
 * its flows, where known, say how far each moved token is trusted.
 */
export type FlowNodes = { tx: { hash: string }; nodes: NodeSummaryDto[]; flows?: readonly FlowDto[] };

export function nodeOf(flow: FlowNodes, address: string): NodeSummaryDto | undefined {
  const a = address.toLowerCase();
  return flow.nodes.find((n) => n.address.toLowerCase() === a);
}

/**
 * The ERC-20 token at `address`, whose amounts its calls and events carry: its node's token, else (no node, or a file
 * saved before nodes said) its ERC-20 transfers in this tx. Its trust comes from this tx's transfers of it, so a token
 * that did not move here has none. Undefined when `address` is no known ERC-20.
 */
export function erc20Of(flow: FlowNodes, address: string | null): ArgToken | undefined {
  if (!address) return undefined;
  const a = address.toLowerCase();
  const moved = flow.flows?.filter((f) => f.asset?.toLowerCase() === a) ?? [];
  const token = nodeOf(flow, a)?.token;
  const known = token === undefined ? moved.find((f) => f.kind === "erc20") : token?.standard === "erc20" ? token : undefined;
  return known && { decimals: known.decimals, symbol: known.symbol, trust: moved[0]?.trust };
}

/** Byte length of `0x` hex data. */
export function hexBytes(hex: string): number {
  return Math.floor(Math.max(hex.length - 2, 0) / 2);
}

/** `0x` hex in 64-character lines; with `selector`, the 4-byte selector gets a line of its own so arguments line up. */
export function hexLines(hex: string, selector: boolean): string[] {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out: string[] = [];
  let rest = body;
  if (selector && body.length >= 8) {
    out.push(body.slice(0, 8));
    rest = body.slice(8);
  }
  for (let i = 0; i < rest.length; i += 64) out.push(rest.slice(i, i + 64));
  if (out.length === 0) out.push("");
  out[0] = `0x${out[0]}`;
  return out;
}

const ADDRESS = /(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/;

/**
 * A token amount: every fraction digit and the symbol, the raw integer beside it; the uint256 max of an allowance reads
 * "Unlimited" (raw in its title). A flagged token's amount is muted and marked: its decimals and symbol are its own claim.
 */
function TokenAmount({ amount: m }: { amount: ArgAmount }) {
  const t = useT();
  const flag = m.trust ? trustFlag(m.trust) : null;
  return (
    <span className={flag ? "txdetail__amount detail__muted" : "txdetail__amount"}>
      {m.unlimited ? <span title={m.raw}>{t("tx.args.unlimited")}</span> : <span className="num">{formatFull(m.raw, m.decimals)}</span>}
      {m.symbol && ` ${m.symbol}`}
      {flag && m.trust && (
        <>
          {" "}
          <span
            className={flag === "scam" ? "tag tag--scam" : "tag tag--warn"}
            title={t("tx.args.claimed", { reason: trustReason(m.trust, t) ?? "" })}
          >
            {trustText(flag, t)}
          </span>
        </>
      )}
      {!m.unlimited && (
        <>
          {" "}
          <span className="detail__mono detail__muted">{m.raw}</span>
        </>
      )}
    </span>
  );
}

/**
 * A decoded argument value; long values fold. Addresses (also inside arrays / tuples) are address cells: the text
 * selects the node in the tx graph, "+" adds it to the address graph. With `amount`, it is a token amount.
 */
export function ArgValue({ arg, flow, amount }: { arg: DecodedArgDto; flow: FlowNodes; amount?: ArgAmount | null }) {
  const t = useT();
  const { select } = useFlowLink(flow.tx.hash);
  const long = arg.value.length > LONG_VALUE;
  const [open, setOpen] = useState(false);
  if (amount) return <TokenAmount amount={amount} />;
  let body: ReactNode;
  if (long && !open) {
    body = <span className="detail__mono">{`${arg.value.slice(0, LONG_VALUE)}…`}</span>;
  } else if (arg.ty.includes("address")) {
    body = (
      <span className="detail__mono">
        {arg.value.split(ADDRESS).map((part, i) =>
          i % 2 === 1 ? (
            <AddressCell key={i} address={part} node={nodeOf(flow, part)} onSelect={select} />
          ) : (
            <Fragment key={i}>{part}</Fragment>
          ),
        )}
      </span>
    );
  } else {
    body = <span className="detail__mono">{arg.value}</span>;
  }
  return (
    <>
      {body}
      {long && (
        <button type="button" className="btn btn--ghost btn--compact" onClick={() => setOpen(!open)}>
          {open ? t("tx.input.showLess") : t("tx.input.showMore")}
        </button>
      )}
    </>
  );
}

/**
 * Name / Type / Value table of decoded arguments. With the call's or event's canonical `signature` and the `token`
 * (from `erc20Of`) of its callee or emitter, the amount of a standard ERC-20 function or event reads in its decimals.
 */
export function ArgsTable({
  args,
  flow,
  signature,
  token,
}: {
  args: DecodedArgDto[];
  flow: FlowNodes;
  signature?: string;
  token?: ArgToken;
}) {
  const t = useT();
  const amounts = signature ? argAmounts(signature, args, token) : [];
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{t("tx.col.name")}</th>
          <th>{t("tx.col.type")}</th>
          <th>{t("tx.col.argValue")}</th>
        </tr>
      </thead>
      <tbody>
        {args.map((a, i) => (
          <tr key={i}>
            <td>{a.name || `#${i}`}</td>
            <td className="detail__mono detail__muted">{a.ty}</td>
            <td className="txdetail__wrap"><ArgValue arg={a} flow={flow} amount={amounts[i]} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Monospace hex in 64-character lines with a copy button; data over FOLD_BYTES starts folded, showing its size. */
export function RawHex({ hex, selector }: { hex: string; selector: boolean }) {
  const t = useT();
  const bytes = hexBytes(hex);
  const large = bytes > FOLD_BYTES;
  const [open, setOpen] = useState(!large);
  const text = useMemo(() => (open ? hexLines(hex, selector).join("\n") : ""), [open, hex, selector]);
  return (
    <div className="txdetail__hex">
      <div className="txdetail__hexbar">
        {large && <span className="detail__muted">{t("tx.input.bytes", { count: bytes })}</span>}
        {large && (
          <button type="button" className="btn btn--compact" onClick={() => setOpen(!open)}>
            {open ? t("tx.input.hide") : t("tx.input.show")}
          </button>
        )}
        <CopyButton value={hex} />
      </div>
      {open && <pre className="txdetail__pre">{text}</pre>}
    </div>
  );
}
