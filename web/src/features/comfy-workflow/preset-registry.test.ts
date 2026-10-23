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
import {deleteComfyPreset,listComfyPresets,saveComfyPreset} from "./preset-registry";
describe("global Comfy preset version binding",()=>{
    beforeEach(()=>memory.clear());
    it("discovers already-saved templates; saves explicit alias and revision pointer",async()=>{
        expect((await listComfyPresets()).map(p=>p.id)).toEqual(["i2i","t2i"]);
        await saveComfyPreset({id:"custom",name:"我自己的文生图",templateId:"t2i",revision:"a".repeat(64)});
        const result=await listComfyPresets();
        expect(result.find(p=>p.id==="custom")?.revision).toBe("a".repeat(64));
        expect(result.find(p=>p.id==="t2i")).toBeUndefined();
        await expect(saveComfyPreset({id:"bad",name:"bad",templateId:"absent",revision:"x"})).rejects.toThrow(/不存在/);
    });
    it("removing a preset hides its alias without deleting existing immutable template",async()=>{
        await saveComfyPreset({id:"custom",name:"别名",templateId:"t2i",revision:"a".repeat(64)});
        await deleteComfyPreset("custom");
        expect((await listComfyPresets()).map(p=>p.id)).toEqual(["i2i"]);
        await saveComfyPreset({id:"custom",name:"恢复",templateId:"t2i",revision:"a".repeat(64)});
        expect((await listComfyPresets()).find(p=>p.id==="custom")?.name).toBe("恢复");
    });
});
