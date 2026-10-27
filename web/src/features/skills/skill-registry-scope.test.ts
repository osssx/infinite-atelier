import { beforeEach, describe, expect, it, vi } from "vitest";
import { isEnabledSkillInProject, isSkillInProjectScope, type SkillPackage } from "./types";

vi.mock("@/features/backend-sync/canvas-api", async () => {
    const {skillTestApi} = await import("./skill-registry-test-api");
    return {canvasApi:skillTestApi};
});
import {resetSkillTestApi} from "./skill-registry-test-api";
import { getSkillPackage, listSkills, registerSkill, restoreSkillSnapshot, setSkillScope, snapshotSkills } from "./skill-registry";

const makePackage = (version: string): SkillPackage => ({
    manifest: {
        id: "storyboard", name: "storyboard", description: "Storyboard authoring", version,
        hash: version + "a".repeat(52), resources: ["references/shot.md"], warnings: [],
    },
    skillMd: "---\nname: storyboard\ndescription: Storyboard authoring\n---\n# Instructions",
    resources: { "references/shot.md": "Use close-ups" },
});
beforeEach(() => resetSkillTestApi());

describe("P4 Skill registry global and project scope persistence", () => {
    it("defaults old catalog entries to global availability without migration", async () => {
        const original = await registerSkill(makePackage("111111111111"));
        expect(original.scope).toBeUndefined();
        expect(isSkillInProjectScope(original, "project-a")).toBe(true);
        expect(isEnabledSkillInProject(original, "project-b")).toBe(true);
        expect(isSkillInProjectScope(original)).toBe(true);
    });
    it("persists a project assignment and retains it when a new package version is registered", async () => {
        await registerSkill(makePackage("111111111111"));
        await setSkillScope("storyboard", { type: "project", projectId: "project-a" });
        await registerSkill(makePackage("222222222222"));
        const current = (await listSkills())[0];
        expect(current.scope).toEqual({ type: "project", projectId: "project-a" });
        expect(current.versions).toEqual(["111111111111", "222222222222"]);
        expect(isEnabledSkillInProject(current, "project-a")).toBe(true);
        expect(isEnabledSkillInProject(current, "project-b")).toBe(false);
        expect(isEnabledSkillInProject(current)).toBe(false);
        const pkg = await getSkillPackage("storyboard");
        expect(pkg?.manifest.version).toBe("222222222222");
    });
    it("restores scoped metadata from backup, and can switch back to global", async () => {
        await registerSkill(makePackage("111111111111"));
        await setSkillScope("storyboard", { type: "project", projectId: "project-a" });
        const backup = await snapshotSkills();
        await setSkillScope("storyboard", { type: "global" });
        expect((await listSkills())[0].scope).toBeUndefined();
        await expect(restoreSkillSnapshot(backup)).rejects.toThrow("SQLite Skill");
        await setSkillScope("storyboard", { type: "project", projectId: "project-a" });
        expect((await listSkills())[0].scope).toEqual({ type: "project", projectId: "project-a" });
        await setSkillScope("storyboard", { type: "global" });
        expect((await listSkills())[0].scope).toBeUndefined();
    });
    it("validates project scope input and does not leak mutable references from listSkills", async () => {
        await registerSkill(makePackage("111111111111"));
        await expect(setSkillScope("storyboard", { type: "project", projectId: "" })).rejects.toThrow(/Invalid/);
        await setSkillScope("storyboard", { type: "project", projectId: "project-a" });
        const visible = await listSkills();
        if (visible[0].scope?.type === "project") visible[0].scope.projectId = "hijacked-project";
        expect((await listSkills())[0].scope).toEqual({ type: "project", projectId: "project-a" });
    });
});
