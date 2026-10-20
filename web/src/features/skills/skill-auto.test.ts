import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@/stores/use-config-store";
import { runTextAgent } from "@/services/api/text-agent-runner";
import { getSkillPackage, listSkills } from "./skill-registry";
import { isUnsupportedSkillToolsError, prepareAutomaticSkillCatalog, withAutomaticSkillCatalog } from "./skill-auto";
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
        expect(run.tools.map((tool) => tool.name)).toEqual(["activate_skill", "read_skill_resource"]);
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
    it("only treats explicit unsupported tool schema errors as fallback-safe", () => {
        expect(isUnsupportedSkillToolsError(new Error("tools not supported by this model"))).toBe(true);
        expect(isUnsupportedSkillToolsError(new Error("invalid parameter: tool_choice"))).toBe(true);
        expect(isUnsupportedSkillToolsError(new Error("API key unauthorized"))).toBe(false);
        expect(isUnsupportedSkillToolsError(new Error("network timeout"))).toBe(false);
    });
});
