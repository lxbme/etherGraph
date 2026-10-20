import { act, fireEvent, render } from "@testing-library/react";
import { formatCombo, matchesCombo, SHORTCUTS, type Shortcut } from "./shortcuts";

vi.mock("./nodeActions", () => ({
  syncNode: vi.fn(),
  togglePin: vi.fn(),
  hideNode: vi.fn(),
  focusNode: vi.fn(),
}));

const A = "0x" + "aa".repeat(20);

/** The keydown init for a table combo, as a non-macOS keyboard would send it (Mod = Ctrl). */
function eventFor(combo: string): KeyboardEventInit {
  const parts = combo.split("+");
  const key = parts.pop()!.toLowerCase();
  return {
    key,
    shiftKey: parts.includes("Shift"),
    altKey: parts.includes("Alt"),
    ctrlKey: parts.includes("Mod") || parts.includes("Ctrl"),
  };
}

/** Renders a host of the (fresh) useShortcuts module with a node selected; returns that module graph's pieces. */
async function setup() {
  const { useShortcuts } = await import("./useShortcuts");
  const { useGraph } = await import("./store");
  const { useTabs } = await import("../shell/tabs");
  const actions = await import("./nodeActions");
  const { useBoxSelection } = await import("./boxSelection");
  useTabs.setState({ tabs: [{ id: "graph" }], active: "graph" });
  useGraph.getState().reset();
  function Host() {
    useShortcuts(() => undefined);
    return null;
  }
  render(<Host />);
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  return { useGraph, actions, useBoxSelection };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.doUnmock("./shortcuts");
  vi.restoreAllMocks();
});

test("the key bound to id 'pin' in SHORTCUTS toggles the pin of the selected node", async () => {
  const { actions } = await setup();
  const pin = SHORTCUTS.find((s) => s.id === "pin")!;
  fireEvent.keyDown(document.body, eventFor(pin.keys[0]!));
  expect(actions.togglePin).toHaveBeenCalledWith(A);
});

test("dispatch reads the table: rebinding pin to Q makes Q pin and P do nothing", async () => {
  vi.doMock("./shortcuts", async (importOriginal) => {
    const orig = await importOriginal<typeof import("./shortcuts")>();
    const table: Shortcut[] = orig.SHORTCUTS.map((s) => (s.id === "pin" ? { ...s, keys: ["Q"] } : s));
    return {
      ...orig,
      SHORTCUTS: table,
      shortcutFor: (e: KeyboardEvent) => table.find((s) => s.keys.some((k) => orig.matchesCombo(e, k))),
    };
  });
  const { actions } = await setup();
  fireEvent.keyDown(document.body, { key: "p" });
  expect(actions.togglePin).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: "q" });
  expect(actions.togglePin).toHaveBeenCalledWith(A);
});

test("every combo in the table except search (the search box's own) is handled here", async () => {
  const { useBoxSelection } = await setup();
  for (const s of SHORTCUTS) {
    if (s.id === "search") continue;
    for (const combo of s.keys) {
      if (s.id === "clearSelection") useBoxSelection.getState().set([A]); // only consumed with something to clear
      const ev = new KeyboardEvent("keydown", { ...eventFor(combo), bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      expect(ev.defaultPrevented, `${s.id}: ${combo}`).toBe(true);
    }
  }
});

describe("useShortcuts stays out of the way", () => {
  test("while typing in a field", async () => {
    const { actions } = await setup();
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      fireEvent.keyDown(input, { key: "p" });
      expect(actions.togglePin).not.toHaveBeenCalled();
    } finally {
      input.remove();
    }
  });

  test("a focused checkbox does not own the keys, a text field does", async () => {
    const { actions } = await setup();
    const box = document.createElement("input");
    box.type = "checkbox";
    document.body.appendChild(box);
    const text = document.createElement("input");
    document.body.appendChild(text);
    try {
      fireEvent.keyDown(text, { key: "p" });
      expect(actions.togglePin).not.toHaveBeenCalled();
      fireEvent.keyDown(box, { key: "p" });
      expect(actions.togglePin).toHaveBeenCalledWith(A);
    } finally {
      box.remove();
      text.remove();
    }
  });

  test("while a dialog or menu is open", async () => {
    const { actions } = await setup();
    for (const role of ["dialog", "menu"]) {
      const el = document.createElement("div");
      el.setAttribute("role", role);
      document.body.appendChild(el);
      try {
        fireEvent.keyDown(document.body, { key: "p" });
      } finally {
        el.remove();
      }
    }
    expect(actions.togglePin).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "p" });
    expect(actions.togglePin).toHaveBeenCalledWith(A);
  });

  test("while a tx tab is shown", async () => {
    const { actions, useGraph } = await setup();
    const { useTabs } = await import("../shell/tabs");
    const undo = vi.spyOn(useGraph.getState(), "undo");
    act(() => useTabs.setState({ active: "0x" + "12".repeat(32) }));
    fireEvent.keyDown(document.body, { key: "p" });
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect(actions.togglePin).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
  });

  test("on the Data tab undo and redo work and the node keys do not", async () => {
    const { actions, useGraph } = await setup();
    const { useTabs } = await import("../shell/tabs");
    const undo = vi.spyOn(useGraph.getState(), "undo");
    const redo = vi.spyOn(useGraph.getState(), "redo");
    act(() => useTabs.setState({ tabs: [{ id: "graph" }, { id: "data", kind: "data" }], active: "data" }));
    fireEvent.keyDown(document.body, { key: "p" });
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, shiftKey: true });
    expect(actions.togglePin).not.toHaveBeenCalled();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);
  });

  test("in annotate mode undo, redo and Escape are left to the annotate keys, on the Data tab too", async () => {
    const { useGraph, useBoxSelection } = await setup();
    const { useTabs } = await import("../shell/tabs");
    const { useAnnotations } = await import("../annotate/store");
    const undo = vi.spyOn(useGraph.getState(), "undo");
    const redo = vi.spyOn(useGraph.getState(), "redo");
    act(() => useBoxSelection.getState().set([A]));
    for (const active of ["graph", "data"]) {
      act(() => useTabs.setState({ tabs: [{ id: "graph" }, { id: "data", kind: "data" }], active }));
      act(() => useAnnotations.setState({ active: "graph" }));
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, shiftKey: true });
      fireEvent.keyDown(document.body, { key: "Escape" });
    }
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    expect(useBoxSelection.getState().ids).toEqual([A]);
  });

  test("while the admin page covers the graph (Save included)", async () => {
    const { actions } = await setup();
    const { useAdminRoute } = await import("../shell/hashRoute");
    const { useSaveRequest } = await import("../workspace/saveRequest");
    act(() => useAdminRoute.setState({ open: true }));
    fireEvent.keyDown(document.body, { key: "p" });
    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
    expect(actions.togglePin).not.toHaveBeenCalled();
    expect(useSaveRequest.getState().pending).toBeNull();
  });
});

