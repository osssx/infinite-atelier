import { create } from "zustand";
import { activateSkillVersion, getSkillRegistrySnapshot, scanSkillDirectory, setSkillEnabled, setSkillScope } from "@/features/skills/skill-registry";
import type {SkillScanResult} from "@/features/skills/skill-registry";
import type { SkillCatalogEntry, SkillScope } from "@/features/skills/types";

type SkillStore = {
    catalog: SkillCatalogEntry[];
    catalogRevision: number;
    loaded: boolean;
    busy: boolean;
    scanResult: SkillScanResult | null;
    scan: () => Promise<SkillScanResult>;
    refresh: () => Promise<void>;
    toggle: (id: string, enabled: boolean) => Promise<void>;
    changeVersion: (id: string, version: string) => Promise<void>;
    changeScope: (id: string, scope: SkillScope) => Promise<void>;
};
let loading: Promise<void> | null = null;
export const useSkillStore = create<SkillStore>((set, get) => {
    const refresh = async () => {
        const snapshot = await getSkillRegistrySnapshot();
        if (snapshot.revision >= get().catalogRevision)
            set({ catalog: snapshot.skills, catalogRevision: snapshot.revision, loaded: true });
    };
    const change = async (run: (revision: number | undefined) => Promise<unknown>) => {
        const capturedRevision = get().catalogRevision || undefined;
        set({ busy: true });
        try { await run(capturedRevision); await refresh(); }
        catch (error) {
            // A stale tab must not silently update a newer Skill version/scope.
            try { await refresh(); } catch { /* preserve original failure */ }
            if(error instanceof Error && "code" in error &&
                error.code === "skill_revision_conflict")
                throw Error("Skills 已在其他标签页发生修改，目录已刷新；请检查后重新操作");
            throw error;
        } finally { set({ busy: false }); }
    };
    return {
        catalog: [], catalogRevision: 0, loaded: false, busy: false,scanResult:null,
        refresh: async () => {
            if (!loading) loading = refresh().finally(() => { loading = null; });
            await loading;
        },
        scan: async () => {
            let result: SkillScanResult | null = null;
            await change(async rev => {result = await scanSkillDirectory(rev ?? get().catalogRevision);});
            set({scanResult:result});
            return result!;
        },
        toggle: (id, enabled) => change(rev => setSkillEnabled(id, enabled, rev)),
        changeVersion: (id, version) => change(rev => activateSkillVersion(id, version, rev)),
        changeScope: (id, scope) => change(rev => setSkillScope(id, scope, rev)),
    };
});
