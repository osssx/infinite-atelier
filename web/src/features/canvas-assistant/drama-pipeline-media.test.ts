// @vitest-environment happy-dom
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { buildDramaVideoConfigGraph } from "./drama-video-config";
import { createCanvasNode } from "@/lib/canvas/canvas-node-factory";
import { describe, expect, it } from "vitest";
import { buildDramaVideoInput, dramaVideoMissingReferenceIds } from "./drama-pipeline-media";
import type { DramaPipelineSnapshot } from "./canvas-drama-pipeline";

const snapshot: DramaPipelineSnapshot = {
    version: 1, stage: "storyboard", revision: 1, inputRevisions: {},
    assets: [
        { id: "hero", kind: "character", name: "主角", description: "角色", sourceRefs: [], variants: [{ id: "hero-day", name: "日常", description: "蓝衣" }] },
        { id: "bridge", kind: "scene", name: "石桥", description: "雨桥", sourceRefs: [], variants: [{ id: "bridge-rain", name: "暴雨", description: "雨天" }] },
        { id: "star", kind: "prop", name: "星星", description: "道具", sourceRefs: [] },
    ],
    references: [
        { assetId: "hero", variantId: "hero-day", imageStorageKey: "cas:" + "a".repeat(64), requiredForRendering: true },
        { assetId: "bridge", variantId: "bridge-rain", imageStorageKey: "cas:" + "b".repeat(64), requiredForRendering: true },
        { assetId: "star", imageStorageKey: "cas:" + "c".repeat(64), requiredForRendering: true },
    ],
    shots: [],
};
const shot = { id: "shot-1", episodeId: "ep-1", order: 0, description: "主角在石桥举起星星", characterVariantIds: ["hero-day"], sceneId: "bridge", sceneVariantId: "bridge-rain", propIds: ["star"], keyPropIds: ["star"] };

describe("drama pipeline media inputs", () => {
    it("maps selected character, scene variant and key prop CAS images", () => {
        const input = buildDramaVideoInput(snapshot, shot);
        expect(input.prompt).toContain("石桥");
        expect(input.referenceImages.map(image => image.storageKey)).toEqual([
            "cas:" + "a".repeat(64), "cas:" + "b".repeat(64), "cas:" + "c".repeat(64),
        ]);
    });

    it("reports only required references without images", () => {
        const missing = structuredClone(snapshot);
        missing.references = missing.references.filter(reference => reference.assetId !== "star");
        expect(dramaVideoMissingReferenceIds(missing, shot)).toEqual(["star"]);
    });

    it("passes all selected images in order and deduplicates across asset slots", () => {
        const multi = structuredClone(snapshot);
        const first = "cas:" + "a".repeat(64);
        const second = "cas:" + "d".repeat(64);
        multi.references[0].imageStorageKeys = [first, second];
        multi.references[1].imageStorageKeys = [second, "cas:" + "b".repeat(64)];
        const images = buildDramaVideoInput(multi, shot).referenceImages;
        expect(images.map(image => image.storageKey)).toEqual([first, second, "cas:" + "b".repeat(64), "cas:" + "c".repeat(64)]);
        expect(new Set(images.map(image => image.id)).size).toBe(4);
        multi.references[0].imageStorageKeys = [];
        expect(dramaVideoMissingReferenceIds(multi, shot)).toEqual(["hero-day"]);
    });
});

it("creates editable video configs with real generation inputs and skips existing configs", () => {
    const source = createCanvasNode("drama:storyboard", { x:0, y:0 });
    const input = buildDramaVideoInput(snapshot, { ...shot, camera:"缓慢推近", dialogue:"看那边" });
    const plain = buildDramaVideoInput({ ...snapshot, references:[] }, { ...shot, id:"another" });
    const partial = buildDramaVideoInput({ ...snapshot, references:snapshot.references.slice(0, 1) }, { ...shot, id:"partial" });
    const graph = buildDramaVideoConfigGraph(source, [input, plain, partial], [source], [], "写实", "9:16");
    expect(graph.configIds).toHaveLength(3);
    const first = graph.nodes.find(node => node.id === graph.configIds[0])!;
    const second = graph.nodes.find(node => node.id === graph.configIds[1])!;
    expect(first.metadata).toMatchObject({ generationMode:"video", videoMode:"omni_reference", videoRatio:"9:16" });
    expect(second.metadata?.videoMode).toBe("text_to_video");
    const third = graph.nodes.find(node => node.id === graph.configIds[2])!;
    expect(third.metadata?.videoMode).toBe("omni_reference");
    expect(buildNodeGenerationContext(third.id, graph.nodes, graph.connections, third.metadata!.composerContent!).referenceImages).toHaveLength(1);
    const context = buildNodeGenerationContext(first.id, graph.nodes, graph.connections, first.metadata!.composerContent!);
    expect(context.referenceImages.map(image => image.storageKey)).toEqual(input.referenceImages.map(image => image.storageKey));
    expect(context.prompt).toContain("缓慢推近");
    expect(context.prompt).toContain("看那边");
    expect(context.prompt).toContain("写实");
    const edited = graph.nodes.map(node => node.id === first.id
        ? { ...node, metadata:{ ...node.metadata, composerContent:"用户修改" } } : node);
    const retry = buildDramaVideoConfigGraph(source, [input, plain, partial], edited, graph.connections);
    expect(retry.configIds).toEqual([]);
    expect(retry.nodes).toEqual(edited);
});
