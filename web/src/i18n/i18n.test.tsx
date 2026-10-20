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
  it("groups numeric params en-US style in every locale, plural from the raw number", () => {
    expect(t("test.items", { count: 1234 })).toBe("1,234 items");
    expect(t("test.hello", { name: 1234567 })).toBe("Hello, 1,234,567");
    act(() => useLocale.getState().setLocale("zh"));
    expect(t("test.hello", { name: 1234 })).toBe("你好，1,234");
  });
  it("leaves string params untouched", () => {
    expect(t("test.hello", { name: "1234" })).toBe("Hello, 1234");
  });
  it("keeps placeholders when params are missing", () => {
    expect(t("test.hello")).toBe("Hello, {name}");
  });
});

describe("document language", () => {
  it("follows the locale", () => {
    expect(document.documentElement.lang).toBe("en");
    act(() => useLocale.getState().setLocale("zh"));
    expect(document.documentElement.lang).toBe("zh-CN");
    act(() => useLocale.getState().setLocale("en"));
    expect(document.documentElement.lang).toBe("en");
  });
  it("is set from the stored locale at init", async () => {
    document.documentElement.lang = "";
    localStorage.setItem("eg.locale", "zh");
    vi.resetModules();
    await import("./index");
    expect(document.documentElement.lang).toBe("zh-CN");
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

it("partial sync has one neutral name in the tooltip, the legend and the node panel", async () => {
  const { en } = await import("./en");
  const { zh } = await import("./zh");
  for (const d of [en, zh]) {
    expect(d["tooltip.partial"]).toBe(d["legend.state.partial"]);
    expect(d["tooltip.partial"]).toBe(d["node.partialSync"]);
  }
});
