import { describe, expect, it } from "vitest";
import { validateBackup, type AppBackupFile } from "./backup-validation";

const sample = (): AppBackupFile => ({
    app: "infinite-canvas",
    version: 1,
    exportedAt: "2026-10-20T00:00:00Z",
    projects: [{
        id: "a", title: "Project", createdAt: "2026-10-20", updatedAt: "2026-10-20",
        nodes: [{ id: "image-1", type: "image", title: "Picture", width: 256, height: 256,
            position: { x: 0, y: 0 }, metadata: { storageKey: "image:1" } }],
        connections: [], chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 },
        backgroundMode: "lines", showImageInfo: false,
    }],
    assets: [],
    config: {} as AppBackupFile["config"],
    files: [{ storageKey: "image:1", mimeType: "image/png", path: "files/image_1.png" }],
});

const blobs = () => new Map<string, Blob>([["files/image_1.png", new Blob(["image"], { type: "image/png" })]]);

describe("logical v1 application backup validation", () => {
    it("retains v1 support when all referenced local media is present", () => {
        expect(validateBackup(sample(), blobs()).projects).toHaveLength(1);
    });
    it("rejects a missing zip entry before modifying any saved data", () => {
        expect(() => validateBackup(sample(), new Map())).toThrow(/missing media file/);
    });
    it("rejects missing referenced local image even if other files exist", () => {
        const backup = sample();
        backup.files = [];
        expect(() => validateBackup(backup, blobs())).toThrow(/missing referenced media/);
    });
    it("rejects a media path collision or duplicate storage key", () => {
        const backup = sample();
        backup.files.push({ storageKey: "video:2", path: backup.files[0].path, mimeType: "video/mp4" });
        expect(() => validateBackup(backup, blobs())).toThrow(/duplicate or unsafe/);
    });
    it("rejects duplicate project IDs and malformed records", () => {
        const backup = sample();
        backup.projects = [backup.projects[0], { ...backup.projects[0] }];
        expect(() => validateBackup(backup, blobs())).toThrow(/duplicate project/);
        expect(() => validateBackup({ ...sample(), files: null }, blobs())).toThrow(/format/);
    });
    it("validates optional Skill archive references and accepts legacy backups without them", () => {
        const backup = sample();
        expect(validateBackup(backup, blobs()).skills).toBeUndefined();
        const version = "abc123abc123";
        const skillEntry = { id: "my-skill", name: "my-skill", description: "Skill description", enabled: true, activeVersion: version, versions: [version], updatedAt: "2026-10-20" };
        const path = "skills/my-skill/" + version + ".zip";
        backup.skills = { catalog: [skillEntry], packages: [{ id: "my-skill", version, path }] };
        expect(() => validateBackup(backup, blobs())).toThrow(/missing Skill package/);
        const zip = blobs();
        zip.set(path, new Blob(["archive"]));
        expect(validateBackup(backup, zip).skills?.catalog[0].id).toBe("my-skill");
        backup.skills.packages.push({ id: "my-skill", version, path });
        expect(() => validateBackup(backup, zip)).toThrow(/duplicate/);
    });
    it("keeps legacy Skills global and validates optional project scope in backups", () => {
        const backup = sample();
        const version = "abc123abc123", path = "skills/my-skill/" + version + ".zip";
        const baseEntry = { id: "my-skill", name: "my-skill", description: "Guidance", enabled: true,
            activeVersion: version, versions: [version], updatedAt: "2026-10-20" };
        backup.skills = { catalog: [baseEntry], packages: [{ id: "my-skill", version, path }] };
        const zip = blobs();
        zip.set(path, new Blob(["package"]));
        expect(validateBackup(backup, zip).skills?.catalog[0].scope).toBeUndefined();
        backup.skills.catalog[0].scope = { type: "project", projectId: backup.projects[0].id };
        expect(validateBackup(backup, zip).skills?.catalog[0].scope).toEqual({ type: "project", projectId: backup.projects[0].id });
        backup.skills.catalog[0].scope = { type: "project", projectId: "" };
        expect(() => validateBackup(backup, zip)).toThrow(/invalid Skill catalog/);
        backup.skills.catalog[0] = { ...backup.skills.catalog[0], scope: { type: "unexpected" } } as unknown as typeof backup.skills.catalog[number];
        expect(() => validateBackup(backup, zip)).toThrow(/invalid Skill catalog/);
    });
    it("does not require generated previews or media for remote-only URLs", () => {
        const backup = sample();
        backup.projects[0].nodes[0].metadata = { content: "https://example.com/image.png" };
        backup.files = [];
        expect(validateBackup(backup, new Map()).files).toHaveLength(0);
    });
});
