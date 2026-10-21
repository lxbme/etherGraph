import { afterEach, expect, test } from "vitest";
import { useLocale } from "../i18n";
import { guessedName } from "./guessed";

afterEach(() => useLocale.getState().setLocale("en"));

test("a guessed name is marked in the UI language's own punctuation", () => {
  expect(guessedName("transfer", true)).toBe("transfer (Guessed)");
  expect(guessedName("transfer", false)).toBe("transfer");
  expect(guessedName("transfer", undefined)).toBe("transfer");
  useLocale.getState().setLocale("zh");
  expect(guessedName("transfer", true)).toBe("transfer（推测）");
});
