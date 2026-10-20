import { describe, expect, it } from "vitest";
import { activeSkillSlash, extractSkillMentions, resolvePromptSkillBinding, showLegacySkillMentions, skillMentionToken } from "./skill-mentions";

describe("inline slash Skill references", () => {
    it("recognizes slash commands at word boundaries without taking over @ or URLs", () => {
        expect(activeSkillSlash("/")).toBe("");
        expect(activeSkillSlash("Write /story")).toBe("story");
        expect(activeSkillSlash("Write\n/lighting")).toBe("lighting");
        expect(activeSkillSlash("see https://example.com/")).toBeNull();
        expect(activeSkillSlash("ratio 16/9")).toBeNull();
        expect(activeSkillSlash("@image")).toBeNull();
        expect(activeSkillSlash("type /skill next")).toBeNull();
    });

    it("encodes a valid Skill and strips its opaque marker before model requests", () => {
        const token = skillMentionToken("storyboard-prompt");
        expect(token).toBe("/[skill:storyboard-prompt]");
        expect(() => skillMentionToken("../bad")).toThrow(/Invalid/);
        const prompt = "Please use " + token + " on @[node:image-a] then /[skill:lighting] with /[skill:storyboard-prompt].";
        const result = extractSkillMentions(prompt);
        expect(result.skillIds).toEqual(["storyboard-prompt", "lighting"]);
        expect(result.text).toContain("@[node:image-a]");
        expect(result.text).not.toContain("/[skill:");
        expect(result.text).toContain("Please use");
    });

    it("leaves ordinary slashes and invalid or incomplete commands untouched", () => {
        const source = "https://example.com/a /not-a-skill /[skill:INVALID] /[skill:foo";
        expect(extractSkillMentions(source)).toEqual({ text: source, skillIds: [] });
    });

    it("turns inline mentions into the authoritative manual Skill binding", () => {
        const legacy = { mode: "manual" as const, skillIds: ["old-skill"] };
        expect(resolvePromptSkillBinding("Text /[skill:new-skill] and /[skill:other-skill]", legacy)).toEqual({
            mode: "manual", skillIds: ["new-skill", "other-skill"],
        });
        expect(resolvePromptSkillBinding("Text only", legacy)).toBe(legacy);
        expect(resolvePromptSkillBinding("Text only")).toBeUndefined();
    });

    it("virtually migrates old dropdown selections into visible tokens for editing", () => {
        const legacy = { mode: "manual" as const, skillIds: ["storyboard", "lighting", "storyboard"] };
        const value = showLegacySkillMentions("Draft scene", legacy);
        expect(value).toBe("Draft scene /[skill:storyboard] /[skill:lighting]");
        expect(showLegacySkillMentions(value, legacy)).toBe(value);
        expect(showLegacySkillMentions("No skills", { mode: "off", skillIds: ["storyboard"] })).toBe("No skills");
    });
});
