import {beforeEach,describe,expect,it,vi} from "vitest";
const saved=vi.hoisted(()=>new Map<string,any>());
const templates=vi.hoisted(()=>[
 {id:"t2i",name:"文生图",revision:"a".repeat(64)},
 {id:"i2i",name:"图生图",revision:"b".repeat(64)}
]);
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:vi.fn(async(path:string,method="GET",body?:any)=>{
 if(method==="GET")return {presets:[...saved.values()]};
 if(method==="PUT"){saved.set(body.id,body);return body}
 if(method==="DELETE"){saved.delete(decodeURIComponent(path.split("/").pop()!));return {deleted:true}}
})}));
vi.mock("./template-registry",()=>({
 getComfyTemplate:async(id:string,revision:string)=>templates.find(t=>t.id===id&&t.revision===revision)||null
}));
import {deleteComfyPreset,listComfyPresets,saveComfyPreset,upsertComfyPresetForTemplate} from "./preset-registry";
describe("P4.5 SQLite preset aliases",()=>{
 beforeEach(()=>saved.clear());
 it("no template versions appear as presets unless registered",async()=>{
  expect(await listComfyPresets()).toEqual([]);
  await saveComfyPreset({id:"custom",name:"自定义",templateId:"t2i",revision:"a".repeat(64)});
  expect(await listComfyPresets()).toHaveLength(1);
  await expect(saveComfyPreset({id:"wrong",name:"x",templateId:"missing",revision:"a".repeat(64)}))
   .rejects.toThrow("不存在");
 });
 it("updating a pointer preserves historical versions",async()=>{
  await upsertComfyPresetForTemplate({id:"t2i",name:"初始",revision:"a".repeat(64)});
  await expect(upsertComfyPresetForTemplate({id:"t2i",name:"新",revision:"c".repeat(64)})).rejects.toThrow("不存在");
  await saveComfyPreset({id:"custom",name:"别名",templateId:"i2i",revision:"b".repeat(64)});
  await upsertComfyPresetForTemplate({id:"i2i",name:"更新",revision:"b".repeat(64)});
  expect((await listComfyPresets()).find(x=>x.templateId==="i2i")?.id).toBe("custom");
 });
 it("delete removes pointer only",async()=>{
  await saveComfyPreset({id:"custom",name:"别名",templateId:"t2i",revision:"a".repeat(64)});
  await deleteComfyPreset("custom");
  expect(await listComfyPresets()).toEqual([]);
 });
});
