import { Fragment } from "react";
import { ExternalLink } from "lucide-react";
import { type MsgKey, useLocale, useT } from "../../i18n";
import { docsEn, type DocText } from "../../i18n/docs.en";
import { docsZh } from "../../i18n/docs.zh";
import { DOC_LINKS, type DocId } from "./docs";

/** The documentation pages in the current language. */
export function useDocs(): Record<DocId, DocText> {
  return useLocale((s) => s.locale) === "zh" ? docsZh : docsEn;
}

/** Transaction types list fields, token standards their interface, ETH its key terms. */
const fieldsHeading = (id: DocId): MsgKey => (id.startsWith("erc-") ? "doc.interface" : id === "native-eth" ? "doc.terms" : "doc.fields");

/** A documentation page (the panel header shows its code): title, facts, summary, fields, formulas, where it shows up in the app, and the specification link. */
export function StandardDoc({ id }: { id: DocId }) {
  const t = useT();
  const doc = useDocs()[id];
  const titleId = `eg-doc-${id}`;
  return (
    <article className="detail__section doc" data-testid="standard-doc" aria-labelledby={titleId}>
      <h4 className="doc__title" id={titleId}>{doc.title}</h4>
      <dl className="kv kv--wrap">
        <dt>{t("doc.status")}</dt>
        <dd>{doc.status}</dd>
        <dt>{t("doc.introduced")}</dt>
        <dd>{doc.introduced}</dd>
      </dl>
      {doc.summary.map((p) => (
        <p key={p} className="doc__p">{p}</p>
      ))}
      <h5 className="doc__heading">{t(fieldsHeading(id))}</h5>
      <dl className="doc__fields" data-testid="doc-fields">
        {doc.fields.map(([name, meaning]) => (
          <Fragment key={name}>
            <dt>{name}</dt>
            <dd>{meaning}</dd>
          </Fragment>
        ))}
      </dl>
      {doc.math && (
        <>
          <h5 className="doc__heading">{t("doc.math")}</h5>
          <div className="doc__math">
            {doc.math.map((f) => (
              <code key={f}>{f}</code>
            ))}
          </div>
        </>
      )}
      <h5 className="doc__heading">{t("doc.inThisApp")}</h5>
      <ul className="doc__list">
        {doc.inThisApp.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <a className="detail__link" href={DOC_LINKS[id]} target="_blank" rel="noopener noreferrer">
        <ExternalLink size={12} aria-hidden="true" /> {t("info.openSpec")}
      </a>
    </article>
  );
}
