import { beforeEach, describe, expect, it, vi } from "vitest";
import { KREA2_TURBO_TEMPLATE_ID } from "./krea2-turbo-preset";
import { MINIMAX_H3_I2V_TEMPLATE_ID } from "./minimax-h3-i2v-preset";

const userPresets=vi.hoisted(()=>new Map<string,unknown>());
const storedTemplates=vi.hoisted(()=>new Map<string,unknown>());
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:vi.fn(async(path:string,method="GET",value?:any)=>{
    if(method==="GET")return {presets:[...userPresets.values()]};
    if(method==="PUT"){userPresets.set(value.id,structuredClone(value));return value}
    if(method==="DELETE"){userPresets.delete(decodeURIComponent(path.split("/").pop()!));return {deleted:true}}
})}));
vi.mock("./template-registry",()=>({
    getComfyTemplate:async (id:string,revision:string)=>
        storedTemplates.get(id+"@"+revision)??null,
    installComfyTemplate:async (template:{id:string;revision:string})=>{
        const key=template.id+"@"+template.revision;
        if(!storedTemplates.has(key))storedTemplates.set(key,template);
        return "installed";
    },
}));
import {listComfyPresets,saveComfyPreset} from "./preset-registry";
import {
    bundledKrea2Template, installBundledKrea2Template, listComfyPresetCatalog, resetBundledComfyPreset,
} from "./preset-catalog";

describe("built-in ComfyUI presets in global settings",()=>{
    beforeEach(()=>{userPresets.clear();storedTemplates.clear();});
    it("always lists the built-in template without saving or introducing old template revisions",async()=>{
        const [defaultTemplate]=await Promise.all([bundledKrea2Template()]);
        const all=await listComfyPresetCatalog();
        expect(all).toHaveLength(2);
        expect(all[0]).toMatchObject({
            id:KREA2_TURBO_TEMPLATE_ID,templateId:KREA2_TURBO_TEMPLATE_ID,
            revision:defaultTemplate.revision,builtIn:true,modified:false,
        });
        expect(all[0].defaultRevision).toBe(defaultTemplate.revision);
        expect(all[1]).toMatchObject({id:MINIMAX_H3_I2V_TEMPLATE_ID,builtIn:true,modified:false});
        expect(await listComfyPresets()).toEqual([]);
        expect(storedTemplates.size).toBe(0);
    });
    it("merges an edited built-in alias, and still lists independently saved custom presets",async()=>{
        const defaults=await installBundledKrea2Template();
        const updated={...defaults,name:"Krea 2 Turbo 自定义",revision:"9".repeat(64)};
        storedTemplates.set(updated.id+"@"+updated.revision,updated);
        await saveComfyPreset({id:"krea-custom",name:updated.name,templateId:updated.id,revision:updated.revision});
        const custom={id:"another",name:"My Custom",templateId:"custom-t2i",revision:"8".repeat(64)};
        storedTemplates.set(custom.templateId+"@"+custom.revision,custom);
        await saveComfyPreset(custom);
        const all=await listComfyPresetCatalog();
        expect(all).toHaveLength(3);
        expect(all[0]).toMatchObject({
            id:"krea-custom",templateId:KREA2_TURBO_TEMPLATE_ID,
            name:updated.name,revision:updated.revision,builtIn:true,modified:true,
        });
        expect(all[2]).toMatchObject({id:"another",builtIn:false,modified:false});
    });
    it("keeps a built-in editable and resettable even after importing a different underlying graph",async()=>{
        const replacement={
            id:"comfy-custom-import",name:"Replaced Krea Graph",revision:"6".repeat(64),
        };
        storedTemplates.set(replacement.id+"@"+replacement.revision,replacement);
        await saveComfyPreset({
            id:KREA2_TURBO_TEMPLATE_ID,name:replacement.name,
            templateId:replacement.id,revision:replacement.revision,
        });
        const catalog=await listComfyPresetCatalog();
        expect(catalog).toHaveLength(2);
        expect(catalog[0]).toMatchObject({
            id:KREA2_TURBO_TEMPLATE_ID,builtIn:true,modified:true,
            templateId:replacement.id,revision:replacement.revision,
        });
        const restored=await resetBundledComfyPreset();
        expect(restored.templateId).toBe(KREA2_TURBO_TEMPLATE_ID);
        expect((await listComfyPresetCatalog())[0].modified).toBe(false);
        expect(storedTemplates.get(replacement.id+"@"+replacement.revision)).toEqual(replacement);
    });
    it("edits and resets the new MiniMax built-in without affecting Krea or historical revisions",async()=>{
        const video=await bundledKrea2Template(); // Krea remains unchanged during video updates.
        const current=(await listComfyPresetCatalog())[1];
        expect(current.id).toBe(MINIMAX_H3_I2V_TEMPLATE_ID);
        const saved=await import("./preset-catalog").then(m=>m.installBundledComfyTemplate(MINIMAX_H3_I2V_TEMPLATE_ID));
        expect(saved.ports.some(p=>p.direction==="source"&&p.valueKind==="VIDEO")).toBe(true);
        const changed={...saved,revision:"5".repeat(64),name:"MiniMax 修改"};
        storedTemplates.set(changed.id+"@"+changed.revision,changed);
        await saveComfyPreset({id:MINIMAX_H3_I2V_TEMPLATE_ID,name:changed.name,
            templateId:changed.id,revision:changed.revision});
        const edited=await listComfyPresetCatalog();
        expect(edited[1]).toMatchObject({id:MINIMAX_H3_I2V_TEMPLATE_ID,builtIn:true,modified:true,
            revision:changed.revision});
        const reset=await import("./preset-catalog").then(m=>m.resetBundledComfyPreset(MINIMAX_H3_I2V_TEMPLATE_ID));
        expect(reset.revision).toBe(saved.revision);
        expect((await listComfyPresetCatalog())[1]).toMatchObject({modified:false,revision:saved.revision});
        expect(storedTemplates.has(changed.id+"@"+changed.revision)).toBe(true);
        expect((await listComfyPresetCatalog())[0].revision).toBe(video.revision);
    });
    it("one-click reset restores the exact bundled revision without deleting old versions or bound nodes",async()=>{
        const defaults=await installBundledKrea2Template();
        const changed={...defaults,revision:"7".repeat(64),name:"Edited Krea"};
        storedTemplates.set(changed.id+"@"+changed.revision,changed);
        await saveComfyPreset({id:"custom-krea",name:changed.name,
            templateId:KREA2_TURBO_TEMPLATE_ID,revision:changed.revision});
        const pinnedCanvasBinding={templateId:KREA2_TURBO_TEMPLATE_ID,templateRevision:changed.revision};
        expect((await listComfyPresetCatalog())[0].modified).toBe(true);
        const restored=await resetBundledComfyPreset();
        expect(restored).toMatchObject({
            id:"custom-krea",name:defaults.name,revision:defaults.revision,
        });
        const all=await listComfyPresetCatalog();
        expect(all).toHaveLength(2);
        expect(all[0]).toMatchObject({modified:false,revision:defaults.revision});
        expect(pinnedCanvasBinding.templateRevision).toBe(changed.revision);
        expect(storedTemplates.get(changed.id+"@"+changed.revision)).toEqual(changed);
        expect(storedTemplates.get(defaults.id+"@"+defaults.revision)).toEqual(defaults);
    });
});
