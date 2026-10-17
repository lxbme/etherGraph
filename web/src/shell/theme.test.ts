import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (e: { matches: boolean }) => void;

function mockMatchMedia(initialDark: boolean) {
  const listeners = new Set<Listener>();
  const mq = {
    matches: initialDark,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  };
  window.matchMedia = vi.fn().mockReturnValue(mq) as unknown as typeof window.matchMedia;
  return {
    fire(dark: boolean) {
      mq.matches = dark;
      listeners.forEach((l) => l({ matches: dark }));
    },
    count: () => listeners.size,
  };
}

async function load() {
  vi.resetModules();
  return (await import("./theme")).useTheme;
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  mockMatchMedia(false);
});

describe("useTheme", () => {
  it("defaults to light and writes data-theme", async () => {
    const useTheme = await load();
    expect(useTheme.getState().pref).toBe("light");
    expect(useTheme.getState().resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("setPref('dark') switches data-theme and persists", async () => {
    const useTheme = await load();
    useTheme.getState().setPref("dark");
    expect(useTheme.getState().resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("eg.theme")).toBe("dark");
  });

  it("restores a stored preference at init", async () => {
    localStorage.setItem("eg.theme", "dark");
    const useTheme = await load();
    expect(useTheme.getState().resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("system follows matchMedia and its change events", async () => {
    const mm = mockMatchMedia(true);
    const useTheme = await load();
    useTheme.getState().setPref("system");
    expect(useTheme.getState().resolved).toBe("dark");
    expect(mm.count()).toBe(1);
    mm.fire(false);
    expect(useTheme.getState().resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    useTheme.getState().setPref("light");
    expect(mm.count()).toBe(0);
  });

  it("falls back to light when localStorage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const useTheme = await load();
    expect(useTheme.getState().resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    useTheme.getState().setPref("dark");
    expect(useTheme.getState().resolved).toBe("dark");
  });
});
