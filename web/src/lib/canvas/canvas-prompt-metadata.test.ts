import { describe, expect, it } from "vitest";
import { updateCanvasNodePrompt } from "./canvas-prompt-metadata";

describe("canvas prompt metadata synchronization", () => {
    it("keeps prompt and composerContent synchronized after BBox seeded both fields", () => {
        expect(updateCanvasNodePrompt({ prompt: "compiled JSON", composerContent: "compiled JSON" }, "edited JSON")).toEqual({ prompt: "edited JSON", composerContent: "edited JSON" });
        expect(updateCanvasNodePrompt({ prompt: "compiled JSON", composerContent: "compiled JSON" }, "")).toEqual({ prompt: "", composerContent: "" });
    });

    it("preserves legacy single prompt metadata shape for other nodes", () => {
        expect(updateCanvasNodePrompt({ prompt: "old" }, "new")).toEqual({ prompt: "new" });
    });
});
