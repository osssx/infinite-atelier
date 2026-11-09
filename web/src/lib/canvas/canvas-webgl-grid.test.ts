import { describe, expect, it } from "vitest";
import { parseCssGridColor } from "./canvas-webgl-grid";

describe("WebGL grid color uniforms", () => {
    it("parses rgba theme colors including their source alpha", () => {
        expect(parseCssGridColor("rgba(68,64,60,.12)")).toEqual({
            r: 68 / 255,
            g: 64 / 255,
            b: 60 / 255,
            a: 0.12,
        });
    });

    it("supports hex colors and rejects malformed channels", () => {
        expect(parseCssGridColor("#abc")).toEqual({ r: 170 / 255, g: 187 / 255, b: 204 / 255, a: 1 });
        expect(parseCssGridColor("#11223380")?.a).toBeCloseTo(128 / 255);
        expect(parseCssGridColor("rgba(.,2,3,.4)")).toBeNull();
        expect(parseCssGridColor("not-a-color")).toBeNull();
    });
});