describe("save shortcuts", () => {
  async function saveSetup() {
    const { useShortcuts } = await import("./useShortcuts");
    const { useSaveRequest } = await import("../workspace/saveRequest");
    const { useTabs } = await import("../shell/tabs");
    useTabs.setState({ tabs: [{ id: "graph" }], active: "graph" });
    useSaveRequest.setState({ pending: null });
    function Host() {
      useShortcuts(() => undefined);
      return null;
    }
    render(<Host />);
    return useSaveRequest;
  }
  const press = (target: Element, init: KeyboardEventInit) => {
    const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev;
  };

  test("Mod+S from a text field is taken from the browser and requests a save", async () => {
    const store = await saveSetup();
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      const ev = press(input, { key: "s", ctrlKey: true });
      expect(ev.defaultPrevented).toBe(true);
      expect(store.getState().pending?.kind).toBe("save");
    } finally {
      input.remove();
    }
  });

  test("Mod+S with a dialog open is taken from the browser but saves nothing", async () => {
    const store = await saveSetup();
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    document.body.appendChild(dlg);
    try {
      const ev = press(document.body, { key: "s", ctrlKey: true });
      expect(ev.defaultPrevented).toBe(true);
      expect(store.getState().pending).toBeNull();
    } finally {
      dlg.remove();
    }
  });

  test("Shift+Mod+S requests save-as, also on a tx tab", async () => {
    const store = await saveSetup();
    const { useTabs } = await import("../shell/tabs");
    act(() => useTabs.setState({ active: "0x" + "12".repeat(32) }));
    const ev = press(document.body, { key: "S", ctrlKey: true, shiftKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(store.getState().pending?.kind).toBe("saveAs");
  });

  test("Ctrl+Alt+S does nothing", async () => {
    const store = await saveSetup();
    const ev = press(document.body, { key: "s", ctrlKey: true, altKey: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(store.getState().pending).toBeNull();
  });
});

test("matchesCombo needs the exact modifiers; Mod accepts Ctrl or ⌘", () => {
  expect(matchesCombo({ key: "z", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, "Mod+Z")).toBe(true);
  expect(matchesCombo({ key: "z", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }, "Mod+Z")).toBe(true);
  expect(matchesCombo({ key: "Z", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, "Mod+Z")).toBe(false);
  expect(matchesCombo({ key: "Z", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, "Shift+Mod+Z")).toBe(true);
  expect(matchesCombo({ key: "y", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }, "Ctrl+Y")).toBe(false);
  expect(matchesCombo({ key: "p", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, "P")).toBe(false);
  expect(matchesCombo({ key: "p", ctrlKey: false, metaKey: false, shiftKey: false, altKey: true }, "P")).toBe(false);
});

test("formatCombo renders Mod as ⌘ on macOS and Ctrl elsewhere", () => {
  expect(formatCombo("Shift+Mod+Z", true)).toBe("Shift+⌘+Z");
  expect(formatCombo("Shift+Mod+Z", false)).toBe("Shift+Ctrl+Z");
  expect(formatCombo("Ctrl+Y", true)).toBe("Ctrl+Y");
  expect(formatCombo("P", false)).toBe("P");
});
