export type SkillMode = "off" | "manual" | "auto";
export type SkillBinding = { mode: SkillMode; skillIds: string[]; versionPins?: Record<string, string> };
export type SkillManifest = {
    id: string;
    name: string;
    description: string;
    hash: string;
    version: string;
    resources: string[];
    warnings: string[];
};
export type SkillCatalogEntry = {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    activeVersion: string;
    versions: string[];
    updatedAt: string;
};
export type SkillPackage = {
    manifest: SkillManifest;
    skillMd: string;
    resources: Record<string, string>;
    /** Original import bytes: retained for lossless export, never executed. */
    sourceArchive?: Blob;
};
export const MAX_SKILL_PACKAGE_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_TEXT_BYTES = 512 * 1024;
export const MAX_SKILL_FILES = 100;
