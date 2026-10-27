import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { webcrypto } from "node:crypto";

vi.mock("@/features/backend-sync/canvas-api", async () => {
    const {skillTestApi} = await import("./skill-registry-test-api");
    return {canvasApi:skillTestApi};
});
import {resetSkillTestApi} from "./skill-registry-test-api";
import { importSkillFile } from "./skill-import";
import { parseSkillMd, validateSkillPath } from "./skill-parser";
import { activateSkillVersion, exportSkill, getSkillPackage, listSkills, readSkillResource, registerSkill, removeSkill, restoreSkillSnapshot, setSkillEnabled, snapshotSkills } from "./skill-registry";

const markdown = (description = "Create structured storyboards") => ["---", "name: storyboard-prompt", "description: " + description, "---", "# Steps", "Break a scene into shots.", ""].join("\n");
const file = (content: BlobPart, name: string) => Object.assign(new Blob([content]), { name });
const packageZip = (files: Record<string, string | Uint8Array>, name = "storyboard.zip") => {
    const source = Object.fromEntries(Object.entries(files).map(([path, value]) => [path, typeof value === "string" ? new TextEncoder().encode(value) : value]));
    return file(zipSync(source, { level: 6 }), name);
};
const validZip = () => packageZip({
    "storyboard-prompt/SKILL.md": markdown(),
    "storyboard-prompt/references/shots.md": "# Shot rules\nUse wide shots first.",
    "storyboard-prompt/scripts/helper.py": "print('not executed')",
    "storyboard-prompt/assets/asset.bin": new Uint8Array([0, 1, 2]),
});
beforeEach(() => { resetSkillTestApi(); vi.stubGlobal("crypto", webcrypto); });
afterEach(() => vi.unstubAllGlobals());

describe("P1 Skill import, catalog and safe references", () => {
    it("imports a single SKILL.md, retains versions and can restore a snapshot", async () => {
        const first = await importSkillFile(file(markdown(), "SKILL.md"));
        const saved = await registerSkill(first);
        expect(saved.id).toBe("storyboard-prompt");
        expect(saved.versions).toHaveLength(1);
        const snapshot = await snapshotSkills();
        await registerSkill(await importSkillFile(file(markdown("Another description"), "SKILL.md")));
        expect((await listSkills())[0].versions).toHaveLength(2);
        await activateSkillVersion(saved.id, saved.activeVersion);
        expect((await getSkillPackage(saved.id))?.manifest.description).toBe("Create structured storyboards");
        await setSkillEnabled(saved.id, false);
        expect((await listSkills())[0].enabled).toBe(false);
        await expect(restoreSkillSnapshot(snapshot)).rejects.toThrow("本地 Skill");
        expect((await listSkills())[0].versions).toHaveLength(2);
        await activateSkillVersion(saved.id, saved.activeVersion);
        await removeSkill(saved.id);
        expect(await listSkills()).toEqual([]);
    });

    it("imports root-wrapped ZIP with references while scripts remain inert", async () => {
        const input = validZip();
        const parsed = await importSkillFile(input);
        expect(parsed.manifest.resources).toEqual(["references/shots.md"]);
        expect(parsed.manifest.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/inert/)]));
        const metadata = await registerSkill(parsed);
        expect(await readSkillResource(metadata.id, "references/shots.md")).toContain("wide shots");
        await expect(readSkillResource(metadata.id, "scripts/helper.py")).rejects.toThrow(/not model-readable/);
        await expect(readSkillResource(metadata.id, "references/../scripts/helper.py")).rejects.toThrow(/traversal/);
        expect((await exportSkill(metadata.id)).size).toBe(input.size);
    });

    it("rejects invalid and duplicate YAML metadata, unsafe paths and binary SKILL.md", async () => {
        expect(() => parseSkillMd("---\nname: Bad_Name\ndescription: valid\n---\n# Text")).toThrow(/name/);
        expect(() => parseSkillMd("---\nname: valid\ndescription: desc\nname: duplicate\n---\n# Text")).toThrow(/Duplicate/);
        expect(() => parseSkillMd("---\nname: valid\n---\n# Text")).toThrow(/description/);
        expect(() => validateSkillPath("../secrets.txt")).toThrow(/traversal/);
        expect(() => validateSkillPath("C:\\windows\\a")).toThrow(/path/);
        expect(() => validateSkillPath("https://evil")).toThrow(/path/);
        await expect(importSkillFile(file("\u0000" + markdown(), "SKILL.md"))).rejects.toThrow(/Binary/);
    });

    it("accepts optional Agent Skills nested metadata without granting script permission", () => {
        const md = ["---", "name: scene-writer", "description: A scene workflow", "metadata:", "  author: Studio", "  version: 1", "allowed-tools: Bash", "---", "# Workflow"].join("\n");
        expect(parseSkillMd(md).name).toBe("scene-writer");
    });

    it("supports folded multiline description", () => {
        expect(parseSkillMd("---\nname: scene-writer\ndescription: >\n  Generates shots\n  from scenes\n---\n# Task").description).toBe("Generates shots from scenes");
    });

    it("rejects multiple skill roots and out-of-root ZIP members", async () => {
        await expect(importSkillFile(packageZip({ "one/SKILL.md": markdown(), "two/SKILL.md": markdown() }))).rejects.toThrow(/exactly one/);
        await expect(importSkillFile(packageZip({ "one/SKILL.md": markdown(), "two/notes.md": "injected" }))).rejects.toThrow(/outside/);
    });

    it("rejects huge expanded size using central directory before decompression", async () => {
        const input = validZip();
        const bytes = new Uint8Array(await input.arrayBuffer());
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < bytes.length - 46; i++) {
            if (view.getUint32(i, true) === 0x02014b50) {
                view.setUint32(i + 24, 10 * 1024 * 1024, true);
                break;
            }
        }
        await expect(importSkillFile(file(bytes, "tampered.zip"))).rejects.toThrow(/expanded size/);
    });

    it("rejects ZIP symlinks using Unix external attributes", async () => {
        const input = validZip();
        const bytes = new Uint8Array(await input.arrayBuffer());
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < bytes.length - 46; i++) {
            if (view.getUint32(i, true) === 0x02014b50) {
                bytes[i + 5] = 3;
                view.setUint32(i + 38, 0xa0000000, true);
                break;
            }
        }
        await expect(importSkillFile(file(bytes, "links.zip"))).rejects.toThrow(/symlink/);
    });

    it("rejects unsafe ZIP traversal and duplicate paths", async () => {
        await expect(importSkillFile(packageZip({ "SKILL.md": markdown(), "../secret.md": "oops" }))).rejects.toThrow(/traversal/);
        const input = packageZip({ "SKILL.md": markdown(), "references/a.md": "fine" });
        const bytes = new Uint8Array(await input.arrayBuffer());
        const text = new TextDecoder().decode(bytes);
        // The same name appears in local and central headers: adjust both to path traversal without resizing.
        const bad = text.replaceAll("references/a.md", "../outside/a.md");
        await expect(importSkillFile(file(new TextEncoder().encode(bad), "bad.zip"))).rejects.toThrow();
    });
});
