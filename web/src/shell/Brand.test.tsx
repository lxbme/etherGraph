import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
// @ts-expect-error node builtins are untyped here (no @types/node); the module exists at runtime.
import { readFileSync } from "node:fs";
import { BrandLockup, BrandMark, MARK, RING_DASH } from "./Brand";

describe("BrandMark", () => {
  it("draws the dashed ring and the dot in currentColor", () => {
    const { container } = render(<BrandMark />);
    const [ring, dot] = container.querySelectorAll("circle");
    expect(ring!.getAttribute("r")).toBe(String(MARK.ring));
    expect(ring!.getAttribute("stroke")).toBe("currentColor");
    expect(ring!.getAttribute("stroke-dasharray")).toBe(RING_DASH.array);
    expect(dot!.getAttribute("r")).toBe(String(MARK.dot));
    expect(dot!.getAttribute("fill")).toBe("currentColor");
    expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("splits the ring into eight equal segments with a dash centred at 12 o'clock", () => {
    const [dash, gap] = RING_DASH.array.split(" ").map(Number);
    const circ = 2 * Math.PI * MARK.ring;
    // The attributes are rounded to 3 decimals; eight of them add up to within 0.01 of the circumference.
    expect(Math.abs((dash! + gap!) * MARK.dashes - circ)).toBeLessThan(0.01);
    // 12 o'clock lies 3/4 of the way round from the stroke's start; with the offset it must hit a dash's middle.
    const atTop = (circ * 0.75 + Number(RING_DASH.offset)) % (circ / MARK.dashes);
    expect(atTop).toBeCloseTo(dash! / 2, 2);
  });
});

describe("BrandLockup", () => {
  it("reads as one word", () => {
    render(<h1><BrandLockup /></h1>);
    expect(screen.getByRole("heading", { name: "etherGraph" })).toBeInTheDocument();
  });
});

describe("favicon.svg", () => {
  // vitest runs from web/; the favicon is a static file, so it repeats the geometry and must not drift.
  const svg = readFileSync("public/favicon.svg", "utf8") as string;

  it("draws the same mark as BrandMark", () => {
    expect(svg).toContain(`r="${MARK.ring}"`);
    expect(svg).toContain(`stroke-width="${MARK.stroke}"`);
    expect(svg).toContain(`stroke-dasharray="${RING_DASH.array}"`);
    expect(svg).toContain(`stroke-dashoffset="${RING_DASH.offset}"`);
    expect(svg).toContain(`r="${MARK.dot}"`);
  });

  it("uses the light accent and switches to the dark accent with the OS theme", () => {
    const tokens = readFileSync("src/styles/tokens.css", "utf8") as string;
    const light = /:root\s*\{[^}]*--accent:\s*(#[0-9a-f]{6})/i.exec(tokens)![1]!;
    const dark = /:root\[data-theme="dark"\]\s*\{[^}]*--accent:\s*(#[0-9a-f]{6})/i.exec(tokens)![1]!;
    expect(svg).toMatch(new RegExp(`\\.m\\{color:${light}\\}`, "i"));
    expect(svg).toMatch(new RegExp(`prefers-color-scheme:dark\\)\\{\\.m\\{color:${dark}\\}`, "i"));
  });
});
