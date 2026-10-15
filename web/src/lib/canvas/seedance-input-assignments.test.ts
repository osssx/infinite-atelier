import { describe, expect, it } from "vitest";
import { assertSeedanceTextModeReferences, resolveSeedanceInputAssignments } from "./seedance-input-assignments";

const images = [{ id: "image-a", kind: "image" as const }, { id: "image-b", kind: "image" as const }];

describe("Seedance configuration-node inputs", () => {
    it("automatically assigns a connected image to first_frame without saved metadata", () => {
        expect(resolveSeedanceInputAssignments("first_frame", [images[0]])).toEqual([
            { id: "image-a", kind: "image", role: "first_frame" },
        ]);
    });

    it("uses deterministic first and last image frames", () => {
        expect(resolveSeedanceInputAssignments("first_last_frame", images).map(({ id, role }) => ({ id, role }))).toEqual([
            { id: "image-a", role: "first_frame" },
            { id: "image-b", role: "last_frame" },
        ]);
    });

    it("automatically assigns multi-modal references in omni mode", () => {
        expect(resolveSeedanceInputAssignments("omni_reference", [
            images[0], { id: "clip", kind: "video" }, { id: "sound", kind: "audio" },
        ]).map(({ role }) => role)).toEqual(["reference_image", "reference_video", "reference_audio"]);
    });

    it("honors saved ordering, explicit frame choices and exclusions", () => {
        const saved = [
            { ...images[1], role: "first_frame" as const },
            { ...images[0], role: undefined },
        ];
        expect(resolveSeedanceInputAssignments("first_frame", images, saved)).toEqual(saved);
        expect(resolveSeedanceInputAssignments("omni_reference", images, saved)).toEqual([
            { ...images[1], role: "reference_image" },
            { ...images[0], role: undefined },
        ]);
    });

    it("converts roles when switching from single-frame to omni mode", () => {
        expect(resolveSeedanceInputAssignments("omni_reference", [images[0]], [
            { ...images[0], role: "first_frame" },
        ])[0].role).toBe("reference_image");
    });

    it("does not silently switch connected references to text-to-video", () => {
        expect(() => assertSeedanceTextModeReferences([images[0]])).toThrow(/would be ignored/i);
        expect(() => assertSeedanceTextModeReferences([images[0]], [{ ...images[0], role: undefined }])).not.toThrow();
        expect(() => assertSeedanceTextModeReferences([])).not.toThrow();
    });

    it("ignores stale saved IDs and still assigns newly connected media", () => {
        const actual = resolveSeedanceInputAssignments("omni_reference", [images[0]], [
            { id: "disconnected", kind: "image", role: "reference_image" },
        ]);
        expect(actual).toEqual([{ ...images[0], role: "reference_image" }]);
    });
});
