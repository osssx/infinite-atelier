import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@/stores/use-config-store";
import { runTextAgent } from "@/services/api/text-agent-runner";
import { getSkillPackage, listSkills } from "./skill-registry";
import { MAX_CATALOG_CHARS, isUnsupportedSkillToolsError, prepareAutomaticSkillCatalog, withAutomaticSkillCatalog } from "./skill-auto";
import type { SkillCatalogEntry, SkillPackage } from "./types";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/api-proxy", () => ({ proxyApiUrl: (url: string) => url }));
vi.mock("./skill-registry", () => ({ listSkills: vi.fn(), getSkillPackage: vi.fn() }));
const id = "storyboard-prompt", version = "aaaaaaaaaaaa", next = "bbbbbbbbbbbb";
const active: SkillCatalogEntry = { id, name: id, enabled: true, description: "Construct storyboard shots", activeVersion: version,
    versions: [version, next], updatedAt: "2026-10-20" };
const content = "---\nname: storyboard-prompt\ndescription: Construct storyboard shots\n---\n# Process\nUse wide shots";
const pkg = (v = version): SkillPackage => ({ manifest: { id, name: id, version: v, hash: v + "0".repeat(52), description: active.description,
    resources: ["references/guide.md"], warnings: [] }, skillMd: content, resources: { "references/guide.md": "# Shot guide" },
    sourceArchive: new Blob(["inert"]) });
const call = (name: string, args: object, id = "tool-1") => ({ name, id, argumentsJson: JSON.stringify(args) });
beforeEach(() => {
    vi.mocked(listSkills).mockResolvedValue([active]);
    vi.mocked(getSkillPackage).mockImplementation(async (_id, v) => pkg(v || version));
});
afterEach(() => vi.resetAllMocks());

