import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import type { TokenDetailDto } from "../../api/generated/TokenDetailDto";
import { qk } from "../../api/queryClient";
import { identifyAddresses, useIdentifying } from "../../graph/identify";
import { type MsgKey, useT } from "../../i18n";
import { AddressCell } from "../../shell/AddressCell";
import { CopyButton } from "../../shell/CopyButton";
import type { DocId } from "./docs";
import { useInfo } from "./infoStore";

const STANDARD_DOC: Record<string, { label: string; doc: DocId }> = {
  erc20: { label: "ERC-20", doc: "erc-20" },
  erc721: { label: "ERC-721", doc: "erc-721" },
  erc1155: { label: "ERC-1155", doc: "erc-1155" },
};

/** `bridged-token` → `Bridged token`. */
export function readableTag(slug: string): string {
  const s = slug.replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const isHttp = (u: string): boolean => /^https?:\/\//i.test(u);

function Row({ label, children }: { label: MsgKey; children: React.ReactNode }) {
  const t = useT();
  return (
    <>
      <dt>{t(label)}</dt>
      <dd>{children}</dd>
    </>
  );
}

function DocButton({ tab, doc, children }: { tab: string; doc: DocId; children: React.ReactNode }) {
  const open = useInfo((s) => s.open);
  return (
    <button type="button" className="detail__link" onClick={() => open(tab, { kind: "doc", id: doc })}>
      {children}
    </button>
  );
}

function EthDetail({ tab }: { tab: string }) {
  const t = useT();
  return (
    <div className="detail__section">
      <dl className="kv kv--wrap" data-testid="asset-kv">
        <Row label="info.asset.name">Ether</Row>
        <Row label="info.asset.symbol">ETH</Row>
        <Row label="info.asset.standard">
          <DocButton tab={tab} doc="native-eth">{t("info.standard.native")}</DocButton>
        </Row>
        <Row label="info.asset.decimals"><span className="num">18</span></Row>
      </dl>
      <p className="detail__muted">{t("info.asset.ethNote")}</p>
    </div>
  );
}

function SourceTag({ d }: { d: TokenDetailDto }) {
  const t = useT();
  const running = useIdentifying((s) => s.running);
  if (!d.identified || d.source_verified === null) {
    return (
      <>
        <span className="tag tag--neutral">{t("info.tag.notIdentified")}</span>
        <button type="button" className="btn btn--compact" disabled={running} onClick={() => void identifyAddresses([d.address])}>
          {t("info.identify")}
        </button>
      </>
    );
  }
  return d.source_verified ? (
    <span className="tag tag--ok">{t("info.tag.verified")}</span>
  ) : (
    <span className="tag tag--warn">{t("info.tag.unverified")}</span>
  );
}

function TokenDetail({ tab, address, tokenId }: { tab: string; address: string; tokenId?: string }) {
  const t = useT();
  const addr = address.toLowerCase();
  const q = useQuery({ queryKey: qk.token(addr), queryFn: () => api.token(addr) });
  if (q.isPending) return <div className="placeholder">{t("common.loading")}</div>;
  if (q.isError) {
    return (
      <div className="placeholder detail__error" role="alert">
        {messageFor(q.error)}{" "}
        <button type="button" className="btn btn--compact" onClick={() => void q.refetch()}>
          {t("common.retry")}
        </button>
      </div>
    );
  }
  const d = q.data;
  const std = STANDARD_DOC[d.standard];
  const fungible = d.standard !== "erc721" && d.standard !== "erc1155";
  const dash = <span className="detail__muted">—</span>;
  return (
    <div className="detail__section">
      <div className="detail__tags" data-testid="asset-tags">
        {d.lists.uniswap && <span className="tag tag--ok">{t("info.tag.uniswap")}</span>}
        {d.lists.coingecko && <span className="tag tag--ok">{t("info.tag.coingecko")}</span>}
        <SourceTag d={d} />
        {d.tags.map((s) => (
          <span key={s} className="tag tag--neutral">{readableTag(s)}</span>
        ))}
      </div>
      <dl className="kv kv--wrap" data-testid="asset-kv">
        <Row label="info.asset.name">{d.name ?? dash}</Row>
        <Row label="info.asset.symbol">{d.symbol ?? dash}</Row>
        <Row label="info.asset.standard">
          {std ? <DocButton tab={tab} doc={std.doc}>{std.label}</DocButton> : t("info.standard.unknown")}
        </Row>
        {fungible && d.decimals !== null && (
          <Row label="info.asset.decimals"><span className="num">{d.decimals}</span></Row>
        )}
        <Row label="info.asset.contract">
          <AddressCell address={addr} />
          <a className="detail__link" href={`https://etherscan.io/address/${addr}`} target="_blank" rel="noopener noreferrer">
            {t("info.etherscan")}
          </a>
        </Row>
        {d.contract_name && <Row label="info.asset.contractName">{d.contract_name}</Row>}
        {d.website && (
          <Row label="info.asset.website">
            {isHttp(d.website) ? (
              <a className="detail__link" href={d.website} target="_blank" rel="noopener noreferrer">{d.website}</a>
            ) : (
              d.website
            )}
          </Row>
        )}
        {tokenId && (
          <Row label="info.asset.tokenId">
            <span className="detail__mono">{tokenId}</span>
            <CopyButton value={tokenId} />
          </Row>
        )}
      </dl>
    </div>
  );
}

/** An asset in the right panel: ETH is static, a token is read from `GET /api/token/{addr}`. */
export function AssetDetail({ tab, asset, tokenId }: { tab: string; asset: string | null; tokenId?: string }) {
  return asset === null ? <EthDetail tab={tab} /> : <TokenDetail tab={tab} address={asset} tokenId={tokenId} />;
}
