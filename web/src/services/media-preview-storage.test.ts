import { describe, expect, it } from "vitest";
import { isPreviewGenerationSuspended, setPreviewGenerationSuspended } from "./media-preview-storage";

describe("backend CAS media previews", () => {
    it("keeps preview decoding suspended until all overlapping gestures end", () => {
        setPreviewGenerationSuspended(true, "wheel");
        setPreviewGenerationSuspended(true, "pan");
        setPreviewGenerationSuspended(true, "canvas-edit");
        expect(isPreviewGenerationSuspended()).toBe(true);
        setPreviewGenerationSuspended(false, "wheel");
        expect(isPreviewGenerationSuspended()).toBe(true);
        setPreviewGenerationSuspended(false, "pan");
        expect(isPreviewGenerationSuspended()).toBe(true);
        setPreviewGenerationSuspended(false, "canvas-edit");
        expect(isPreviewGenerationSuspended()).toBe(false);
    });
});
