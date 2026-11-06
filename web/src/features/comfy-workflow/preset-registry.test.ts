import {beforeEach,describe,expect,it,vi} from "vitest";
const saved=vi.hoisted(()=>new Map<string,any>());
const templates=vi.hoisted(()=>[
 {id:"t2i",name:"文生图",revision:"a".repeat(64)},
 {id:"i2i",name:"图生图",revision:"b".repeat(64)}
]);
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:vi.fn(async(path:string,method="GET",body?:any)=>{
 if(path.includes("/versions"))return {versions:[{templateId:"same-hash-a",revision:"a".repeat(64),workflowId:"shared",workflowHash:"c".repeat(64),createdAt:1,name:"one",note:"",shortRevision:"aaaaaaaaaa",current:false,references:{count:0}},{templateId:"same-hash-b",revision:"a".repeat(64),workflowId:"shared",workflowHash:"d".repeat(64),createdAt:2,name:"two",note:"",shortRevision:"aaaaaaaaaa",current:true,references:{count:1}}]} as any;
 if(path.endsWith("/references"))return {references:{presets:[],projectNodes:[],tasks:[],defaults:[],count:0}} as any;
 if(path.endsWith("/note")||path.endsWith("/restore")||path.endsWith("delete-batch"))return {ok:true} as any;
 if(method==="GET")return {presets:[...saved.values()]};
 if(method==="PUT"){saved.set(body.id,body);return body}
 if(method==="DELETE"){saved.delete(decodeURIComponent(path.split("/").pop()!));return {deleted:true}}
})}));
vi.mock("./template-registry",()=>({
 getComfyTemplate:async(id:string,revision:string)=>templates.find(t=>t.id===id&&t.revision===revision)||null
}));
import {deleteComfyPreset,getComfyVersionReferences,listComfyPresets,listComfyWorkflowVersions,restoreComfyPresetVersion,saveComfyPreset,upsertComfyPresetForTemplate,setComfyVersionNote} from "./preset-registry";
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
 it("keeps versions with equal hashes distinct by template identity and exposes history actions",async()=>{
  const versions=await listComfyWorkflowVersions("shared");
  expect(versions).toHaveLength(2);expect(versions[0].templateId).not.toBe(versions[1].templateId);
  const current={id:"preset",name:"Name",workflowId:"shared",templateId:"same-hash-b",revision:"a".repeat(64)};
  await setComfyVersionNote("same-hash-a","a".repeat(64),"remark");
  await restoreComfyPresetVersion("preset",versions[0],current);
  expect(await getComfyVersionReferences("same-hash-b","a".repeat(64))).toMatchObject({count:0});
 });
});
