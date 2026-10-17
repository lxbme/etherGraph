import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsMenu } from "../shell/SettingsMenu";
import { t, useLocale, useT } from "./index";

function Hello() {
  const tt = useT();
  return <p>{tt("test.hello", { name: "Ann" })}</p>;
}

beforeEach(() => {
  localStorage.clear();
  act(() => useLocale.getState().setLocale("en"));
});
afterEach(() => vi.restoreAllMocks());

describe("t()", () => {
  it("interpolates in en and zh", () => {
    expect(t("test.hello", { name: "Ann" })).toBe("Hello, Ann");
    act(() => useLocale.getState().setLocale("zh"));
    expect(t("test.hello", { name: "Ann" })).toBe("你好，Ann");
  });
  it("selects plural forms", () => {
    expect(t("test.items", { count: 1 })).toBe("1 item");
    expect(t("test.items", { count: 3 })).toBe("3 items");
  });
  it("keeps placeholders when params are missing", () => {
    expect(t("test.hello")).toBe("Hello, {name}");
  });
});

describe("persistence", () => {
  it("falls back to en when getItem throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.resetModules();
    const mod = await import("./index");
    expect(mod.useLocale.getState().locale).toBe("en");
  });
  it("setLocale survives setItem throwing", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => act(() => useLocale.getState().setLocale("zh"))).not.toThrow();
    expect(useLocale.getState().locale).toBe("zh");
  });
  it("persists to eg.locale", () => {
    act(() => useLocale.getState().setLocale("zh"));
    expect(localStorage.getItem("eg.locale")).toBe("zh");
  });
});

describe("components", () => {
  it("useT re-renders on locale change", () => {
    render(<Hello />);
    expect(screen.getByText("Hello, Ann")).toBeTruthy();
    act(() => useLocale.getState().setLocale("zh"));
    expect(screen.getByText("你好，Ann")).toBeTruthy();
  });
  it("SettingsMenu switches language and stays open", () => {
    render(<SettingsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("radio", { name: "中文" }));
    expect(useLocale.getState().locale).toBe("zh");
    expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "浅色" })).toBeTruthy();
  });
  it("closes on Escape", () => {
    render(<SettingsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
