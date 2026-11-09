import { describe, expect, it } from "vitest";
import { CanvasNodeType } from "@/types/canvas";
import { selectNodeRenderCallbacks } from "./canvas-node-handoff-props";

describe("node handoff render callbacks", () => {
    const panel = () => null;
    const configContent = () => null;
    const shared = { renderPanel: panel, renderNodeContent: configContent };

    it("does not pass node-dependent callbacks to ordinary closed nodes", () => {
        const first = selectNodeRenderCallbacks(shared, CanvasNodeType.Image, false);
        const updatedCallbacks = selectNodeRenderCallbacks({ renderPanel: () => "new panel", renderNodeContent: () => "new content" }, CanvasNodeType.Image, false);
        expect(first).toEqual({
            renderPanel: undefined,
            renderNodeContent: undefined,
        });
        // Parent state can replace both closures during a drag; memoized ordinary nodes still receive
        // the same callback values and therefore do not render because of those closures.
        expect(updatedCallbacks.renderPanel).toBe(first.renderPanel);
        expect(updatedCallbacks.renderNodeContent).toBe(first.renderNodeContent);
    });

    it("keeps the live panel callback only while a panel is open", () => {
        expect(selectNodeRenderCallbacks(shared, CanvasNodeType.Image, true).renderPanel).toBe(panel);
        expect(selectNodeRenderCallbacks(shared, CanvasNodeType.Image, true).renderNodeContent).toBeUndefined();
        expect(selectNodeRenderCallbacks(shared, CanvasNodeType.Image, false).renderPanel).toBeUndefined();
        const changedPanel = () => "latest panel";
        expect(selectNodeRenderCallbacks({ ...shared, renderPanel: changedPanel }, CanvasNodeType.Image, true).renderPanel).toBe(changedPanel);
    });

    it("keeps live content for Config nodes without enabling panels", () => {
        const callbacks = selectNodeRenderCallbacks(shared, CanvasNodeType.Config, false);
        expect(callbacks.renderPanel).toBeUndefined();
        expect(callbacks.renderNodeContent).toBe(configContent);
    });
});
