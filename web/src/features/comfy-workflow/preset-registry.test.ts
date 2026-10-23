import {beforeEach,describe,expect,it,vi} from "vitest";
const memory=vi.hoisted(()=>new Map<string,unknown>());
vi.mock("localforage",()=>({default:{createInstance:()=>({
    getItem:async(key:string)=>memory.get(key)??null,
    setItem:async(key:string,value:unknown)=>memory.set(key,structuredClone(value)),
    removeItem:async(key:string)=>memory.delete(key),
    iterate:async(callback:(value:unknown,key:string)=>void)=>{for(const [key,value] of memory)callback(value,key);}
})}}));
const templates=vi.hoisted(()=>[
    {id:"t2i",name:"文生图",revision:"a".repeat(64)},
    {id:"i2i",name:"图生图",revision:"b".repeat(64)}
]);
vi.mock("./template-registry",()=>({
    listComfyTemplates:async()=>templates,
    getComfyTemplate:async(id:string,revision:string)=>templates.find(t=>t.id===id&&t.revision===revision)||null
}));
import {deleteComfyPreset,listComfyPresets,saveComfyPreset,upsertComfyPresetForTemplate} from "./preset-registry";
describe("global Comfy preset version binding",()=>{
    beforeEach(()=>memory.clear());
    it("hides historical template revisions until they are explicitly registered as presets",async()=>{
        expect(await listComfyPresets()).toEqual([]);
        await saveComfyPreset({id:"custom",name:"我自己的文生图",templateId:"t2i",revision:"a".repeat(64)});
        const result=await listComfyPresets();
        expect(result.find(p=>p.id==="custom")?.revision).toBe("a".repeat(64));
        expect(result).toHaveLength(1);
        expect(result.find(p=>p.id==="t2i")).toBeUndefined();
        await expect(saveComfyPreset({id:"bad",name:"bad",templateId:"absent",revision:"x"})).rejects.toThrow(/不存在/);
    });
    it("updates one managed preset alias to the new revision, with no duplicate history",async()=>{
        await upsertComfyPresetForTemplate({id:"t2i",name:"新模板",revision:"a".repeat(64)});
        const previous=await listComfyPresets();
        expect(previous).toHaveLength(1);
        const revised=await upsertComfyPresetForTemplate({id:"t2i",name:"新模板",revision:"c".repeat(64)}).catch(()=>null);
        expect(revised).toBeNull(); // New revision must exist in the immutable registry before publishing.
        expect(await listComfyPresets()).toEqual(previous);
        await saveComfyPreset({id:"custom",name:"自定义别名",templateId:"i2i",revision:"b".repeat(64)});
        await upsertComfyPresetForTemplate({id:"i2i",name:"图生图 v2",revision:"b".repeat(64)});
        const presets=await listComfyPresets();
        expect(presets).toHaveLength(2);
        expect(presets.find(p=>p.templateId==="i2i")?.id).toBe("custom");
    });
    it("removing a preset hides its alias without deleting existing immutable template",async()=>{
        await saveComfyPreset({id:"custom",name:"别名",templateId:"t2i",revision:"a".repeat(64)});
        await deleteComfyPreset("custom");
        expect(await listComfyPresets()).toEqual([]);
        await saveComfyPreset({id:"custom",name:"恢复",templateId:"t2i",revision:"a".repeat(64)});
        expect((await listComfyPresets()).find(p=>p.id==="custom")?.name).toBe("恢复");
    });
});
