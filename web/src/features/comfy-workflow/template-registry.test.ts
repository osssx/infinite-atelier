import {beforeEach,describe,expect,it,vi} from "vitest";
import {createComfyTemplate,templatePayloadFromGraph} from "./template-schema";
import {getComfyTemplate,installComfyBackupVersions,installComfyTemplate,listComfyTemplates} from "./template-registry";
const mock=vi.hoisted(()=>({values:new Map<string,any>(),failBatch:false,offline:false}));
vi.mock("@/features/backend-sync/canvas-api",()=>({canvasApi:vi.fn(async(path:string,method="GET",body?:any)=>{
 if(mock.offline)throw Error("backend_unavailable");
 const root="/api/v1/comfy/templates";
 if(method==="GET"&&path===root)return {templates:[...mock.values.values()]};
 if(method==="GET"){
  const [id,rev]=path.slice(root.length+1).split("/");
  const value=mock.values.get(decodeURIComponent(id)+"@"+rev);
  if(!value)throw {code:"comfy_template_not_found",status:404};
  return {template:value};
 }
 if(method==="POST"&&path===root+"/batch"){
  if(mock.failBatch)throw Error("write_failure");
  const results=body.templates.map((x:any)=>({id:x.id,revision:x.revision,
   status:mock.values.has(x.id+"@"+x.revision)?"existing":"installed"}));
  for(const x of body.templates)mock.values.set(x.id+"@"+x.revision,structuredClone(x));
  return {results};
 }
 if(method==="POST"){
  const x=body.template,key=x.id+"@"+x.revision;
  const status=mock.values.has(key)?"existing":"installed";
  mock.values.set(key,structuredClone(x));return {status};
 }
 if(method==="DELETE"){
  const [id,rev]=path.slice(root.length+1).split("/");
  mock.values.delete(decodeURIComponent(id)+"@"+rev);return {deleted:true};
 }
})}));
async function fixture(id:string,seed:number){
 const p=templatePayloadFromGraph("Test",{"1":{class_type:"TestImage",inputs:{seed}}});
 p.ports=[{id:"result",label:"Result",direction:"source",valueKind:"IMAGE",
  outputBinding:{nodeId:"1",outputIndex:0},capture:{kind:"none"}}];
 return createComfyTemplate(id,p);
}
describe("P4.5 immutable backend registry",()=>{
 beforeEach(()=>{mock.values.clear();mock.failBatch=false;mock.offline=false});
 it("immutable SHA and reuse",async()=>{
  const a=await fixture("a",1);
  expect(await installComfyTemplate(a)).toBe("installed");
  expect(await installComfyTemplate(a)).toBe("existing");
  const invalid=structuredClone(a);invalid.apiGraph["1"].inputs.seed=99;
  await expect(installComfyTemplate(invalid)).rejects.toThrow(/SHA-256 mismatch/);
  expect((await getComfyTemplate(a.id,a.revision))?.apiGraph["1"].inputs.seed).toBe(1);
  expect(await listComfyTemplates()).toHaveLength(1);
 });
 it("batch install is atomic",async()=>{
  const a=await fixture("a",1),b=await fixture("b",2);
  mock.failBatch=true;
  await expect(installComfyBackupVersions([a,b])).rejects.toThrow("write_failure");
  expect(mock.values.size).toBe(0);
 });
 it("rollback does not delete preexisting",async()=>{
  const a=await fixture("a",1),b=await fixture("b",2);
  await installComfyTemplate(a);
  const rollback=await installComfyBackupVersions([a,b]);
  await rollback();
  expect(mock.values.size).toBe(1);
 });
 it("offline never falls back to IndexedDB",async()=>{
  mock.offline=true;
  await expect(getComfyTemplate("a","a".repeat(64))).rejects.toThrow("backend_unavailable");
 });
});
