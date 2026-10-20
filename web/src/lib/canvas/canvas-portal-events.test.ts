import { afterEach, describe, expect, it, vi } from "vitest";
import { isNativeDescendantEvent } from "./canvas-portal-events";

class FakeNode extends EventTarget {}

describe("canvas portal event isolation", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("accepts native events from canvas children but rejects a portaled Skill dropdown", () => {
        vi.stubGlobal("Node", FakeNode);
        const trigger = new FakeNode();
        const dropdownItem = new FakeNode();
        const canvas = { contains: vi.fn((node: Node) => node === trigger) };
        expect(isNativeDescendantEvent(canvas as unknown as Pick<Node, "contains">, trigger)).toBe(true);
        expect(isNativeDescendantEvent(canvas as unknown as Pick<Node, "contains">, dropdownItem)).toBe(false);
        expect(canvas.contains).toHaveBeenCalledTimes(2);
    });

    it("a node capture handler likewise skips portaled items, without skipping its own Select trigger", () => {
        vi.stubGlobal("Node", FakeNode);
        const trigger = new FakeNode();
        const portaledOption = new FakeNode();
        const node = { contains: (target: Node) => target === trigger };
        expect(isNativeDescendantEvent(node as unknown as Pick<Node, "contains">, trigger)).toBe(true);
        expect(isNativeDescendantEvent(node as unknown as Pick<Node, "contains">, portaledOption)).toBe(false);
    });

    it("ignores non-DOM event targets safely", () => {
        vi.stubGlobal("Node", FakeNode);
        const canvas = { contains: vi.fn(() => true) };
        expect(isNativeDescendantEvent(canvas as unknown as Pick<Node, "contains">, null)).toBe(false);
        expect(isNativeDescendantEvent(canvas as unknown as Pick<Node, "contains">, new EventTarget())).toBe(false);
        expect(canvas.contains).not.toHaveBeenCalled();
    });
});
