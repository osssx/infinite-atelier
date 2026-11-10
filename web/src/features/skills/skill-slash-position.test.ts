import { describe, expect, it } from "vitest";
import { skillSlashMenuPlacement } from "./skill-slash-position";

describe("Skill slash popup viewport placement", () => {
    const screen = { width: 1200, height: 800 };

    it("opens below a caret when there is space", () => {
        expect(skillSlashMenuPlacement({ left: 400, top: 220, bottom: 240 }, screen, 2)).toEqual({
            left: 400, width: 280, maxHeight: 224, top: 246,
        });
    });

    it("anchors a short popup's bottom directly above the caret, not a fixed 224px offset", () => {
        const one = skillSlashMenuPlacement({ left: 500, top: 750, bottom: 770 }, screen, 1);
        expect(one).toEqual({ left: 500, width: 280, maxHeight: 224, bottom: 56 });
        const three = skillSlashMenuPlacement({ left: 500, top: 750, bottom: 770 }, screen, 3);
        expect(three).toEqual({ left: 500, width: 280, maxHeight: 224, bottom: 56 });
    });

    it("does not cap a single candidate to less than its natural row height", () => {
        // The 48px row, 8px container padding, and 2px border need ~58px.
        const result = skillSlashMenuPlacement({ left: 500, top: 750, bottom: 770 }, screen, 1);
        expect(result.maxHeight).toBeGreaterThanOrEqual(58);
        expect(result.bottom).toBe(56);
    });

    it("still clips a long list to the viewport and scrolls only when necessary", () => {
        const result = skillSlashMenuPlacement({ left: 500, top: 600, bottom: 620 }, screen, 20);
        expect(result.maxHeight).toBe(224);
        expect(result.bottom).toBe(206);
    });

    it("clamps horizontal positioning without mixing device and CSS pixels", () => {
        expect(skillSlashMenuPlacement({ left: 1150, top: 300, bottom: 315 }, screen, 2).left).toBe(912);
        expect(skillSlashMenuPlacement({ left: -50, top: 300, bottom: 315 }, screen, 2).left).toBe(8);
    });

    it("limits the height when the viewport cannot fit the full list", () => {
        const result = skillSlashMenuPlacement(
            { left: 150, top: 100, bottom: 120 }, { width: 240, height: 170 }, 20,
        );
        expect(result.width).toBe(224);
        expect(result.maxHeight).toBeLessThanOrEqual(92);
        if (result.top !== undefined) {
            expect(result.top + result.maxHeight).toBeLessThanOrEqual(162);
        } else {
            expect(result.bottom).toBeGreaterThan(0);
        }
    });
});
