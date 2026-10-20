import { MAX_SKILL_TEXT_BYTES, type SkillManifest } from "./types";

const nameRule = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const textEncoder = new TextEncoder();

/** Paths are case-sensitive, relative to the skill package root and never resolve URLs. */
export function validateSkillPath(path: string): string {
    if (!path || path.length > 240 || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path) ||
        path.startsWith("/") || /^[a-zA-Z]:/.test(path) || /^(?:https?:|file:|data:)/i.test(path)) {
        throw new Error("Invalid Skill resource path");
    }
    const components = path.split("/");
    if (components.some((part) => !part || part === "." || part === "..")) throw new Error("Invalid Skill resource path traversal");
    return path;
}
function unquoteYaml(value: string) {
    const text = value.trim();
    if (!text) return "";
    if (text.startsWith('"')) {
        try { const decoded = JSON.parse(text); if (typeof decoded === "string") return decoded; }
        catch { throw new Error("Invalid Skill YAML quoted value"); }
        throw new Error("Invalid Skill YAML string");
    }
    if (text.startsWith("'")) {
        if (!text.endsWith("'") || text.length < 2) throw new Error("Invalid Skill YAML single-quoted value");
        return text.slice(1, -1).replace(/''/g, "'");
    }
    return text.replace(/\s+#.*$/, "").trim();
}
export function parseSkillMd(md: string): { name: string; description: string } {
    if (textEncoder.encode(md).byteLength > MAX_SKILL_TEXT_BYTES) throw new Error("SKILL.md exceeds 512 KiB");
    const lines = md.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
    if (lines[0]?.trim() !== "---") throw new Error("SKILL.md requires YAML frontmatter");
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end <= 1 || end > 120) throw new Error("SKILL.md frontmatter is missing closing ---");
    const values: Record<string, string> = {};
    let nestedKey = "";
    for (let i = 1; i < end; i++) {
        const line = lines[i];
        if (!line.trim() || /^\s*#/.test(line)) continue;
        // Agent Skills permits optional metadata objects. They are informational
        // and never grant tool permissions; only name/description are interpreted.
        if (/^\s/.test(line)) {
            if (nestedKey && nestedKey !== "name" && nestedKey !== "description") continue;
            throw new Error("Invalid Skill YAML frontmatter indentation");
        }
        const match = /^([a-zA-Z][\w-]*):(?:\s*(.*))?$/.exec(line);
        if (!match) throw new Error("Invalid Skill YAML frontmatter entry");
        const key = match[1];
        nestedKey = key;
        if (Object.hasOwn(values, key)) throw new Error("Duplicate Skill YAML property");
        let value = match[2] || "";
        if (value === ">" || value === "|" || value === ">-" || value === "|-") {
            const folded = value.startsWith(">");
            const blocks: string[] = [];
            while (i + 1 < end && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) {
                i++;
                blocks.push(lines[i].replace(/^ {1,4}/, ""));
            }
            value = blocks.join(folded ? " " : "\n").trim();
        }
        values[key] = unquoteYaml(value);
    }
    const name = values.name || "";
    const description = values.description || "";
    if (!nameRule.test(name) || name.length > 64) throw new Error("Skill name must be lowercase hyphen-separated (max 64 characters)");
    if (!description.trim() || description.length > 1024 || /[\x00-\x08\x0e-\x1f]/.test(description)) {
        throw new Error("Skill description must be 1-1024 characters");
    }
    if (!lines.slice(end + 1).join("").trim()) throw new Error("SKILL.md body is empty");
    return { name, description };
}
export function buildSkillManifest(md: string, hash: string, paths: string[]): SkillManifest {
    const metadata = parseSkillMd(md);
    const resources = paths.filter((path) => /^references\/.+\.(?:md|txt|markdown)$/i.test(path)).sort();
    const warnings = paths.some((path) => path.startsWith("scripts/")) ? ["Script files are inert and cannot be executed in V1"] : [];
    if (paths.some((path) => path.startsWith("assets/"))) warnings.push("Asset files are retained for export, but are not executable or model-readable in V1");
    return { id: metadata.name, ...metadata, hash, version: hash.slice(0, 12), resources, warnings };
}
