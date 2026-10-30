import { describe, expect, it } from "vitest";
import { enabledSkillsFirst } from "./skill-list-order";

describe("Skills settings list ordering", () => {
    it("shows enabled Skills first, preserving the existing order within each group", () => {
        const skills = [
            { id: "off-a", enabled: false },
            { id: "on-a", enabled: true },
            { id: "off-b", enabled: false },
            { id: "on-b", enabled: true },
        ];
        expect(enabledSkillsFirst(skills).map(skill => skill.id)).toEqual(["on-a", "on-b", "off-a", "off-b"]);
        expect(skills.map(skill => skill.id)).toEqual(["off-a", "on-a", "off-b", "on-b"]);
    });

    it("immediately reorders a Skill when its enabled state changes", () => {
        const initial = [{ id: "first", enabled: true }, { id: "second", enabled: false }];
        const updated = initial.map(skill => skill.id === "first" ? { ...skill, enabled: false } : { ...skill, enabled: true });
        expect(enabledSkillsFirst(updated).map(skill => skill.id)).toEqual(["second", "first"]);
    });
});