describe("P3 default automatic Skill selection and safe tool dispatcher", () => {
    it("filters project-scoped Skills for automatic discovery and full search authorization", async () => {
        const global = active;
        const thisProject: SkillCatalogEntry = { ...active, id: "project-guidance", name: "project-guidance",
            description: "In-project instructions", scope: { type: "project", projectId: "project-a" } };
        const otherProject: SkillCatalogEntry = { ...active, id: "private-guide", name: "private-guide",
            description: "Private instructions in another project", scope: { type: "project", projectId: "project-b" } };
        vi.mocked(listSkills).mockResolvedValue([global, thisProject, otherProject]);
        const plan = (await prepareAutomaticSkillCatalog(undefined, undefined, "guidance", "project-a"))!;
        expect(plan.snapshot().skillIds).toEqual([id, "project-guidance"]);
        expect(plan.catalogMessage).not.toContain("private-guide");
        const found = JSON.parse(await plan.createRun().executeTool(call("search_skills", { query: "private" }), {}));
        expect(found.matches).toEqual([]);
        await expect(plan.createRun().executeTool(call("activate_skill", { skill_id: "private-guide" }), {}))
            .rejects.toThrow(/not authorized/);
        const globalOnly = (await prepareAutomaticSkillCatalog(undefined, undefined, "guidance"))!;
        expect(globalOnly.snapshot().skillIds).toEqual([id]);
    });
    it("rejects cross-project IDs injected into old bindings and pinned auto snapshots", async () => {
        vi.mocked(listSkills).mockResolvedValue([{ ...active, scope: { type: "project", projectId: "project-b" } }]);
        await expect(prepareAutomaticSkillCatalog({ mode: "auto", skillIds: [id] }, undefined, "storyboard", "project-a"))
            .rejects.toThrow(/not available in this project/);
        await expect(prepareAutomaticSkillCatalog(undefined,
            { mode: "auto", skillIds: [id], versionPins: { [id]: version }, activatedSkillIds: [id] },
            "storyboard", "project-a")).rejects.toThrow(/not available in this project/);
        expect(getSkillPackage).not.toHaveBeenCalled();
    });
    it("is a no-op with an empty enabled catalog, and ignores disabled Skills", async () => {
        vi.mocked(listSkills).mockResolvedValue([{ ...active, enabled: false }]);
        expect(await prepareAutomaticSkillCatalog()).toBeNull();
        vi.mocked(listSkills).mockResolvedValue([]);
        expect(await prepareAutomaticSkillCatalog()).toBeNull();
    });
    it("discovers only names and descriptions; reads no bodies until activation", async () => {
        const plan = (await prepareAutomaticSkillCatalog())!;
        expect(plan.catalogMessage).toContain("Construct storyboard shots");
        expect(plan.catalogMessage).not.toContain("# Process");
        expect(plan.catalogMessage).not.toContain("# Shot guide");
        expect(getSkillPackage).not.toHaveBeenCalled();
        const messages = withAutomaticSkillCatalog([{ role: "user", content: "Make a shot list" }], plan);
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe("user");
        expect(messages[0].content).toContain("Make a shot list");
        const run = plan.createRun();
        expect(run.tools.map((tool) => tool.name)).toEqual(["activate_skill", "read_skill_resource", "search_skills"]);
        expect(run.snapshot().activatedSkillIds).toEqual([]);
    });
    it("allows only activation before reading references and records versions and trace", async () => {
        const run = (await prepareAutomaticSkillCatalog())!.createRun();
        await expect(run.executeTool(call("read_skill_resource", { skill_id: id, path: "references/guide.md" }), {})).rejects.toThrow(/activated/);
        const activation = JSON.parse(await run.executeTool(call("activate_skill", { skill_id: id }), {}));
        expect(activation.content).toContain("Use wide shots");
        expect(activation.references).toEqual(["references/guide.md"]);
        expect(JSON.parse(await run.executeTool(call("read_skill_resource", { skill_id: id, path: "references/guide.md" }), {})).content).toBe("# Shot guide");
        expect(run.snapshot()).toEqual({ mode: "auto", skillIds: [id], versionPins: { [id]: version }, activatedSkillIds: [id] });
        expect(run.trace().map((event) => event.type)).toEqual(["error", "activated", "reference"]);
    });
    it("rejects unauthorized ids, paths, scripts, extra args and arbitrary tool names", async () => {
        const run = (await prepareAutomaticSkillCatalog())!.createRun();
        await expect(run.executeTool(call("activate_skill", { skill_id: "private-files" }), {})).rejects.toThrow(/not authorized/);
        await expect(run.executeTool(call("delete_file", { skill_id: id }), {})).rejects.toThrow(/Unauthorized/);
        await expect(run.executeTool(call("activate_skill", { skill_id: id, exec: "ls" }), {})).rejects.toThrow(/schema/);
        await run.executeTool(call("activate_skill", { skill_id: id }), {});
        await expect(run.executeTool(call("read_skill_resource", { skill_id: id, path: "../config.json" }), {})).rejects.toThrow(/path traversal/);
        await expect(run.executeTool(call("read_skill_resource", { skill_id: id, path: "scripts/helper.py" }), {})).rejects.toThrow(/Unauthorized/);
        await expect(run.executeTool(call("read_skill_resource", { skill_id: id, path: "references/missing.md" }), {})).rejects.toThrow(/Unauthorized/);
    });
    it("isolates activation across concurrent runs", async () => {
        const plan = (await prepareAutomaticSkillCatalog())!;
        const a = plan.createRun(), b = plan.createRun();
        await a.executeTool(call("activate_skill", { skill_id: id }), {});
        expect(a.snapshot().activatedSkillIds).toEqual([id]);
        expect(b.snapshot().activatedSkillIds).toEqual([]);
        await expect(b.executeTool(call("read_skill_resource", { skill_id: id, path: "references/guide.md" }), {})).rejects.toThrow(/activated/);
    });
    it("shares immutable package fetches across concurrent runs, not activation permissions", async () => {
        const plan = (await prepareAutomaticSkillCatalog())!;
        const first = plan.createRun(), second = plan.createRun();
        await Promise.all([
            first.executeTool(call("activate_skill", { skill_id: id }, "a"), {}),
            second.executeTool(call("activate_skill", { skill_id: id }, "b"), {}),
        ]);
        expect(getSkillPackage).toHaveBeenCalledTimes(1);
        expect(first.snapshot().activatedSkillIds).toEqual([id]);
        expect(second.snapshot().activatedSkillIds).toEqual([id]);
        expect(first.trace()).toHaveLength(1);
        expect(second.trace()).toHaveLength(1);
    });
    it("cancels before returning sensitive stored content", async () => {
        const plan = (await prepareAutomaticSkillCatalog())!, run = plan.createRun();
        const controller = new AbortController();
        controller.abort();
        await expect(run.executeTool(call("activate_skill", { skill_id: id }), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(run.snapshot().activatedSkillIds).toHaveLength(0);
    });
    it("pins previous automatic catalog versions across changes and errors if original version is missing", async () => {
        const plan = (await prepareAutomaticSkillCatalog())!;
        vi.mocked(listSkills).mockResolvedValue([{ ...active, activeVersion: next }]);
        const retried = (await prepareAutomaticSkillCatalog(undefined, plan.snapshot()))!;
        expect(retried.snapshot().versionPins[id]).toBe(version);
        expect(getSkillPackage).toHaveBeenCalledWith(id, version);
        vi.mocked(getSkillPackage).mockResolvedValue(null);
        await expect(prepareAutomaticSkillCatalog(undefined, plan.snapshot())).rejects.toThrow(/version/);
    });
    it("rejects large documents instead of returning unbounded contexts", async () => {
        vi.mocked(getSkillPackage).mockResolvedValue({ ...pkg(), skillMd: "X".repeat(25000) });
        const run = (await prepareAutomaticSkillCatalog())!.createRun();
        await expect(run.executeTool(call("activate_skill", { skill_id: id }), {})).rejects.toThrow(/24,000/);
    });
    it("executes the model tool loop and sends back read-only results", async () => {
        const run = (await prepareAutomaticSkillCatalog())!.createRun();
        const generateTurn = vi.fn()
            .mockResolvedValueOnce({ text: "", toolCalls: [call("activate_skill", { skill_id: id })] })
            .mockResolvedValueOnce({ text: "", toolCalls: [call("read_skill_resource", { skill_id: id, path: "references/guide.md" }, "tool-2")] })
            .mockResolvedValueOnce({ text: "Done: six shots", toolCalls: [] });
        const answer = await runTextAgent({ config: { ...defaultConfig, systemPrompt: "" },
            messages: [{ role: "user", content: "Storyboards" }], tools: run.tools,
            executeTool: run.executeTool, onEvent: run.onEvent, generateTurn });
        expect(answer).toBe("Done: six shots");
        const finalMessages = generateTurn.mock.calls[2][0].messages;
        expect(finalMessages.filter((item: { role: string }) => item.role === "tool")).toHaveLength(2);
        expect(run.trace().map((e) => e.type)).toEqual(["activated", "reference"]);
    });
    it("caps large catalogs and ranks query-relevant Skills for direct discovery", async () => {
        const many = Array.from({ length: 95 }, (_, index): SkillCatalogEntry => ({
            ...active, id: "skill-" + String(index).padStart(3, "0"),
            name: "skill-" + String(index).padStart(3, "0"),
            description: "General purpose workflow " + "example ".repeat(25),
        }));
        many.push({ ...active, id: "cinematic-storyboards", name: "cinematic-storyboards",
            description: "Make cinematic storyboard shots and camera directions" });
        vi.mocked(listSkills).mockResolvedValue(many);
        const plan = (await prepareAutomaticSkillCatalog(undefined, undefined, "cinematic storyboard shots"))!;
        expect(plan.catalogMessage.length).toBeLessThanOrEqual(MAX_CATALOG_CHARS);
        expect(plan.catalogMessage).toContain("cinematic-storyboards");
        expect(plan.catalogMessage).toContain("96 authorized Skills");
        expect(plan.catalogMessage).not.toContain("skill-094");
        const run = plan.createRun();
        const out = JSON.parse(await run.executeTool(call("search_skills", { query: "general workflow" }), {}));
        expect(out.total).toBe(96);
        expect(out.matches.length).toBeLessThanOrEqual(8);
        expect(out.matches.some((item: { skill_id: string }) => item.skill_id.startsWith("skill-"))).toBe(true);
        expect(run.snapshot().skillIds).toHaveLength(96);
        expect(getSkillPackage).not.toHaveBeenCalled();
    });
    it("search_skills enforces authorization, size limit and CJK relevance", async () => {
        vi.mocked(listSkills).mockResolvedValue([active, { ...active, id: "chinese-guide", name: "chinese-guide",
            description: "为电影镜头和分镜提供专业指导" }]);
        const run = (await prepareAutomaticSkillCatalog())!.createRun();
        const result = JSON.parse(await run.executeTool(call("search_skills", { query: "电影分镜" }), {}));
        expect(result.matches[0].skill_id).toBe("chinese-guide");
        expect(result.matches).toHaveLength(1);
        await expect(run.executeTool(call("search_skills", { query: "x".repeat(201) }), {})).rejects.toThrow(/200/);
        await expect(run.executeTool(call("search_skills", { query: "test", execute: true }), {})).rejects.toThrow(/schema/);
    });
    it("tracks bounded per-request tool metadata separately across runs", async () => {
        const plan = (await prepareAutomaticSkillCatalog())!;
        const first = plan.createRun(), second = plan.createRun();
        const generateTurn = vi.fn().mockResolvedValueOnce({
            text: "", toolCalls: [call("search_skills", { query: "storyboard" })],
        }).mockResolvedValueOnce({ text: "No skill required", toolCalls: [] });
        await runTextAgent({ config: { ...defaultConfig, systemPrompt: "" }, messages: [{ role: "user", content: "test" }],
            tools: first.tools, executeTool: first.executeTool, onEvent: first.onEvent, generateTurn });
        expect(first.metrics().catalogChars).toBe(plan.catalogMessage.length);
        expect(first.metrics().catalogEstimatedTokens).toBe(Math.ceil(plan.catalogMessage.length / 4));
        expect(first.metrics().toolCalls).toBe(1);
        expect(first.metrics().rounds).toBe(1);
        expect(first.metrics().toolDurationMs).toBeGreaterThanOrEqual(0);
        expect(second.metrics().toolCalls).toBe(0);
        expect(first.trace().map((item) => item.type)).toEqual(["search"]);
        expect(second.trace()).toEqual([]);
    });
    it("only treats explicit unsupported tool schema errors as fallback-safe", () => {
        expect(isUnsupportedSkillToolsError(new Error("tools not supported by this model"))).toBe(true);
        expect(isUnsupportedSkillToolsError(new Error("invalid parameter: tool_choice"))).toBe(true);
        expect(isUnsupportedSkillToolsError(new Error("API key unauthorized"))).toBe(false);
        expect(isUnsupportedSkillToolsError(new Error("network timeout"))).toBe(false);
    });
});
