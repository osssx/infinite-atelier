import type { SkillBinding } from "./types";

export const SKILL_REFERENCE_PATTERN = /\/\[skill:([a-z0-9]+(?:-[a-z0-9]+)*)\]/g;

export function skillMentionToken(id: string): string {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("Invalid Skill ID");
    return "/[skill:" + id + "]";
}

/** Slash commands only start at a whitespace boundary; URLs remain normal text. */
export function activeSkillSlash(textBeforeCursor: string): string | null {
    return /(?:^|\s)\/([^\s/]*)$/.exec(textBeforeCursor)?.[1] ?? null;
}

export function extractSkillMentions(prompt: string): { text: string; skillIds: string[] } {
    const ids: string[] = [];
    const seen = new Set<string>();
    const text = prompt.replace(SKILL_REFERENCE_PATTERN, (_token, id: string) => {
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
        return "";
    }).replace(/ {2,}/g, " ");
    return { text, skillIds: ids };
}

/** Only pre-P2 nodes need this virtual migration; new inline tokens are authoritative. */
export function showLegacySkillMentions(value: string, binding?: SkillBinding): string {
    if (!binding || binding.mode !== "manual" || !binding.skillIds.length) return value;
    const inlineIds = new Set(extractSkillMentions(value).skillIds);
    const missing = [...new Set(binding.skillIds)].filter((id) => !inlineIds.has(id));
    if (!missing.length) return value;
    return value + (value.trim() ? " " : "") + missing.map(skillMentionToken).join(" ");
}

export function resolvePromptSkillBinding(prompt: string, legacy?: SkillBinding): SkillBinding | undefined {
    const { skillIds } = extractSkillMentions(prompt);
    if (skillIds.length) return { mode: "manual", skillIds };
    return legacy;
}
