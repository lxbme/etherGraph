import { t } from "../i18n";

/**
 * A call name guessed from the signature database, marked in plain text where a tag cannot go (graph edge labels and
 * tooltips): `transfer (Guessed)`. A decoded name is returned as is.
 */
export function guessedName(name: string, guessed: boolean | undefined): string {
  return guessed ? `${name} (${t("tx.guessed")})` : name;
}

/** The other candidates of a guessed call, as one line; undefined when there are none. */
export function alternativesText(alternatives: readonly string[]): string | undefined {
  return alternatives.length > 0 ? t("tx.guessedAlternatives", { list: alternatives.join(", ") }) : undefined;
}
