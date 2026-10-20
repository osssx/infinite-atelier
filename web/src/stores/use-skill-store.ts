import { create } from "zustand";
import { importSkillFile } from "@/features/skills/skill-import";
import { activateSkillVersion, listSkills, registerSkill, removeSkill, setSkillEnabled, type SkillBackupSnapshot } from "@/features/skills/skill-registry";
import type { SkillCatalogEntry } from "@/features/skills/types";

type SkillStore = {
    catalog: SkillCatalogEntry[];
    loaded: boolean;
    busy: boolean;
    refresh: () => Promise<void>;
    importFile: (file: File) => Promise<void>;
    toggle: (id: string, enabled: boolean) => Promise<void>;
    changeVersion: (id: string, version: string) => Promise<void>;
    remove: (id: string) => Promise<void>;
};
let loading: Promise<void> | null = null;
export const useSkillStore = create<SkillStore>((set, get) => {
    const refresh = async () => {
        const catalog = await listSkills();
        set({ catalog, loaded: true });
    };
    const change = async (run: () => Promise<unknown>) => {
        set({ busy: true });
        try { await run(); await refresh(); }
        finally { set({ busy: false }); }
    };
    return {
        catalog: [], loaded: false, busy: false,
        refresh: async () => {
            if (!loading) loading = refresh().finally(() => { loading = null; });
            await loading;
        },
        importFile: (file) => change(async () => registerSkill(await importSkillFile(file))),
        toggle: (id, enabled) => change(() => setSkillEnabled(id, enabled)),
        changeVersion: (id, version) => change(() => activateSkillVersion(id, version)),
        remove: (id) => change(() => removeSkill(id)),
    };
});
