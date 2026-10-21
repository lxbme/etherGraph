import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { qk } from "../../api/queryClient";
import { useT } from "../../i18n";
import { statusName } from "../../shell/jobText";
import { useJobProgress } from "../../shell/statusStore";

const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|svg\+xml)(;base64)?,/i;

/** Dotted-quad IPv4 hosts on this machine or a private, link-local, shared or reserved network. */
function localIpv4(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Bracketed IPv6 hosts: loopback, unspecified, IPv4-mapped/compatible (`::…`), unique-local and link-local. */
function localIpv6(host: string): boolean {
  if (!host.startsWith("[")) return false;
  const ip = host.slice(1, -1);
  if (ip.startsWith("::")) return true;
  const first = parseInt(ip.split(":")[0] ?? "", 16);
  return Number.isNaN(first) || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0;
}

/** Whether `hostname` (as the URL parser normalised it) names this machine or a local network. */
function localHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || localIpv4(h) || localIpv6(h);
}

/**
 * The URL an NFT image may be loaded from, or null. Allowed: `https:`/`http:` to a public host, `ipfs://…` (through the
 * public gateway) and `data:image/(png|jpeg|gif|webp|svg+xml)` URLs. Anything else (`javascript:`, `file:`, other data
 * types, relative URLs, local or private hosts) gives null.
 */
export function safeImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (DATA_IMAGE.test(raw)) return raw;
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(raw);
  if (ipfs) {
    const u = parse(IPFS_GATEWAY + ipfs[1]);
    return u && u.origin === "https://ipfs.io" && u.pathname.startsWith("/ipfs/") ? u.href : null;
  }
  const u = parse(raw);
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:") || localHost(u.hostname)) return null;
  return u.href;
}

function parse(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/**
 * An NFT's metadata from `GET /api/token/{addr}/nft/{id}`: name, plain-text description and attributes. The image is
 * never requested until the user asks for it, and then without a referrer.
 */
export function NftPreview({ address, tokenId }: { address: string; tokenId: string }) {
  const t = useT();
  const addr = address.toLowerCase();
  const q = useQuery({ queryKey: qk.nft(addr, tokenId), queryFn: () => api.nft(addr, tokenId) });
  const jobId = q.data?.status === "pending" ? q.data.job_id : null;
  const job = useJobProgress((s) => (jobId === null ? undefined : s.byId[jobId]));
  const jobEnded = job?.status === "failed" || job?.status === "cancelled" ? job : null;
  // The token id whose image the user asked for; another id starts without one.
  const [shownFor, setShownFor] = useState<string | null>(null);

  const retry = (
    <button
      type="button"
      className="btn btn--compact"
      onClick={() => {
        if (jobEnded) useJobProgress.getState().remove([jobEnded.job_id]);
        void q.refetch();
      }}
    >
      {t("common.retry")}
    </button>
  );

  const d = q.data;
  let body: React.ReactNode;
  const failure = q.isError ? messageFor(q.error) : jobEnded ? [statusName(jobEnded.status), jobEnded.error].filter(Boolean).join(" — ") : null;
  if (failure !== null) {
    body = (
      <div className="detail__error" role="alert">
        {failure} {retry}
      </div>
    );
  } else if (!d || d.status === "pending") {
    body = <div className="detail__muted">{t("common.loading")}</div>;
  } else {
    const safe = safeImageUrl(d.image);
    const empty = !d.name && !d.description && !safe && d.attributes.length === 0;
    if (d.status === "not_found" || empty) {
      body = <div className="detail__muted">{t("info.nft.none")}</div>;
    } else {
      body = (
        <>
          {safe &&
            (shownFor === tokenId ? (
              <img className="nft__image" src={safe} alt={d.name ?? ""} referrerPolicy="no-referrer" loading="lazy" />
            ) : (
              <button type="button" className="btn btn--compact nft__load" onClick={() => setShownFor(tokenId)}>
                {t("info.nft.loadImage")}
              </button>
            ))}
          {d.name && <p className="nft__name">{d.name}</p>}
          {d.description && <p className="nft__description">{d.description}</p>}
          {d.attributes.length > 0 && (
            <>
              <h5 className="overline">{t("info.nft.attributes")}</h5>
              <dl className="kv kv--wrap" data-testid="nft-attributes">
                {d.attributes.map((a, i) => (
                  <Fragment key={i}>
                    <dt>{a.trait_type ?? "—"}</dt>
                    <dd>{a.value}</dd>
                  </Fragment>
                ))}
              </dl>
            </>
          )}
        </>
      );
    }
  }
  return (
    <section className="detail__section nft" data-testid="nft-preview">
      <h4 className="overline">{t("info.nft.title")}</h4>
      {body}
    </section>
  );
}
