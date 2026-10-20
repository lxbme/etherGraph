import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AnnotationLayer } from "./AnnotationLayer";
import type { Annotation } from "./model";
import { useAnnotations } from "./store";

type Handler = () => void;
function fakeCy() {
  const handlers = new Map<string, Set<Handler>>();
  const cy = {
    p: { x: 10, y: 20 },
    z: 2,
    pan() { return this.p; },
    zoom() { return this.z; },
    on(ev: string, h: Handler) { for (const e of ev.split(" ")) (handlers.get(e) ?? handlers.set(e, new Set()).get(e)!).add(h); },
    off(ev: string, h: Handler) { for (const e of ev.split(" ")) handlers.get(e)?.delete(h); },
  };
  return { cy, fire: (e: string) => handlers.get(e)?.forEach((h) => h()), count: () => [...handlers.values()].reduce((n, s) => n + s.size, 0) };
}
const a = (id: string, over: Partial<Annotation>): Annotation => ({ id, kind: "rect", color: "red", x1: 0, y1: 0, x2: 10, y2: 10, ...over });

beforeEach(() => useAnnotations.getState().reset());
afterEach(cleanup);

describe("AnnotationLayer", () => {
  test("the group transform follows pan and zoom and updates on viewport", () => {
    const f = fakeCy();
    const { container, unmount } = render(<AnnotationLayer view="graph" cy={f.cy as never} />);
    const g = container.querySelector("svg.annotation-layer > g")!;
    expect(g.getAttribute("transform")).toBe("translate(10 20) scale(2)");
    f.cy.p = { x: 30, y: 40 };
    f.cy.z = 0.5;
    act(() => f.fire("viewport"));
    expect(g.getAttribute("transform")).toBe("translate(30 40) scale(0.5)");
    unmount();
    expect(f.count()).toBe(0);
  });

  test("shapes use the theme tokens", () => {
    useAnnotations.getState().load("graph", [
      a("1", { kind: "rect", color: "red" }),
      a("2", { kind: "arrow", color: "blue", x2: 50 }),
      a("3", { kind: "text", color: "ink", text: "x\ny" }),
      a("4", { kind: "ellipse", color: "amber" }),
    ]);
    const { container } = render(<AnnotationLayer view="graph" cy={fakeCy().cy as never} />);
    expect(container.querySelector("rect")!.getAttribute("stroke")).toBe("var(--note-red)");
    expect(container.querySelector("ellipse")!.getAttribute("stroke")).toBe("var(--note-amber)");
    expect(container.querySelector("line")!.getAttribute("stroke")).toBe("var(--note-blue)");
    expect(container.querySelector("polygon")!.getAttribute("fill")).toBe("var(--note-blue)");
    const text = container.querySelector("text")!;
    expect(text.getAttribute("fill")).toBe("var(--note-ink)");
    expect(text.querySelectorAll("tspan")).toHaveLength(2);
    expect(text).toHaveStyle({ whiteSpace: "pre" }); // spaces kept, as the export's fillText does
    expect(container.querySelector("rect")!.getAttribute("fill")).toBe("none");
  });

  test("renders nothing but the empty group without a cy", () => {
    const { container } = render(<AnnotationLayer view="graph" cy={null} />);
    expect(container.querySelector("svg.annotation-layer")).not.toBeNull();
  });
});
