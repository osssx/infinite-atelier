import { describe, expect, it } from "vitest";
import { buildDramaFirstFrameInput, dramaFirstFrameMissingReferenceIds } from "./drama-pipeline-media";
import type { DramaPipelineSnapshot } from "./canvas-drama-pipeline";

const snapshot: DramaPipelineSnapshot = {
    version: 1, stage: "first_frames", revision: 1, inputRevisions: {},
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
        const input = buildDramaFirstFrameInput(snapshot, shot);
        expect(input.prompt).toContain("石桥");
        expect(input.referenceImages.map(image => image.storageKey)).toEqual([
            "cas:" + "a".repeat(64), "cas:" + "b".repeat(64), "cas:" + "c".repeat(64),
        ]);
    });

    it("reports only required references without images", () => {
        const missing = structuredClone(snapshot);
        missing.references = missing.references.filter(reference => reference.assetId !== "star");
        expect(dramaFirstFrameMissingReferenceIds(missing, shot)).toEqual(["star"]);
    });

    it("passes all selected images in order and deduplicates across asset slots", () => {
        const multi = structuredClone(snapshot);
        const first = "cas:" + "a".repeat(64);
        const second = "cas:" + "d".repeat(64);
        multi.references[0].imageStorageKeys = [first, second];
        multi.references[1].imageStorageKeys = [second, "cas:" + "b".repeat(64)];
        const images = buildDramaFirstFrameInput(multi, shot).referenceImages;
        expect(images.map(image => image.storageKey)).toEqual([first, second, "cas:" + "b".repeat(64), "cas:" + "c".repeat(64)]);
        expect(new Set(images.map(image => image.id)).size).toBe(4);
        multi.references[0].imageStorageKeys = [];
        expect(dramaFirstFrameMissingReferenceIds(multi, shot)).toEqual(["hero-day"]);
    });
});
