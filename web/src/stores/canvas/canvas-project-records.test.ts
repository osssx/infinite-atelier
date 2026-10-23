import { describe, expect, it } from "vitest";
import { CanvasProjectRecords, type CanvasManifest, type CanvasRecordStore } from "./canvas-project-records";
import type { CanvasProject } from "./use-canvas-store";

class FakeStore implements CanvasRecordStore {
    items = new Map<string, unknown>();
    writes: string[] = [];
    deletes: string[] = [];
    failKey: string | null = null;
    async getItem<T>(key: string): Promise<T | null> {
        return (this.items.get(key) ?? null) as T | null;
    }
    async setItem<T>(key: string, value: T) {
        if (this.failKey === key) throw Error("Simulated IndexedDB interruption");
        this.writes.push(key);
        this.items.set(key, value);
    }
    async removeItem(key: string) {
        this.deletes.push(key);
        this.items.delete(key);
    }
}
function project(id: string, size = 16): CanvasProject {
    return {
        id, title: id, createdAt: "2026-10-20", updatedAt: "2026-10-20",
        nodes: [], connections: [], chatSessions: [],
        activeChatId: null, backgroundMode: "lines", showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        // Use a realistic large serialized field without building test-only node metadata.
        descriptionForTest: "x".repeat(size),
    } as CanvasProject;
}
const setup = () => {
    const docs = new FakeStore();
    const meta = new FakeStore();
    return { docs, meta, repository: new CanvasProjectRecords(docs, meta) };
};
const current = (meta: FakeStore) => meta.items.get("current") as CanvasManifest;

describe("canvas per-project atomic IndexedDB persistence", () => {
    it("commits canvas-wide ComfyUI instance selection and restores it after reload", async () => {
        const {docs,meta,repository}=setup();
        const original=project("comfy-canvas");
        await repository.save([original]);
        const revised={...original,comfyInstanceId:"comfy-local"};
        const saved=await repository.save([revised]);
        expect(saved.changedProjects).toBe(1);
        expect((await new CanvasProjectRecords(docs,meta).load())?.[0].comfyInstanceId).toBe("comfy-local");
        const cleared=await repository.save([{...revised,comfyInstanceId:undefined}]);
        expect(cleared.changedProjects).toBe(1);
        expect((await new CanvasProjectRecords(docs,meta).load())?.[0].comfyInstanceId).toBeUndefined();
    });

    it("writes only a changed project even when 100 large projects exist", async () => {
        const { docs, meta, repository } = setup();
        const all = Array.from({ length: 100 }, (_, i) => project("p" + i, 70_000));
        const first = await repository.save(all);
        expect(first.changedProjects).toBe(100);
        expect(docs.writes).toHaveLength(100);

        const edited = [...all];
        edited[42] = { ...edited[42], title: "changed" };
        const second = await repository.save(edited);
        expect(second.changedProjects).toBe(1);
        expect(second.bytes).toBeLessThan(first.bytes / 40);
        expect(docs.writes).toHaveLength(101);
        const oldIndex = current(meta);
        expect(oldIndex.entries[0].key).toContain("revision:1");
        expect(oldIndex.entries[42].key).toContain("revision:2");
        expect(oldIndex.entries[99].key).toContain("revision:1");
        expect((await new CanvasProjectRecords(docs, meta).load())?.[42].title).toBe("changed");
    });

    it("saves repeated viewport moves in the small manifest without serializing any nodes", async () => {
        const { docs, meta, repository } = setup();
        const a = project("a", 2_000_000), b = project("b", 2_000_000);
        await repository.save([a, b]);
        const initialKeys = current(meta).entries.map((e) => e.key);
        const zoomed = { ...a, viewport: { x: 100, y: -200, k: 0.35 }, updatedAt: "2026-10-21" };
        const result = await repository.save([zoomed, b]);
        expect(result.changedProjects).toBe(0);
        expect(result.bytes).toBe(0);
        expect(docs.writes).toHaveLength(2);
        expect(current(meta).entries.map((e) => e.key)).toEqual(initialKeys);
        const restored = await new CanvasProjectRecords(docs, meta).load();
        expect(restored?.[0].viewport).toEqual(zoomed.viewport);
        expect(restored?.[0].updatedAt).toBe("2026-10-21");
        expect(restored?.[0].title).toBe("a");
    });

    it("persists metadata ordering and deletion without rewriting unchanged project bodies", async () => {
        const { docs, meta, repository } = setup();
        const a = project("a"), b = project("b"), c = project("c");
        await repository.save([a, b, c]);
        const reordered = await repository.save([c, a, b]);
        expect(reordered.changedProjects).toBe(0);
        expect(docs.writes).toHaveLength(3);
        const deleted = await repository.save([a, c]);
        expect(deleted.changedProjects).toBe(0);
        expect((await new CanvasProjectRecords(docs, meta).load())?.map((p) => p.id)).toEqual(["a", "c"]);
        await repository.clear();
        expect(await new CanvasProjectRecords(docs, meta).load()).toEqual([]);
    });

    it("does not expose partially written updated projects if the manifest commit fails", async () => {
        const { docs, meta, repository } = setup();
        const a = project("a"), b = project("b");
        await repository.save([a, b]);
        meta.failKey = "current";
        await expect(repository.save([{ ...a, title: "new" }, b])).rejects.toThrow("interruption");
        meta.failKey = null;
        // The old current manifest remains atomic even when the new project bytes have been written.
        expect((await new CanvasProjectRecords(docs, meta).load())?.[0].title).toBe("a");
        await repository.save([{ ...a, title: "new" }, b]);
        expect((await new CanvasProjectRecords(docs, meta).load())?.[0].title).toBe("new");
    });

    it("rolls back to the previous manifest when a committed snapshot becomes corrupt", async () => {
        const { docs, meta, repository } = setup();
        const old = project("one");
        await repository.save([old, project("two")]);
        await repository.save([{ ...old, title: "latest" }, project("two")]);
        const key = current(meta).entries[0].key;
        docs.items.delete(key);
        const recovered = new CanvasProjectRecords(docs, meta);
        const loaded = await recovered.load();
        expect(loaded?.[0].title).toBe("one");
        await recovered.save(loaded!);
        expect((await new CanvasProjectRecords(docs, meta).load())?.[0].title).toBe("one");
    });

    it("fails closed rather than silently reverting to stale legacy data if both snapshots are missing", async () => {
        const { docs, meta, repository } = setup();
        await repository.save([project("safety")]);
        docs.items.clear();
        await expect(new CanvasProjectRecords(docs, meta).load()).rejects.toThrow("incomplete");
    });

    it("rejects duplicate project IDs and leaves the committed manifest unchanged", async () => {
        const { docs, meta, repository } = setup();
        await repository.save([project("one")]);
        const previous = current(meta);
        await expect(repository.save([project("one"), project("one")])).rejects.toThrow("Duplicate");
        expect(current(meta)).toBe(previous);
        expect(docs.writes).toHaveLength(1);
    });
});
