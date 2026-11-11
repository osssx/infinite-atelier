// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { buildNodeGenerationContext } from "./canvas-node-generation";

const textNode: CanvasNodeData = {
    id: "text-a", type: CanvasNodeType.Text, title: "Existing prompt",
    position: { x: 0, y: 0 }, width: 300, height: 200,
    metadata: { content: "金色夕阳下的海岸" },
};
const imageNode: CanvasNodeData = {
    id: "image-b", type: CanvasNodeType.Image, title: "New image",
    position: { x: 330, y: 0 }, width: 300, height: 300, metadata: { prompt: "" },
};
const nodes = [textNode, imageNode];
const connections: CanvasConnection[] = [{
    id: "text-input", fromNodeId: textNode.id, toNodeId: imageNode.id,
}];

describe("canvas prompt-panel @ text reference generation", () => {
    it("expands the legacy chip label into actual saved text once", () => {
        const label = i18n.t("canvas.composer.resources.text", { index: 1 });
        const context = buildNodeGenerationContext(imageNode.id, nodes, connections, label);
        expect(context.prompt).toBe(textNode.metadata?.content);
        expect(context.textCount).toBe(1);
        expect(context.referenceImages).toEqual([]);
    });

    it("expands stable identity @ tokens in ordinary image generation", () => {
        const prompt = `请生成：@[node:${encodeURIComponent(textNode.id)}]`;
        const context = buildNodeGenerationContext(imageNode.id, nodes, connections, prompt);
        expect(context.prompt).toBe("请生成：金色夕阳下的海岸");
    });

    it("keeps implicit upstream prompts and avoids double-inserting used text", () => {
        const plain = buildNodeGenerationContext(imageNode.id, nodes, connections, "电影感");
        expect(plain.prompt).toBe("电影感\n\n金色夕阳下的海岸");
        const mixed = buildNodeGenerationContext(imageNode.id, nodes, connections,
            "@[node:text-a] 和 @[node:text-a]");
        expect(mixed.prompt).toBe("金色夕阳下的海岸 和 金色夕阳下的海岸");
    });

    it("can consume a text node with a saved prompt but no generated content", () => {
        const draft = { ...textNode, metadata: { prompt: "手写的固定提示词" } };
        const context = buildNodeGenerationContext(imageNode.id, [draft, imageNode], connections,
            "@[node:text-a]");
        expect(context.prompt).toBe("手写的固定提示词");
    });

    it("rejects a stale reference token instead of submitting its literal marker", () => {
        expect(() => buildNodeGenerationContext(imageNode.id, nodes, connections,
            "@[node:missing]")).toThrow("引用的画布节点已断开或不存在");
    });

    it("resolves text for the same prompt context passed to Comfy media presets", () => {
        const label = i18n.t("canvas.composer.resources.text", { index: 1 });
        const context = buildNodeGenerationContext(imageNode.id, nodes, connections,
            `电影风格，${label}`);
        expect(context.prompt).toBe("电影风格，金色夕阳下的海岸");
    });
});
