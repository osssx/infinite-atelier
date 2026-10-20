import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiTextMessage } from "@/services/api/image";
import { getSkillPackage, listSkills } from "./skill-registry";
import { MissingSkillVersionError, resolveManualSkillContext, withManualSkillMessages } from "./skill-manual";
import type { SkillBinding, SkillCatalogEntry, SkillPackage } from "./types";

vi.mock("./skill-registry", () => ({
    listSkills: vi.fn(),
    getSkillPackage: vi.fn(),
}));
const firstVersion = "aaaaaaaaaaaa";
const nextVersion = "bbbbbbbbbbbb";
const referenceVersion = "cccccccccccc";
const catalog = (id: string, activeVersion = firstVersion, enabled = true): SkillCatalogEntry => ({
    id, name: id, description: "Authoring instruction", enabled, activeVersion,
    versions: [firstVersion, nextVersion, referenceVersion], updatedAt: "2026-10-20",
});
const pack = (id: string, version: string, content = "Use two-shot sequences"): SkillPackage => ({
    manifest: {
        id, name: id, description: "Authoring instruction", version,
        hash: version + "abcdef0123456789abcdef0123456789abcdef0123456789abc",
        resources: ["references/optional.md"], warnings: [],
    },
    skillMd: "---\nname: " + id + "\ndescription: Authoring instruction\n---\n# Instructions\n" + content,
    resources: { "references/optional.md": "Do not auto-load this document." },
});
const manual = (skillIds: string[]): SkillBinding => ({ mode: "manual", skillIds });
const messages: AiTextMessage[] = [{ role: "user", content: "Make a storyboard" }];
beforeEach(() => {
    vi.mocked(listSkills).mockResolvedValue([catalog("storyboard"), catalog("lighting", referenceVersion)]);
    vi.mocked(getSkillPackage).mockImplementation(async (id, version) => {
        if (id === "storyboard") return pack(id, version || firstVersion);
        if (id === "lighting") return pack(id, version || referenceVersion, "Maintain lighting continuity");
        return null;
    });
});
afterEach(() => vi.resetAllMocks());

describe("P2 manual Skill binding and pinned generation", () => {
    it("does not change normal generation without a Skill", async () => {
        expect(await resolveManualSkillContext(undefined)).toBeNull();
        expect(await resolveManualSkillContext({ mode: "off", skillIds: ["storyboard"] })).toBeNull();
        expect(withManualSkillMessages(messages, null)).toBe(messages);
        expect(getSkillPackage).not.toHaveBeenCalled();
    });
    it("loads multiple enabled Skill instructions once and adds a scoped user-level instruction message", async () => {
        const context = await resolveManualSkillContext(manual(["storyboard", "lighting", "storyboard"]));
        expect(context?.snapshot).toEqual({ mode: "manual", skillIds: ["storyboard", "lighting"], versionPins: { storyboard: firstVersion, lighting: referenceVersion } });
        const compiled = withManualSkillMessages(messages, context);
        expect(compiled[0]).toMatchObject({ role: "user" });
        expect(compiled[0].content).toContain("Use two-shot sequences");
        expect(compiled[0].content).toContain("Maintain lighting continuity");
        expect(compiled[0].content).not.toContain("Do not auto-load this document");
        expect(compiled[0].content).toContain("Make a storyboard");
        expect(compiled).toHaveLength(1);
        expect(messages).toHaveLength(1);
        expect(messages[0].content).toBe("Make a storyboard");
        expect(getSkillPackage).toHaveBeenCalledTimes(2);
    });
    it("preserves multimodal user attachments and keeps a single Gemini-compatible user turn", async () => {
        const selected = await resolveManualSkillContext(manual(["storyboard"]));
        const multimodal: AiTextMessage[] = [{ role: "user", content: [
            { type: "text", text: "Create a scene" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
        ] }];
        const result = withManualSkillMessages(multimodal, selected);
        expect(result).toHaveLength(1);
        expect(result[0].role).toBe("user");
        const content = result[0].content as Exclude<AiTextMessage["content"], string>;
        expect(content[0].type).toBe("text");
        expect(content[1]).toEqual(multimodal[0].content[0]);
        expect(content[2]).toEqual(multimodal[0].content[1]);
        expect(multimodal[0].content).toHaveLength(2);
    });
    it("uses the originally generated version even after changing the active version", async () => {
        const original = await resolveManualSkillContext(manual(["storyboard"]));
        vi.mocked(listSkills).mockResolvedValue([catalog("storyboard", nextVersion)]);
        const retry = await resolveManualSkillContext(manual(["lighting"]), original!.snapshot);
        expect(retry?.snapshot).toEqual(original?.snapshot);
        expect(getSkillPackage).toHaveBeenLastCalledWith("storyboard", firstVersion);
        expect(retry?.instruction).toContain('version="' + firstVersion + '"');
    });
    it("fails explicitly when a pinned version is removed, with no implicit new version fallback", async () => {
        vi.mocked(listSkills).mockResolvedValue([catalog("storyboard", nextVersion)]);
        vi.mocked(getSkillPackage).mockResolvedValue(null);
        await expect(resolveManualSkillContext(manual(["storyboard"]), {
            mode: "manual", skillIds: ["storyboard"], versionPins: { storyboard: firstVersion },
        })).rejects.toThrow(/version .* missing/);
        expect(getSkillPackage).toHaveBeenCalledWith("storyboard", firstVersion);
        try {
            await resolveManualSkillContext(manual(["storyboard"]), {
                mode: "manual", skillIds: ["storyboard"], versionPins: { storyboard: firstVersion },
            });
            throw new Error("Expected pinned Skill version to be unavailable");
        } catch (error) {
            expect(error).toBeInstanceOf(MissingSkillVersionError);
            expect((error as MissingSkillVersionError).version).toBe(firstVersion);
        }
    });
    it("refuses removed, disabled and unsupported automatic Skill modes", async () => {
        vi.mocked(listSkills).mockResolvedValue([]);
        await expect(resolveManualSkillContext(manual(["storyboard"]))).rejects.toThrow(/no longer installed/);
        vi.mocked(listSkills).mockResolvedValue([catalog("storyboard", firstVersion, false)]);
        await expect(resolveManualSkillContext(manual(["storyboard"]))).rejects.toThrow(/disabled/);
        await expect(resolveManualSkillContext({ mode: "auto", skillIds: ["storyboard"] })).rejects.toThrow(/not available/);
    });
    it("does not leak selected Skill context between parallel text generations", async () => {
        const [scene, light] = await Promise.all([
            resolveManualSkillContext(manual(["storyboard"])),
            resolveManualSkillContext(manual(["lighting"])),
        ]);
        const a = withManualSkillMessages(messages, scene);
        const b = withManualSkillMessages(messages, light);
        expect(String(a[0].content)).toContain("storyboard");
        expect(String(a[0].content)).not.toContain("lighting");
        expect(String(b[0].content)).toContain("lighting");
        expect(String(b[0].content)).not.toContain('id="storyboard"');
    });
    it("bounds the number and total length of injected Skill instructions", async () => {
        await expect(resolveManualSkillContext(manual(Array.from({ length: 13 }, (_, i) => "s" + i)))).rejects.toThrow(/at most 12/);
        vi.mocked(getSkillPackage).mockResolvedValue(pack("storyboard", firstVersion, "X".repeat(120_000)));
        await expect(resolveManualSkillContext(manual(["storyboard"]))).rejects.toThrow(/instruction limit/);
    });
});
