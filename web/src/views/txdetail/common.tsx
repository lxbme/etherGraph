import { Fragment, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import type { DecodedArgDto } from "../../api/generated/DecodedArgDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import type { TxFlowDto } from "../../api/generated/TxFlowDto";
import { useGraph } from "../../graph/store";
import { t, useT } from "../../i18n";
import { CopyButton } from "../../shell/CopyButton";
import { useUi } from "../../panels/uiStore";
import { useTabs } from "../../shell/tabs";
import { toast } from "../../shell/Toasts";

/** Values longer than this are folded until expanded. */
export const LONG_VALUE = 120;
/** Hex data larger than this many bytes is folded until expanded. */
export const FOLD_BYTES = 4096;

/** The transaction tab's "Add to graph": the address becomes a center of the (hidden) address graph. */
export function addToGraph(address: string) {
  useGraph.getState().addCenter(address.toLowerCase());
  toast(t("tx.added"));
}

/**
 * Links a detail table to the tx graph: `select` picks an address as the tab's selected node (the right panel
 * follows); `rowProps(seq)` makes a row toggle the highlight of that flow's edge (clicks on buttons are ignored).
 */
export function useFlowLink(hash: string) {
  const id = hash.toLowerCase();
  const highlighted = useTabs((s) => {
    const entry = s.tabs.find((x) => x.id === id);
    return entry && "kind" in entry ? (entry.highlightedSeq ?? null) : null;
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

export function nodeOf(flow: TxFlowDto, address: string): NodeSummaryDto | undefined {
  const a = address.toLowerCase();
  return flow.nodes.find((n) => n.address.toLowerCase() === a);
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

/** An address as a button that adds it to the graph, with its name (if known) and a copy button. */
export function AddressButton({ address, node }: { address: string; node?: NodeSummaryDto }) {
  const t = useT();
  const name = node?.display_name ?? node?.contract_name ?? null;
  return (
    <span className="txdetail__addr">
      <button type="button" className="detail__link detail__mono" title={t("tx.addToGraph")} onClick={() => addToGraph(address)}>
        {address}
      </button>
      {name && <span className="detail__muted">{name}</span>}
      <CopyButton value={address} />
    </span>
  );
}

/** A decoded argument value: addresses are clickable (also inside arrays / tuples); long values fold. */
export function ArgValue({ arg, flow }: { arg: DecodedArgDto; flow: TxFlowDto }) {
  const t = useT();
  const long = arg.value.length > LONG_VALUE;
  const [open, setOpen] = useState(false);
  let body: ReactNode;
  if (long && !open) {
    body = <span className="detail__mono">{`${arg.value.slice(0, LONG_VALUE)}…`}</span>;
  } else if (arg.ty.includes("address")) {
    body = (
      <span className="detail__mono">
        {arg.value.split(ADDRESS).map((part, i) =>
          i % 2 === 1 ? <AddressButton key={i} address={part} node={nodeOf(flow, part)} /> : <Fragment key={i}>{part}</Fragment>,
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

/** Name / Type / Value table of decoded arguments. */
export function ArgsTable({ args, flow }: { args: DecodedArgDto[]; flow: TxFlowDto }) {
  const t = useT();
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
            <td className="txdetail__wrap"><ArgValue arg={a} flow={flow} /></td>
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
