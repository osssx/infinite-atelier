import {beforeEach,describe,expect,it,vi} from "vitest";
import {createComfyTemplate,templatePayloadFromGraph} from "./template-schema";
const data=vi.hoisted(()=>({templates:new Map<string,unknown>(),presets:new Map<string,unknown>(),
 saved:new Map<string,any>(),posted:0}));
vi.mock("localforage",()=>({default:{createInstance:({storeName}:{storeName:string})=>{
 const db=storeName==="comfy_templates"?data.templates:data.presets;
 return {iterate:async(cb:(value:unknown,key:string)=>void)=>{for(const [key,value] of db)cb(value,key)}};
}}}));
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:vi.fn(async(path:string,method="GET",body?:any)=>{
 if(method==="POST"&&path.endsWith("/batch")){
  data.posted++;
  return {results:body.templates.map(()=>({status:"installed"}))};
 }
 throw Error("unexpected endpoint");
})}));
vi.mock("./preset-registry",()=>({
 listComfyPresets:async()=>[...data.saved.values()],
 saveComfyPreset:async(x:any)=>{data.saved.set(x.id,x)}
}));
import {readLegacyComfySnapshot,importLegacyComfySnapshot} from "./legacy-comfy-import";
async function tmpl(){
 const p=templatePayloadFromGraph("Old workflow",{"1":{class_type:"Image",inputs:{seed:4}}});
 p.ports=[{id:"out",label:"Out",direction:"source",valueKind:"IMAGE",
   outputBinding:{nodeId:"1",outputIndex:0},capture:{kind:"none"}}];
 return createComfyTemplate("legacy",p);
}
describe("P4.5 explicit legacy migration",()=>{
 beforeEach(()=>{data.templates.clear();data.presets.clear();data.saved.clear();data.posted=0});
 it("reads only when explicitly invoked and leaves browser stores unchanged",async()=>{
  const value=await tmpl();
  data.templates.set("v1:"+value.id+"@"+value.revision,value);
  data.presets.set("preset:custom",{id:"custom",name:"Old",templateId:value.id,revision:value.revision});
  expect(data.posted).toBe(0);
  const snapshot=await readLegacyComfySnapshot();
  const imported=await importLegacyComfySnapshot(snapshot);
  expect(imported).toEqual({templates:1,presets:1});
  expect(data.templates.size).toBe(1);
  expect(data.presets.size).toBe(1);
 });
 it("rejects preset collisions before batch install, without overwriting",async()=>{
  const value=await tmpl();
  data.templates.set("v1:"+value.id+"@"+value.revision,value);
  data.presets.set("preset:custom",{id:"custom",name:"Old",templateId:value.id,revision:value.revision});
  data.saved.set("custom",{id:"custom",name:"New",templateId:value.id,revision:value.revision});
  const snapshot=await readLegacyComfySnapshot();
  await expect(importLegacyComfySnapshot(snapshot)).rejects.toThrow("冲突");
  expect(data.posted).toBe(0);
  expect(data.saved.get("custom").name).toBe("New");
 });
 it("refuses tampered old template revisions",async()=>{
  const value=await tmpl();
  value.name="edited without revision";
  data.templates.set("v1:"+value.id+"@"+value.revision,value);
  await expect(readLegacyComfySnapshot()).rejects.toThrow("SHA-256 mismatch");
  expect(data.posted).toBe(0);
 });
});
