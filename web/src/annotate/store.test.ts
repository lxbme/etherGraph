import { beforeEach, describe, expect, test } from "vitest";
import type { Annotation } from "./model";
import { useAnnotations } from "./store";

const a = (id: string, over: Partial<Annotation> = {}): Annotation => ({
  id, kind: "rect", color: "red", x1: 0, y1: 0, x2: 10, y2: 10, ...over,
});
const s = () => useAnnotations.getState();
const T = "tx:0xab:flow" as const;

beforeEach(() => s().reset());

describe("annotation store", () => {
  test("add/update/remove are single undo steps per view", () => {
    s().add("graph", a("1"));
    s().update("graph", "1", { x2: 50 });
    s().remove("graph", "1");
    expect(s().byView.graph).toEqual([]);
    s().undo("graph");
    expect(s().byView.graph).toEqual([a("1", { x2: 50 })]);
    s().undo("graph");
    expect(s().byView.graph).toEqual([a("1")]);
    s().undo("graph");
    expect(s().byView.graph).toEqual([]);
    expect(s().canUndo("graph")).toBe(false);
    expect(s().canRedo("graph")).toBe(true);
    s().redo("graph");
    expect(s().byView.graph).toEqual([a("1")]);
    s().add("graph", a("2"));
    expect(s().canRedo("graph")).toBe(false);
  });

  test("undo in one view leaves another untouched", () => {
    s().add("graph", a("1"));
    s().add(T, a("2"));
    s().undo("graph");
    expect(s().byView.graph).toEqual([]);
    expect(s().byView[T]).toEqual([a("2")]);
    expect(s().canUndo(T)).toBe(true);
  });

  test("setColor recolours the selected annotation", () => {
    s().setMode("graph");
    s().add("graph", a("1"));
    s().add("graph", a("2"));
    s().select("1");
    s().setColor("blue");
    expect(s().color).toBe("blue");
    expect(s().byView.graph!.map((x) => x.color)).toEqual(["blue", "red"]);
    s().undo("graph");
    expect(s().byView.graph!.map((x) => x.color)).toEqual(["red", "red"]);
    // Nothing selected: only the drawing colour changes, and no history is added.
    s().select(null);
    s().setColor("ink");
    expect(s().byView.graph!.map((x) => x.color)).toEqual(["red", "red"]);
  });

  test("load clears history; dropView and reset forget views", () => {
    s().add("graph", a("1"));
    s().load("graph", [a("9")]);
    expect(s().canUndo("graph")).toBe(false);
    expect(s().byView.graph).toEqual([a("9")]);
    s().add(T, a("2"));
    s().setMode(T);
    s().dropView(T);
    expect(s().byView[T]).toBeUndefined();
    expect(s().active).toBeNull();
    expect(s().canUndo(T)).toBe(false);
    s().reset();
    expect(s().byView).toEqual({});
  });

  test("setMode clears the selection and resets the tool", () => {
    s().setMode("graph");
    s().setTool("arrow");
    s().select("x");
    s().setMode("graph");
    expect(s().selected).toBeNull();
    expect(s().tool).toBe("select");
  });
});
